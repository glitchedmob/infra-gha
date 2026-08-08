const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const KUSTOMIZATION_FILES = new Set(["Kustomization", "kustomization.yaml", "kustomization.yml"]);

function isWithin(candidate, prefix) {
  return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function runGit(arguments_, cwd) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function validateRevision(revision, label) {
  if (!revision) throw new Error(`${label} revision is required`);
  if (revision.startsWith("-")) throw new Error(`${label} revision must not start with a hyphen`);
}

function parseRoots(value) {
  const roots = [...new Set((value || "").split(/\r?\n/).map((root) => root.trim()).filter(Boolean))];
  if (roots.length === 0) throw new Error("at least one Kustomization root is required");
  for (const root of roots) {
    const normalized = path.posix.normalize(root.replace(/\/+$/, ""));
    if (
      root.startsWith("-") ||
      root.includes("\\") ||
      root.includes("\0") ||
      path.posix.isAbsolute(root) ||
      normalized !== root ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error(`Kustomization root must be a normalized repository-relative POSIX path: ${root}`);
    }
  }
  return roots;
}

function getChangedPaths(cwd, baseRevision, headRevision) {
  const mergeBase = runGit(["merge-base", baseRevision, headRevision], cwd).trim();
  if (!mergeBase) throw new Error(`no merge base found for ${baseRevision} and ${headRevision}`);
  const output = runGit(["diff", "--name-status", "-z", "--find-renames", mergeBase, headRevision, "--"], cwd);
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
  return { mergeBase, changedPaths: [...new Set(changedPaths)].sort() };
}

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? null : quote || character;
    } else if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function splitFlow(value) {
  const values = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? null : quote || character;
    } else if (quote === null && (character === "[" || character === "{")) {
      depth += 1;
    } else if (quote === null && (character === "]" || character === "}")) {
      depth -= 1;
    } else if (quote === null && depth === 0 && character === ",") {
      values.push(value.slice(start, index));
      start = index + 1;
    }
  }
  values.push(value.slice(start));
  return values;
}

function scalarValues(line) {
  let value = line.trim();
  if (!value || value.startsWith("#") || value === "---") return [];
  if (value.startsWith("- ")) value = value.slice(2).trim();

  const property = value.match(/^[A-Za-z][A-Za-z0-9_-]*:\s*(.*)$/);
  if (property) value = property[1];
  value = stripComment(value);
  if (!value || value === "|" || value === ">") return [];
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return splitFlow(value.slice(1, -1)).flatMap((item) => scalarValues(item));
  }
  return [value];
}

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    if (value[0] === '"') {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function extractReferences(content, kustomization, files) {
  const directory = path.posix.dirname(kustomization);
  const references = new Map();
  for (const line of content.split(/\r?\n/)) {
    for (const scalar of scalarValues(line)) {
      let value = unquote(scalar).replace(/^[&!][^\s]+\s+/, "");
      const assignment = value.match(/^[^/=]+=(.+)$/);
      if (assignment) value = assignment[1];
      if (
        !value ||
        value.startsWith("-") ||
        value.startsWith("/") ||
        value.includes("://") ||
        value.includes("{{") ||
        value.includes("$(")
      ) {
        continue;
      }

      const resolved = path.posix.normalize(path.posix.join(directory, value));
      if (resolved === ".." || resolved.startsWith("../")) continue;
      if (files.has(resolved)) {
        references.set(`file:${resolved}`, { path: resolved, directory: false });
      } else if ([...files].some((file) => isWithin(file, resolved))) {
        references.set(`directory:${resolved}`, { path: resolved, directory: true });
      }
    }
  }
  return [...references.values()];
}

function discoverKustomizations(cwd, revision, roots) {
  const files = new Set(runGit(["ls-tree", "-r", "-z", "--name-only", revision, "--"], cwd).split("\0").filter(Boolean));
  const targets = new Map();
  for (const kustomization of files) {
    if (!KUSTOMIZATION_FILES.has(path.posix.basename(kustomization))) continue;
    const directory = path.posix.dirname(kustomization);
    if (targets.has(directory)) {
      if (roots.some((root) => isWithin(directory, root))) {
        throw new Error(`multiple Kustomization files found in ${directory}`);
      }
      continue;
    }
    const content = runGit(["show", `${revision}:${kustomization}`], cwd);
    targets.set(directory, {
      kustomization: directory,
      file: kustomization,
      renderable: roots.some((root) => isWithin(directory, root)),
      references: extractReferences(content, kustomization, files),
    });
  }
  return [...targets.values()].sort((left, right) => left.kustomization.localeCompare(right.kustomization));
}

function mergeTargets(headTargets, baseTargets) {
  const targets = new Map(
    baseTargets.map((target) => [target.kustomization, { ...target, deleted: true }]),
  );
  for (const target of headTargets) {
    const previous = targets.get(target.kustomization);
    const references = new Map(
      [...(previous?.references ?? []), ...target.references].map((reference) => [
        `${reference.directory}:${reference.path}`,
        reference,
      ]),
    );
    targets.set(target.kustomization, { ...target, references: [...references.values()], deleted: false });
  }
  return [...targets.values()];
}

function referenceContains(reference, changedPath) {
  return reference.directory ? isWithin(changedPath, reference.path) : changedPath === reference.path;
}

function referenceTargets(reference, target) {
  return reference.directory
    ? reference.path === target.kustomization
    : reference.path === target.file;
}

function detectKustomizations({ headTargets, baseTargets = [], changedPaths }) {
  const targets = mergeTargets(headTargets, baseTargets);
  const uniqueChangedPaths = [...new Set(changedPaths)].sort();
  const reasons = new Map();

  for (const target of targets) {
    const targetReasons = uniqueChangedPaths.filter(
      (changedPath) =>
        isWithin(changedPath, target.kustomization) ||
        target.references.some((reference) => referenceContains(reference, changedPath)),
    );
    if (targetReasons.length > 0) reasons.set(target.kustomization, new Set(targetReasons));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const target of targets) {
      const targetReasons = reasons.get(target.kustomization) ?? new Set();
      const previousSize = targetReasons.size;
      for (const dependency of targets) {
        if (dependency.kustomization === target.kustomization) continue;
        if (!reasons.has(dependency.kustomization)) continue;
        if (!target.references.some((reference) => referenceTargets(reference, dependency))) continue;
        for (const reason of reasons.get(dependency.kustomization)) targetReasons.add(reason);
      }
      if (targetReasons.size > previousSize) {
        reasons.set(target.kustomization, targetReasons);
        changed = true;
      }
    }
  }

  const include = targets
    .filter((target) => target.renderable !== false && reasons.has(target.kustomization))
    .sort((left, right) => left.kustomization.localeCompare(right.kustomization))
    .map((target) => ({
      kustomization: target.kustomization,
      deleted: target.deleted,
      changedPaths: [...reasons.get(target.kustomization)].sort(),
    }));
  if (include.length > 256) throw new Error("changed Kustomization matrix exceeds GitHub's 256-job limit");

  return {
    matrix: { include },
    kustomizations: include.map((target) => target.kustomization),
    changedPaths: uniqueChangedPaths,
  };
}

function detectRepository({ cwd, roots, baseRevision, headRevision }) {
  validateRevision(baseRevision, "base");
  validateRevision(headRevision, "head");
  const normalizedRoots = parseRoots(roots);
  const changes = getChangedPaths(cwd, baseRevision, headRevision);
  const baseTargets = discoverKustomizations(cwd, changes.mergeBase, normalizedRoots);
  const headTargets = discoverKustomizations(cwd, headRevision, normalizedRoots);
  for (const root of normalizedRoots) {
    if (![...baseTargets, ...headTargets].some((target) => target.renderable && isWithin(target.kustomization, root))) {
      throw new Error(`Kustomization root contains no Kustomizations: ${root}`);
    }
  }
  return detectKustomizations({ headTargets, baseTargets, changedPaths: changes.changedPaths });
}

function createWorkflowOutputs(result) {
  const matrix = JSON.stringify({
    include: result.matrix.include.map(({ changedPaths, ...target }) => target),
  });
  const kustomizations = JSON.stringify(result.kustomizations);
  if ((matrix.length + kustomizations.length) * 2 > 900_000) {
    throw new Error("changed Kustomization outputs exceed the safe GitHub job-output size");
  }
  return { matrix, kustomizations };
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is not set");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function escapeTableCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function writeSummary(result) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = ["## Changed Kustomizations", ""];
  if (result.kustomizations.length === 0) {
    lines.push("No Kustomizations changed.", "");
  } else {
    lines.push("| Kustomization | Changed paths |", "| --- | --- |");
    for (const target of result.matrix.include) {
      const changedPaths = [
        ...target.changedPaths.slice(0, 20).map((changedPath) => `\`${changedPath}\``),
        ...(target.changedPaths.length > 20 ? [`...and ${target.changedPaths.length - 20} more`] : []),
      ].join("<br>");
      lines.push(
        `| ${target.deleted ? "Deleted: " : ""}\`${escapeTableCell(target.kustomization)}\` | ${escapeTableCell(changedPaths)} |`,
      );
    }
    lines.push("");
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

function run() {
  const result = detectRepository({
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    roots: process.env["INPUT_KUSTOMIZATION-ROOTS"],
    baseRevision: process.env["INPUT_BASE-REVISION"],
    headRevision: process.env["INPUT_HEAD-REVISION"],
  });
  const outputs = createWorkflowOutputs(result);
  writeOutput("matrix", outputs.matrix);
  writeOutput("kustomizations", outputs.kustomizations);
  writeOutput("has-changes", String(result.kustomizations.length > 0));
  writeSummary(result);
}

module.exports = run;
module.exports.createWorkflowOutputs = createWorkflowOutputs;
module.exports.detectKustomizations = detectKustomizations;
module.exports.detectRepository = detectRepository;
module.exports.discoverKustomizations = discoverKustomizations;
module.exports.extractReferences = extractReferences;
module.exports.getChangedPaths = getChangedPaths;
module.exports.parseRoots = parseRoots;

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
