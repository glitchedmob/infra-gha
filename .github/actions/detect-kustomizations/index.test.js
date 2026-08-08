const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const run = require("./index");
const {
  createWorkflowOutputs,
  detectKustomizations,
  detectRepository,
  discoverKustomizations,
  extractReferences,
  parseRoots,
} = run;

function target(kustomization, references = [], renderable = true) {
  return {
    kustomization,
    file: `${kustomization}/kustomization.yaml`,
    references,
    renderable,
  };
}

test("selects enclosing Kustomizations", () => {
  const result = detectKustomizations({
    headTargets: [target("src/k8s"), target("src/k8s/apps/example")],
    changedPaths: ["src/k8s/apps/example/deployment.yaml"],
  });

  assert.deepEqual(result.kustomizations, ["src/k8s", "src/k8s/apps/example"]);
});

test("selects consumers of a shared Kustomization", () => {
  const result = detectKustomizations({
    headTargets: [
      target("src/k8s/apps/example", [{ path: "src/k8s/shared/base", directory: true }]),
      target("src/k8s/shared/base"),
    ],
    changedPaths: ["src/k8s/shared/base/deployment.yaml"],
  });

  assert.deepEqual(result.kustomizations, ["src/k8s/apps/example", "src/k8s/shared/base"]);
});

test("propagates transitive Kustomization dependencies", () => {
  const result = detectKustomizations({
    headTargets: [
      target("src/k8s/apps", [{ path: "src/k8s/apps/example", directory: true }]),
      target("src/k8s/apps/example", [{ path: "src/k8s/shared/base", directory: true }]),
      target("src/k8s/shared/base", [{ path: "src/k8s/config/settings.yaml", directory: false }]),
    ],
    changedPaths: ["src/k8s/config/settings.yaml"],
  });

  assert.deepEqual(result.kustomizations, ["src/k8s/apps", "src/k8s/apps/example", "src/k8s/shared/base"]);
});

test("propagates dependencies through Kustomizations outside configured roots", () => {
  const result = detectKustomizations({
    headTargets: [
      target("src/k8s/apps/example", [{ path: "src/k8s/shared/base", directory: true }]),
      target("src/k8s/shared/base", [{ path: "src/k8s/config/settings.yaml", directory: false }], false),
    ],
    changedPaths: ["src/k8s/config/settings.yaml"],
  });

  assert.deepEqual(result.kustomizations, ["src/k8s/apps/example"]);
});

test("ignores changes outside discovered Kustomizations", () => {
  const result = detectKustomizations({
    headTargets: [target("src/k8s/apps/example")],
    changedPaths: ["README.md"],
  });

  assert.deepEqual(result.matrix, { include: [] });
});

test("keeps deleted Kustomizations from the base revision", () => {
  const result = detectKustomizations({
    headTargets: [],
    baseTargets: [target("src/k8s/apps/removed")],
    changedPaths: ["src/k8s/apps/removed/kustomization.yaml"],
  });

  assert.deepEqual(result.matrix.include, [
    {
      kustomization: "src/k8s/apps/removed",
      deleted: true,
      changedPaths: ["src/k8s/apps/removed/kustomization.yaml"],
    },
  ]);
});

test("extracts tracked relative file and directory references", () => {
  const files = new Set([
    "src/k8s/apps/example/kustomization.yaml",
    "src/k8s/apps/example/patch.yaml",
    "src/k8s/shared/config.yaml",
    "src/k8s/shared/flow-patch.yaml",
    "src/k8s/shared/base/kustomization.yaml",
  ]);
  const references = extractReferences(
    [
      "resources:",
      "  - ../../shared/base",
      "  - https://example.com/remote.yaml",
      "patches:",
      "  - path: patch.yaml # local patch",
      "configMapGenerator:",
      "  - files: [settings=../../shared/config.yaml]",
      "patches: [{path: ../../shared/flow-patch.yaml}]",
    ].join("\n"),
    "src/k8s/apps/example/kustomization.yaml",
    files,
  );

  assert.deepEqual(references, [
    { path: "src/k8s/shared/base", directory: true },
    { path: "src/k8s/apps/example/patch.yaml", directory: false },
    { path: "src/k8s/shared/config.yaml", directory: false },
    { path: "src/k8s/shared/flow-patch.yaml", directory: false },
  ]);
});

test("parses and validates Kustomization roots", () => {
  assert.deepEqual(parseRoots("src/k8s/apps\nsrc/k8s/platform\nsrc/k8s/apps\n"), [
    "src/k8s/apps",
    "src/k8s/platform",
  ]);
  assert.throws(() => parseRoots("../outside"), /normalized repository-relative/);
  assert.throws(() => parseRoots(""), /at least one/);
});

function git(cwd, arguments_) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeFiles(repository, files) {
  for (const [file, contents] of Object.entries(files)) {
    const targetPath = path.join(repository, file);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents);
  }
}

function commit(repository, message) {
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "--quiet", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function createRepository(context, files) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "detect-kustomizations-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  writeFiles(repository, files);
  return { repository, baseRevision: commit(repository, "base") };
}

test("discovers Kustomizations and shared references from Git", (context) => {
  const { repository, baseRevision } = createRepository(context, {
    "src/k8s/apps/example/kustomization.yaml": "resources:\n  - ../../shared/base\n",
    "src/k8s/shared/base/kustomization.yml": "resources:\n  - deployment.yaml\n",
    "src/k8s/shared/base/deployment.yaml": "kind: Deployment\n",
  });

  const targets = discoverKustomizations(repository, baseRevision, ["src/k8s"]);

  assert.deepEqual(targets.map((item) => item.kustomization), [
    "src/k8s/apps/example",
    "src/k8s/shared/base",
  ]);
  assert.deepEqual(targets[0].references, [{ path: "src/k8s/shared/base", directory: true }]);
});

test("ignores duplicate Kustomization filenames outside configured roots", (context) => {
  const { repository, baseRevision } = createRepository(context, {
    "src/k8s/apps/example/kustomization.yaml": "resources: []\n",
    "examples/duplicate/Kustomization": "resources: []\n",
    "examples/duplicate/kustomization.yaml": "resources: []\n",
  });

  assert.doesNotThrow(() => discoverKustomizations(repository, baseRevision, ["src/k8s/apps"]));
});

test("repository detection maps both sides of a rename", (context) => {
  const { repository, baseRevision } = createRepository(context, {
    "src/k8s/apps/old/kustomization.yaml": "resources:\n  - deployment.yaml\n",
    "src/k8s/apps/old/deployment.yaml": "kind: Deployment\n",
  });
  fs.renameSync(path.join(repository, "src/k8s/apps/old"), path.join(repository, "src/k8s/apps/new"));
  const headRevision = commit(repository, "rename Kustomization");

  const result = detectRepository({ cwd: repository, roots: "src/k8s/apps", baseRevision, headRevision });

  assert.deepEqual(result.kustomizations, ["src/k8s/apps/new", "src/k8s/apps/old"]);
  assert.equal(result.matrix.include.find((item) => item.kustomization.endsWith("/old")).deleted, true);
});

test("repository detection fans out a shared-base change", (context) => {
  const { repository, baseRevision } = createRepository(context, {
    "src/k8s/apps/example/kustomization.yaml": "resources:\n  - ../../shared/base\n",
    "src/k8s/shared/base/kustomization.yaml": "resources:\n  - deployment.yaml\n",
    "src/k8s/shared/base/deployment.yaml": "kind: Deployment\n",
  });
  fs.writeFileSync(path.join(repository, "src/k8s/shared/base/deployment.yaml"), "kind: Deployment\nmetadata: {}\n");
  const headRevision = commit(repository, "change shared base");

  const result = detectRepository({ cwd: repository, roots: "src/k8s", baseRevision, headRevision });

  assert.deepEqual(result.kustomizations, ["src/k8s/apps/example", "src/k8s/shared/base"]);
});

test("action reads revisions and writes workflow outputs", (context) => {
  const { repository, baseRevision } = createRepository(context, {
    "src/k8s/apps/example/kustomization.yaml": "resources:\n  - deployment.yaml\n",
    "src/k8s/apps/example/deployment.yaml": "kind: Deployment\n",
  });
  fs.writeFileSync(path.join(repository, "src/k8s/apps/example/deployment.yaml"), "kind: Deployment\nmetadata: {}\n");
  const headRevision = commit(repository, "change Kustomization");
  const output = path.join(repository, "workflow-output");
  const summary = path.join(repository, "workflow-summary");
  const environment = {
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_WORKSPACE: repository,
    "INPUT_KUSTOMIZATION-ROOTS": "src/k8s/apps",
    "INPUT_BASE-REVISION": baseRevision,
    "INPUT_HEAD-REVISION": headRevision,
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  context.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  run();

  assert.match(fs.readFileSync(output, "utf8"), /kustomizations=\["src\/k8s\/apps\/example"\]/);
  assert.match(fs.readFileSync(output, "utf8"), /has-changes=true/);
  assert.match(fs.readFileSync(summary, "utf8"), /Changed Kustomizations/);
});

test("workflow outputs omit changed paths and enforce a size limit", () => {
  const result = detectKustomizations({
    headTargets: [target("src/k8s/apps/example")],
    changedPaths: ["src/k8s/apps/example/deployment.yaml"],
  });
  assert.equal(createWorkflowOutputs(result).matrix.includes("changedPaths"), false);

  assert.throws(
    () => createWorkflowOutputs({
      kustomizations: ["example"],
      matrix: {
        include: [{ kustomization: "a".repeat(500_000), changedPaths: [] }],
      },
    }),
    /job-output size/,
  );
});
