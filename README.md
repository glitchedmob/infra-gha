# infra-gha

Reusable GitHub Actions workflows and composite actions for glitchedmob infrastructure.

## Workflows

| Workflow | Purpose |
|----------|---------|
| `tf-validate.yml` | Validate and format check Terraform |
| `tf-plan-apply.yml` | Plan and optionally apply Terraform |
| `ansible-lint.yml` | Lint Ansible playbooks |
| `ansible-run.yml` | Run Ansible playbook |

## Actions

| Action | Purpose |
|--------|---------|
| `setup-tf` | Install and cache OpenTofu |
| `setup-ansible` | Install and cache Ansible via uv |
| `encrypt-artifact` | Encrypt output artifacts |

**Note:** Environment setup (`.envrc`) is handled by consumer repos via local `setup-env` actions.

## Usage

Reference from other repos. Consumer repos handle their own change detection:

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

## Versioning

- Use tagged releases: `@v1`, `@v1.0.0`
- Breaking changes bump major version
- Each org has their own infra-gha repo
