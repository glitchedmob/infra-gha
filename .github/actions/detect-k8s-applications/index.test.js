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

test("repository detection maps both sides of a rename", (context) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "detect-k8s-applications-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repository, ".github"), { recursive: true });
  fs.mkdirSync(path.join(repository, "src/k8s/apps/example/production"), { recursive: true });
  fs.mkdirSync(path.join(repository, "src/k8s/apps/example/staging"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, ".github/k8s-applications.json"),
    `${JSON.stringify({ version: 1, managedPaths: ["src/k8s"], applications }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repository, "src/k8s/apps/example/production/configmap.yaml"), "value: old\n");
  fs.writeFileSync(path.join(repository, "src/k8s/apps/example/staging/.gitkeep"), "");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]);

  fs.renameSync(
    path.join(repository, "src/k8s/apps/example/production/configmap.yaml"),
    path.join(repository, "src/k8s/apps/example/staging/configmap.yaml"),
  );
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "--quiet", "-m", "rename"]);
  const headRevision = git(repository, ["rev-parse", "HEAD"]);

  const result = detectRepository({
    cwd: repository,
    configPath: ".github/k8s-applications.json",
    baseRevision,
    headRevision,
  });
  assert.deepEqual(result.applications, ["example-production", "example-staging"]);
});

test("repository detection rejects removing checks for an existing Kustomization", (context) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "detect-k8s-applications-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repository, ".github"), { recursive: true });
  fs.mkdirSync(path.join(repository, "src/k8s/apps/example/production"), { recursive: true });
  fs.mkdirSync(path.join(repository, "src/k8s/apps/example/staging"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, ".github/k8s-applications.json"),
    `${JSON.stringify({ version: 1, managedPaths: ["src/k8s"], applications }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repository, "src/k8s/apps/example/production/kustomization.yaml"), "resources: []\n");
  fs.writeFileSync(path.join(repository, "src/k8s/apps/example/staging/kustomization.yaml"), "resources: []\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(
    path.join(repository, ".github/k8s-applications.json"),
    `${JSON.stringify({ version: 1, managedPaths: ["src/k8s"], applications: [applications[0]] }, null, 2)}\n`,
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "remove inventory entry"]);
  const headRevision = git(repository, ["rev-parse", "HEAD"]);

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
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "--quiet", "-m", "delete Kustomization"]);
  const deletionRevision = git(repository, ["rev-parse", "HEAD"]);
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
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "detect-k8s-applications-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repository, ".github"), { recursive: true });
  fs.mkdirSync(path.join(repository, "src/k8s/apps/example/production"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, ".github/k8s-applications.json"),
    `${JSON.stringify({ version: 1, managedPaths: ["src/k8s"], applications: [applications[0]] }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repository, "src/k8s/apps/example/production/kustomization.yaml"), "resources: []\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]);

  const renamedApplication = { ...applications[0], name: "renamed-production" };
  fs.writeFileSync(
    path.join(repository, ".github/k8s-applications.json"),
    `${JSON.stringify({ version: 1, managedPaths: ["src/k8s"], applications: [renamedApplication] }, null, 2)}\n`,
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "rename application"]);
  const headRevision = git(repository, ["rev-parse", "HEAD"]);

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
