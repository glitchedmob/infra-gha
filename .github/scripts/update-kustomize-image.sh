#!/usr/bin/env bash

set -euo pipefail

if [[ ! "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "image-tag is not a valid OCI image tag" >&2
  exit 1
fi
case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *)
    echo "merge-method must be squash, merge, or rebase" >&2
    exit 1
    ;;
esac
case "$KUSTOMIZATION_PATH" in
  ""|/*|..|../*|*/..|*/../*)
    echo "kustomization-path must be a relative path within the deployment repository" >&2
    exit 1
    ;;
esac

target_path=${KUSTOMIZATION_PATH#./}
target_path=${target_path%/}
[ "$target_path" = "." ] && target_path=""
target_directory=${target_path:-.}
if [ ! -d "$target_directory" ]; then
  echo "Kustomization directory does not exist: $KUSTOMIZATION_PATH" >&2
  exit 1
fi

kustomization_file=""
for candidate in kustomization.yaml kustomization.yml Kustomization; do
  if [ -f "$target_directory/$candidate" ]; then
    if [ -n "$kustomization_file" ]; then
      echo "Multiple Kustomization files found in $KUSTOMIZATION_PATH" >&2
      exit 1
    fi
    kustomization_file=$candidate
  fi
done
if [ -z "$kustomization_file" ]; then
  echo "No Kustomization file found in $KUSTOMIZATION_PATH" >&2
  exit 1
fi

(
  cd "$target_directory"
  kustomize edit set image "$IMAGE=*:$IMAGE_TAG"
)

relative_file=${target_path:+$target_path/}$kustomization_file
mapfile -t changed_files < <(git diff --name-only)
if [ "${#changed_files[@]}" -eq 0 ]; then
  echo "Image $IMAGE is already set to $IMAGE_TAG"
  echo "changes-detected=false" >> "$GITHUB_OUTPUT"
  echo "previous-image-tag=$IMAGE_TAG" >> "$GITHUB_OUTPUT"
else
  if [ "${#changed_files[@]}" -ne 1 ] || [ "${changed_files[0]}" != "$relative_file" ]; then
    echo "Kustomize edited unexpected files:" >&2
    printf '  %s\n' "${changed_files[@]}" >&2
    exit 1
  fi

  old_tags=()
  while IFS= read -r line; do
    value=${line#*:}
    read -r value _ <<< "$value"
    value=${value#\"}
    value=${value%\"}
    value=${value#\'}
    value=${value%\'}
    old_tags+=("$value")
  done < <(git diff --unified=0 -- "$relative_file" | while IFS= read -r line; do
    [[ "$line" =~ ^-[[:space:]]*newTag: ]] && printf '%s\n' "$line"
  done)

  if [ "${#old_tags[@]}" -ne 1 ] || [ -z "${old_tags[0]}" ]; then
    echo "Expected exactly one existing images[].newTag for $IMAGE in $relative_file" >&2
    echo "The workflow only updates existing, unambiguous image tag declarations" >&2
    exit 1
  fi

  echo "changes-detected=true" >> "$GITHUB_OUTPUT"
  echo "previous-image-tag=${old_tags[0]}" >> "$GITHUB_OUTPUT"
fi

identifier=${PROMOTION_ID:-${target_path:-root}}
identifier=$(printf '%s' "$identifier" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')
identifier=${identifier#-}
identifier=${identifier%-}
image_name=${IMAGE##*/}
image_name=$(printf '%s' "$image_name" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')
if [ -z "$identifier" ] || [ -z "$image_name" ]; then
  echo "Unable to derive a safe automation branch name" >&2
  exit 1
fi

{
  echo "branch=automation/images/$image_name/${identifier:0:100}"
  echo "kustomization-file=$relative_file"
  echo "promotion-id=$identifier"
} >> "$GITHUB_OUTPUT"
