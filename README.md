# infra-gha

Reusable GitHub Actions workflows and composite actions for glitchedmob infrastructure.

## Scope

- **Reusable workflows (`.github/workflows/`)**: shared CI/CD workflows consumed by infrastructure repos.
- **Composite actions (`.github/actions/`)**: shared setup and artifact utility actions.

## Workflows

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Top-level CI orchestration |
| `release.yml` | Tagged release automation |
| `dependabot-tf-lock.yml` | Terraform lockfile maintenance |
| `tf-validate.yml` | Validate and format check Terraform |
| `tf-plan-apply.yml` | Plan and optionally apply Terraform |
| `ansible-lint.yml` | Lint Ansible playbooks |
| `ansible-run.yml` | Run Ansible playbook |
| `ansible-auto.yml` | Automated Ansible execution workflow |

## Actions

| Action | Purpose |
|--------|---------|
| `setup-tf` | Install and cache OpenTofu |
| `setup-ansible` | Install and cache Ansible via uv |
| `encrypt-artifact` | Encrypt output artifacts |
| `headscale-connect` | Optional Headscale session bootstrap |

**Note:** Environment setup (`.envrc`) is handled by consumer repos via local `setup-env` actions.

## Usage

Reference these workflows from consumer repositories. Consumer repos handle their own change detection:

```yaml
# Consumer repo: .github/workflows/ci-pr.yml
jobs:
  detect:
    outputs:
      tf: ${{ steps.tf.outputs.any_changed }}
    steps:
      - uses: tj-actions/changed-files@v47
        id: tf
        with:
          files: tf/**

  validate:
    needs: detect
    if: ${{ needs.detect.outputs.tf == 'true' }}
    uses: glitchedmob/infra-gha/.github/workflows/tf-validate.yml@v1
    with:
      working-directory: tf
    secrets:
      aws_role_arn: ${{ secrets.AWS_GHA_TERRAFORM_ROLE_ARN }}
```

## Optional Headscale Connectivity

Reusable workflows can optionally join Headscale before Terraform/Ansible work. Connectivity is enabled automatically when:

- `headscale-login-server` is set, and
- `secrets.headscale_auth_key` is set.

Reusable workflows call the shared composite action at `./.github/actions/headscale-connect`, which validates inputs, uses the auth key secret, connects, and prints `tailscale status`.

```yaml
jobs:
  plan:
    uses: glitchedmob/infra-gha/.github/workflows/tf-plan-apply.yml@main
    with:
      plan-only: true
      headscale-login-server: https://headscale.example.com
    secrets:
      headscale_auth_key: ${{ secrets.HEADSCALE_AUTH_KEY }}
      aws_role_arn: ${{ secrets.AWS_GHA_TERRAFORM_ROLE_ARN }}
      output_encryption_key: ${{ secrets.OUTPUT_ENCRYPTION_KEY }}

  ansible:
    uses: glitchedmob/infra-gha/.github/workflows/ansible-run.yml@main
    with:
      working-directory: src/ansible
      playbook: bootstrap.yml
      headscale-login-server: https://headscale.example.com
    secrets:
      headscale_auth_key: ${{ secrets.HEADSCALE_AUTH_KEY }}
      aws_role_arn: ${{ secrets.AWS_GHA_TERRAFORM_ROLE_ARN }}
```

## Versioning

- Use tagged releases: `@v1`, `@v1.0.0`
- Breaking changes bump major version
- Each org has their own infra-gha repo
