# infra-gha

Provides reusable GitHub Actions workflows and composite actions used across LZ infrastructure repositories.

## Scope
- Owns: reusable Terraform/OpenTofu and Ansible workflows consumed via `workflow_call`.
- Owns: shared composite actions for setup, connectivity, and artifact handling.
- Owns: release/versioning automation for this workflow library.

## Structure
- `.github/workflows/`: Reusable workflows (`tf-validate`, `tf-plan-apply`, `ansible-lint`, `ansible-run`, `ansible-auto`) and repo CI/release workflows.
- `.github/actions/`: Shared composite actions (`setup-tf`, `setup-ansible`, `headscale-connect`, `encrypt-artifact`).
- `.releaserc.json`: Semantic release configuration for tagged workflow releases.

## Use
- Reference reusable workflows from consumer repos with a pinned tag (for example `@v0.7.1` or major alias).
- Provide required secrets/inputs from the consumer repo (for example AWS role ARN, env content, encryption key).
- Keep workflow versions intentionally pinned to control rollout of pipeline changes.
