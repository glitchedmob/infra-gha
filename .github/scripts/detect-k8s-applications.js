const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_KEYS = new Set(["version", "managedPaths", "globalPaths", "applications"]);
const APPLICATION_KEYS = new Set(["name", "kustomization", "watch"]);

function normalizeRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new Error(`${label} must be a non-empty string no longer than 1024 characters`);
  }
  if (
    value.startsWith("-") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[*?[\]]/.test(value) ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error(`${label} must be a repository-relative POSIX path`);
  }

  const withoutTrailingSlash = value === "." ? value : value.replace(/\/+$/, "");
  const normalized = path.posix.normalize(withoutTrailingSlash);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must not leave the repository`);
  }
  if (normalized !== withoutTrailingSlash) {
    throw new Error(`${label} must be normalized: ${value}`);
  }
  if (normalized.split("/").some((segment) => segment.length > 255)) {
    throw new Error(`${label} contains a path segment longer than 255 characters`);
  }
  return normalized;
}

function isDnsSubdomain(value) {
  const labelPattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.split(".").every((label) => label.length <= 63 && labelPattern.test(label))
  );
}

function validateKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported property: ${key}`);
  }
}

function parsePathArray(value, label, { required = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${label} must be ${required ? "a non-empty" : "an"} array`);
  }
  return [...new Set(value.map((item, index) => normalizeRepoPath(item, `${label}[${index}]`)))];
}

function parseConfig(value, source = "application inventory") {
  let config;
  try {
    config = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  validateKeys(config, ROOT_KEYS, source);
  if (config.version !== 1) throw new Error(`${source} must set version to 1`);

  const managedPaths = parsePathArray(config.managedPaths, `${source}.managedPaths`, { required: true });
  const globalPaths = parsePathArray(config.globalPaths, `${source}.globalPaths`);
  if (!Array.isArray(config.applications) || config.applications.length === 0) {
    throw new Error(`${source}.applications must be a non-empty array`);
  }
  if (config.applications.length > 256) {
    throw new Error(`${source}.applications must not contain more than 256 applications`);
  }

  const names = new Set();
  const applications = config.applications.map((application, index) => {
    const label = `${source}.applications[${index}]`;
    if (!application || typeof application !== "object" || Array.isArray(application)) {
      throw new Error(`${label} must be an object`);
    }
    validateKeys(application, APPLICATION_KEYS, label);
    if (!isDnsSubdomain(application.name)) {
      throw new Error(`${label}.name must be a valid lowercase Kubernetes resource name`);
    }
    if (names.has(application.name)) throw new Error(`${source} contains duplicate application: ${application.name}`);
    names.add(application.name);

    const kustomization = normalizeRepoPath(application.kustomization, `${label}.kustomization`);
    const watch = parsePathArray(application.watch, `${label}.watch`);
    return {
      name: application.name,
      kustomization,
      watch: [...new Set([kustomization, ...watch])],
    };
  });

  return { version: 1, managedPaths, globalPaths, applications };
}

function emptyConfig() {
  return { version: 1, managedPaths: [], globalPaths: [], applications: [] };
}

function isWithin(candidate, prefix) {
  return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function mergeApplications(headConfig, baseConfig) {
  const applications = new Map();
  for (const application of baseConfig.applications) {
    applications.set(application.name, { ...application, watch: [...application.watch], deleted: true });
  }
  for (const application of headConfig.applications) {
    const previous = applications.get(application.name);
    applications.set(application.name, {
      ...application,
      watch: [...new Set([...(previous?.watch ?? []), ...application.watch])],
      deleted: false,
    });
  }
  return applications;
}

function detectApplications({ headConfig, baseConfig = emptyConfig(), changedPaths, configPath }) {
  const applications = mergeApplications(headConfig, baseConfig);
  const managedPaths = [...new Set([...baseConfig.managedPaths, ...headConfig.managedPaths])];
  const globalPaths = [...new Set([...baseConfig.globalPaths, ...headConfig.globalPaths])];
  const uniqueChangedPaths = [...new Set(changedPaths)].sort();
  const reasons = new Map([...applications.keys()].map((name) => [name, new Set()]));

  const configChanged = uniqueChangedPaths.includes(configPath);
  const globalChanges = uniqueChangedPaths.filter((changedPath) =>
    globalPaths.some((globalPath) => isWithin(changedPath, globalPath)),
  );
  const selectAllReasons = configChanged ? [configPath, ...globalChanges] : globalChanges;

  if (selectAllReasons.length > 0) {
    for (const applicationReasons of reasons.values()) {
      for (const reason of selectAllReasons) applicationReasons.add(reason);
    }
  } else {
    for (const changedPath of uniqueChangedPaths) {
      for (const application of applications.values()) {
        if (application.watch.some((watchPath) => isWithin(changedPath, watchPath))) {
          reasons.get(application.name).add(changedPath);
        }
      }
    }
  }

  const unmappedPaths = uniqueChangedPaths.filter((changedPath) => {
    if (changedPath === configPath) return false;
    if (!managedPaths.some((managedPath) => isWithin(changedPath, managedPath))) return false;
    if (globalPaths.some((globalPath) => isWithin(changedPath, globalPath))) return false;
    return ![...applications.values()].some((application) =>
      application.watch.some((watchPath) => isWithin(changedPath, watchPath)),
    );
  });
  if (unmappedPaths.length > 0) {
    throw new Error(`changed Kubernetes paths are not mapped to an application:\n${unmappedPaths.join("\n")}`);
  }

  const include = [...applications.values()]
    .filter((application) => reasons.get(application.name).size > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((application) => ({
      application: application.name,
      kustomization: application.kustomization,
      deleted: application.deleted,
      changedPaths: [...reasons.get(application.name)].sort(),
    }));
  if (include.length > 256) throw new Error("changed application matrix exceeds GitHub's 256-job limit");

  return {
    matrix: { include },
    applications: include.map((application) => application.application),
    changedPaths: uniqueChangedPaths,
  };
}

function runGit(arguments_, cwd, { allowFailure = false } = {}) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function getChangedPaths(cwd, baseRevision, headRevision) {
  const mergeBase = runGit(["merge-base", baseRevision, headRevision], cwd).stdout.trim();
  if (!mergeBase) throw new Error(`no merge base found for ${baseRevision} and ${headRevision}`);
  const output = runGit(["diff", "--name-status", "-z", "--find-renames", mergeBase, headRevision, "--"], cwd).stdout;
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();

  const changedPaths = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) throw new Error("git diff returned an empty status");
    if (status.startsWith("R") || status.startsWith("C")) {
      if (index + 1 >= tokens.length) throw new Error(`git diff returned an incomplete ${status} record`);
      changedPaths.push(tokens[index++], tokens[index++]);
    } else {
      if (index >= tokens.length) throw new Error(`git diff returned an incomplete ${status} record`);
      changedPaths.push(tokens[index++]);
    }
  }
  return { mergeBase, changedPaths: [...new Set(changedPaths)] };
}

function readConfigAtRevision(cwd, revision, configPath) {
  const object = `${revision}:${configPath}`;
  const exists = runGit(["cat-file", "-e", object], cwd, { allowFailure: true });
  if (exists.status !== 0) return emptyConfig();
  return parseConfig(runGit(["show", object], cwd).stdout, `${configPath} at ${revision}`);
}

function detectRepository({ cwd, configPath, baseRevision, headRevision }) {
  if (!baseRevision) throw new Error("base revision is required");
  if (!headRevision) throw new Error("head revision is required");
  if (baseRevision.startsWith("-") || headRevision.startsWith("-")) {
    throw new Error("Git revisions must not start with a hyphen");
  }
  const normalizedConfigPath = normalizeRepoPath(configPath, "applications-file");
  const headConfigPath = path.join(cwd, ...normalizedConfigPath.split("/"));
  if (!fs.existsSync(headConfigPath)) throw new Error(`applications file does not exist: ${normalizedConfigPath}`);

  const headConfig = parseConfig(fs.readFileSync(headConfigPath, "utf8"), normalizedConfigPath);
  const changes = getChangedPaths(cwd, baseRevision, headRevision);
  const baseConfig = readConfigAtRevision(cwd, changes.mergeBase, normalizedConfigPath);
  const changedPaths = changes.changedPaths;
  const result = detectApplications({ headConfig, baseConfig, changedPaths, configPath: normalizedConfigPath });
  const headKustomizations = new Set(headConfig.applications.map((application) => application.kustomization));
  for (const application of result.matrix.include) {
    const kustomizationPath = path.join(cwd, ...application.kustomization.split("/"));
    if (application.deleted && fs.existsSync(kustomizationPath) && !headKustomizations.has(application.kustomization)) {
      throw new Error(
        `application ${application.application} was removed from the inventory but its Kustomization still exists: ${application.kustomization}`,
      );
    }
  }
  return result;
}

function createWorkflowOutputs(result) {
  const matrix = JSON.stringify({
    include: result.matrix.include.map(({ changedPaths, ...application }) => application),
  });
  const applications = JSON.stringify(result.applications);
  if ((matrix.length + applications.length) * 2 > 900_000) {
    throw new Error("changed application outputs exceed the safe GitHub job-output size");
  }
  return { matrix, applications };
}

async function run({ core }) {
  try {
    const result = detectRepository({
      cwd: process.env.REPOSITORY_PATH || process.env.GITHUB_WORKSPACE || process.cwd(),
      configPath: process.env.APPLICATIONS_FILE,
      baseRevision: process.env.BASE_REVISION,
      headRevision: process.env.HEAD_REVISION,
    });
    const hasChanges = result.applications.length > 0;
    const outputs = createWorkflowOutputs(result);
    core.setOutput("matrix", outputs.matrix);
    core.setOutput("applications", outputs.applications);
    core.setOutput("has-changes", String(hasChanges));

    core.summary.addHeading("Changed Kubernetes applications", 2);
    if (!hasChanges) {
      core.summary.addRaw("No managed applications changed.\n");
    } else {
      core.summary.addTable([
        [
          { data: "Application", header: true },
          { data: "Kustomization", header: true },
          { data: "Changed paths", header: true },
        ],
        ...result.matrix.include.map((application) => [
          application.application,
          application.deleted ? "Deleted" : `\`${application.kustomization}\``,
          [
            ...application.changedPaths.slice(0, 20).map((changedPath) => `\`${changedPath}\``),
            ...(application.changedPaths.length > 20
              ? [`...and ${application.changedPaths.length - 20} more`]
              : []),
          ].join("<br>"),
        ]),
      ]);
    }
    await core.summary.write();
  } catch (error) {
    core.setFailed(error.message);
  }
}

module.exports = run;
module.exports.createWorkflowOutputs = createWorkflowOutputs;
module.exports.detectApplications = detectApplications;
module.exports.detectRepository = detectRepository;
module.exports.emptyConfig = emptyConfig;
module.exports.getChangedPaths = getChangedPaths;
module.exports.parseConfig = parseConfig;
