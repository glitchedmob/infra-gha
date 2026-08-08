# infra-gha

Provides reusable GitHub Actions workflows and composite actions used across infrastructure repositories.

## Scope
- Owns: reusable Terraform/OpenTofu, Ansible, and deployment automation workflows consumed via `workflow_call`.
- Owns: shared composite actions for setup, connectivity, and artifact handling.
- Owns: release/versioning automation for this workflow library.

## Structure
- `.github/workflows/`: Reusable workflows (`tf-validate`, `tf-plan-apply`, `ansible-lint`, `ansible-run`, `ansible-auto`, `kustomize-image-pr`) and repo CI/release workflows.
- `.github/actions/`: Shared composite actions (`setup-tf`, `setup-ansible`, `headscale-connect`, `encrypt-artifact`).
- `.releaserc.json`: Semantic release configuration for tagged workflow releases.

## Use
- Reference reusable workflows from consumer repos with a pinned tag (for example `@v0.7.1` or major alias).
- Provide required secrets/inputs from the consumer repo (for example AWS role ARN, env content, encryption key).
- Keep workflow versions intentionally pinned to control rollout of pipeline changes.

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

The workflow requires the target Kustomization to have exactly one matching existing `newTag`. It does not add missing image declarations or modify image names. `auto-merge` requires auto-merge to be enabled in the deployment repository.
