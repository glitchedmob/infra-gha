const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  createWorkflowOutputs,
  detectApplications,
  detectRepository,
  emptyConfig,
  parseConfig,
  run,
} = require("./index");

function config({ applications, managedPaths = ["src/k8s"], globalPaths = [] }) {
  return parseConfig({ version: 1, managedPaths, globalPaths, applications }, "test inventory");
}

const applications = [
  {
    name: "example-production",
    kustomization: "src/k8s/apps/example/production",
    watch: ["src/k8s/apps/example/base"],
  },
  {
    name: "example-staging",
    kustomization: "src/k8s/apps/example/staging",
    watch: ["src/k8s/apps/example/base"],
  },
];

test("selects one application for an overlay change", () => {
  const result = detectApplications({
    headConfig: config({ applications }),
    changedPaths: ["src/k8s/apps/example/production/deployment-patch.yaml"],
    configPath: ".github/k8s-applications.json",
  });

  assert.deepEqual(result.applications, ["example-production"]);
  assert.deepEqual(result.matrix.include[0].changedPaths, [
    "src/k8s/apps/example/production/deployment-patch.yaml",
  ]);
});

test("selects every consumer of a shared base", () => {
  const result = detectApplications({
    headConfig: config({ applications }),
    changedPaths: ["src/k8s/apps/example/base/deployment.yaml"],
    configPath: ".github/k8s-applications.json",
  });

  assert.deepEqual(result.applications, ["example-production", "example-staging"]);
});

test("selects all applications for global and inventory changes", () => {
  const headConfig = config({ applications, globalPaths: ["src/k8s/bootstrap/projects"] });
  for (const changedPath of ["src/k8s/bootstrap/projects/projects.yaml", ".github/k8s-applications.json"]) {
    const result = detectApplications({
      headConfig,
      changedPaths: [changedPath],
      configPath: ".github/k8s-applications.json",
    });
    assert.deepEqual(result.applications, ["example-production", "example-staging"]);
  }
});

test("ignores changes outside managed paths", () => {
  const result = detectApplications({
    headConfig: config({ applications }),
    changedPaths: ["README.md"],
    configPath: ".github/k8s-applications.json",
  });

  assert.deepEqual(result.matrix, { include: [] });
});

test("fails when a managed path is not mapped", () => {
  assert.throws(
    () =>
      detectApplications({
        headConfig: config({ applications }),
        changedPaths: ["src/k8s/apps/unmapped/deployment.yaml"],
        configPath: ".github/k8s-applications.json",
      }),
    /not mapped to an application.*unmapped/s,
  );
});

test("uses the base inventory for a deleted application", () => {
  const result = detectApplications({
    headConfig: config({ applications: [applications[0]] }),
    baseConfig: config({ applications }),
    changedPaths: ["src/k8s/apps/example/staging/kustomization.yaml"],
    configPath: ".github/k8s-applications.json",
  });

  assert.deepEqual(result.matrix.include, [
    {
      application: "example-staging",
      kustomization: "src/k8s/apps/example/staging",
      deleted: true,
      changedPaths: ["src/k8s/apps/example/staging/kustomization.yaml"],
    },
  ]);
});

test("validates inventory structure and paths", () => {
  assert.throws(() => parseConfig({ version: 2 }, "bad inventory"), /version to 1/);
  assert.throws(
    () => config({ applications: [{ ...applications[0], kustomization: "../outside" }] }),
    /must not leave the repository/,
  );
  assert.throws(
    () => config({ applications: [applications[0], applications[0]] }),
    /duplicate application/,
  );
  assert.throws(
    () => config({ applications: [{ ...applications[0], name: "invalid..name" }] }),
    /valid lowercase Kubernetes resource name/,
  );
  assert.throws(
    () => config({ applications: [{ ...applications[0], watch: ["src/k8s/**"] }] }),
    /repository-relative POSIX path/,
  );
  assert.throws(
    () => config({ applications: [{ ...applications[0], kustomization: "--help" }] }),
    /repository-relative POSIX path/,
  );
  assert.throws(
    () => config({ applications: Array.from({ length: 257 }, (_, index) => ({
      name: `app-${index}`,
      kustomization: `src/k8s/apps/app-${index}`,
    })) }),
    /more than 256 applications/,
  );
  assert.throws(
    () => config({ applications: [{ ...applications[0], kustomization: `src/${"a".repeat(1024)}` }] }),
    /no longer than 1024 characters/,
  );
  assert.deepEqual(emptyConfig().applications, []);
});

function git(cwd, arguments_) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeInventory(repository, inventoryApplications) {
  fs.mkdirSync(path.join(repository, ".github"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, ".github/k8s-applications.json"),
    `${JSON.stringify({ version: 1, managedPaths: ["src/k8s"], applications: inventoryApplications }, null, 2)}\n`,
  );
}

function commit(repository, message) {
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "--quiet", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function createRepository(context, inventoryApplications, files) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "detect-k8s-applications-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  writeInventory(repository, inventoryApplications);
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(repository, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { repository, baseRevision: commit(repository, "base") };
}

test("action reads inputs and writes workflow outputs", (context) => {
  const { repository, baseRevision } = createRepository(context, applications, {
    "src/k8s/apps/example/production/kustomization.yaml": "resources: []\n",
  });
  fs.writeFileSync(
    path.join(repository, "src/k8s/apps/example/production/kustomization.yaml"),
    "resources:\n  - deployment.yaml\n",
  );
  const headRevision = commit(repository, "change production");
  const output = path.join(repository, "workflow-output");
  const summary = path.join(repository, "workflow-summary");
  const environment = {
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_WORKSPACE: repository,
    "INPUT_APPLICATIONS-FILE": ".github/k8s-applications.json",
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

  assert.match(fs.readFileSync(output, "utf8"), /applications=\["example-production"\]/);
  assert.match(fs.readFileSync(output, "utf8"), /has-changes=true/);
  assert.match(fs.readFileSync(summary, "utf8"), /Changed Kubernetes applications/);
});

test("repository detection maps both sides of a rename", (context) => {
  const { repository, baseRevision } = createRepository(context, applications, {
    "src/k8s/apps/example/production/configmap.yaml": "value: old\n",
    "src/k8s/apps/example/staging/.gitkeep": "",
  });

  fs.renameSync(
    path.join(repository, "src/k8s/apps/example/production/configmap.yaml"),
    path.join(repository, "src/k8s/apps/example/staging/configmap.yaml"),
  );
  const headRevision = commit(repository, "rename");

  const result = detectRepository({
    cwd: repository,
    configPath: ".github/k8s-applications.json",
    baseRevision,
    headRevision,
  });
  assert.deepEqual(result.applications, ["example-production", "example-staging"]);
});

test("repository detection rejects removing checks for an existing Kustomization", (context) => {
  const { repository, baseRevision } = createRepository(context, applications, {
    "src/k8s/apps/example/production/kustomization.yaml": "resources: []\n",
    "src/k8s/apps/example/staging/kustomization.yaml": "resources: []\n",
  });

  writeInventory(repository, [applications[0]]);
  const headRevision = commit(repository, "remove inventory entry");

  assert.throws(
    () =>
      detectRepository({
        cwd: repository,
        configPath: ".github/k8s-applications.json",
        baseRevision,
        headRevision,
      }),
    /removed from the inventory but its Kustomization still exists/,
  );

  fs.rmSync(path.join(repository, "src/k8s/apps/example/staging"), { recursive: true });
  const deletionRevision = commit(repository, "delete Kustomization");
  const deletion = detectRepository({
    cwd: repository,
    configPath: ".github/k8s-applications.json",
    baseRevision,
    headRevision: deletionRevision,
  });
  assert.equal(
    deletion.matrix.include.find((application) => application.application === "example-staging").deleted,
    true,
  );
});

test("repository detection permits renaming an application that keeps its Kustomization", (context) => {
  const { repository, baseRevision } = createRepository(context, [applications[0]], {
    "src/k8s/apps/example/production/kustomization.yaml": "resources: []\n",
  });

  const renamedApplication = { ...applications[0], name: "renamed-production" };
  writeInventory(repository, [renamedApplication]);
  const headRevision = commit(repository, "rename application");

  const result = detectRepository({
    cwd: repository,
    configPath: ".github/k8s-applications.json",
    baseRevision,
    headRevision,
  });
  assert.deepEqual(result.applications, ["example-production", "renamed-production"]);
});

test("workflow outputs omit changed paths and enforce a size limit", () => {
  const result = detectApplications({
    headConfig: config({ applications }),
    changedPaths: ["src/k8s/apps/example/base/deployment.yaml"],
    configPath: ".github/k8s-applications.json",
  });
  const outputs = createWorkflowOutputs(result);
  assert.equal(outputs.matrix.includes("changedPaths"), false);

  assert.throws(
    () => createWorkflowOutputs({
      applications: ["example"],
      matrix: {
        include: [{ application: "example", kustomization: "a".repeat(500_000), changedPaths: [] }],
      },
    }),
    /job-output size/,
  );
});
