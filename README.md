# infra-gha

Provides reusable GitHub Actions workflows and composite actions used across infrastructure repositories.

## Scope
- Owns: reusable Terraform/OpenTofu, Ansible, and deployment automation workflows consumed via `workflow_call`.
- Owns: shared composite actions for setup, connectivity, and artifact handling.
- Owns: release/versioning automation for this workflow library.

## Structure
- `.github/workflows/`: Reusable workflows (`tf-validate`, `tf-plan-apply`, `ansible-lint`, `ansible-run`, `ansible-auto`, `k8s-pr-checks`, `kustomize-image-pr`) and repo CI/release workflows.
- `.github/actions/`: Shared composite actions (`setup-tf`, `setup-ansible`, `headscale-connect`, `encrypt-artifact`).
- `.releaserc.json`: Semantic release configuration for tagged workflow releases.

## Use
- Reference reusable workflows from consumer repos with a pinned tag (for example `@v0.7.1` or major alias).
- Provide required secrets/inputs from the consumer repo (for example AWS role ARN, env content, encryption key).
- Keep workflow versions intentionally pinned to control rollout of pipeline changes.

## Kubernetes Pull Request Checks

`k8s-pr-checks.yml` detects applications affected by a pull request and renders each changed Kustomization in a separate matrix job. Consumer repositories provide a JSON inventory that defines the managed Kubernetes paths, application Kustomizations, and shared paths watched by each application.

```json
{
  "version": 1,
  "managedPaths": ["src/k8s/apps"],
  "globalPaths": [],
  "applications": [
    {
      "name": "example-production",
      "kustomization": "src/k8s/apps/example/production",
      "watch": ["src/k8s/apps/example/base"]
    },
    {
      "name": "example-staging",
      "kustomization": "src/k8s/apps/example/staging",
      "watch": ["src/k8s/apps/example/base"]
    }
  ]
}
```

Paths are repository-relative prefixes, not globs. Each `kustomization` is watched implicitly, while `watch` adds shared dependencies such as a base. A changed file beneath `managedPaths` must map to at least one application; otherwise detection fails instead of silently skipping validation. Changes beneath `globalPaths` or to the inventory itself select every application.

The consumer workflow only calls the reusable workflow:

```yaml
name: Kubernetes PR Checks

on:
  pull_request:
    paths:
      - .github/k8s-applications.json
      - src/k8s/**

permissions:
  contents: read

jobs:
  checks:
    uses: glitchedmob/infra-gha/.github/workflows/k8s-pr-checks.yml@v0.9.0
```

The workflow compares the pull request merge base with its head. `base-revision` and `head-revision` inputs are available for non-pull-request callers. Kustomize defaults to `5.8.1` and can be changed with the `kustomize-version` input.

## Kustomize Image Pull Requests

`kustomize-image-pr.yml` updates one existing `images[].newTag` declaration, validates the rendered Kustomization, and creates or updates a pull request in a deployment repository. Each invocation handles one target so callers can define arbitrary Kustomization paths and sequence pull request creation with normal job dependencies.

The workflow uses the caller repository's `GITHUB_TOKEN` to build a changelog from source commits. A GitHub App installation token writes the branch and pull request in the deployment repository. The App requires `Contents: read and write` and `Pull requests: read and write` on that repository.

```yaml
jobs:
  promote-staging:
    uses: glitchedmob/infra-gha/.github/workflows/kustomize-image-pr.yml@v0.8.0
    with:
      deployment-repository: example/infra-k8s-apps
      kustomization-path: src/k8s/apps/example/staging
      image: ghcr.io/example/application
      image-tag: 1.2.3
      source-ref: v1.2.3
      promotion-id: staging
      auto-merge: true
      github-app-id: ${{ vars.INFRA_AUTOMATION_APP_ID }}
    secrets:
      github-app-private-key: ${{ secrets.INFRA_AUTOMATION_APP_PRIVATE_KEY }}

  promote-production:
    needs: promote-staging
    uses: glitchedmob/infra-gha/.github/workflows/kustomize-image-pr.yml@v0.8.0
    with:
      deployment-repository: example/infra-k8s-apps
      kustomization-path: src/k8s/apps/example/production
      image: ghcr.io/example/application
      image-tag: 1.2.3
      source-ref: v1.2.3
      promotion-id: production
      github-app-id: ${{ vars.INFRA_AUTOMATION_APP_ID }}
    secrets:
      github-app-private-key: ${{ secrets.INFRA_AUTOMATION_APP_PRIVATE_KEY }}
```

The workflow requires the target Kustomization to have exactly one matching existing `newTag`. It does not add missing image declarations or modify image names. When `auto-merge` is enabled, the workflow requests auto-merge and falls back to an immediate merge if auto-merge is unavailable. Pull requests are always squash merged.
