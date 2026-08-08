const fs = require("fs");
const path = require("path");

module.exports = async ({ github, core }) => {
  const [owner, repo, extra] = process.env.SOURCE_REPOSITORY.split("/");
  if (!owner || !repo || extra) {
    core.setFailed("source-repository must use owner/repo format");
    return;
  }

  const base = `${process.env.SOURCE_TAG_PREFIX}${process.env.OLD_IMAGE_TAG}`;
  const head = process.env.SOURCE_REF.replace(/^refs\/tags\//, "");
  const compareUrl = `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const lines = [
    `Updates \`${process.env.IMAGE}\` from \`${process.env.OLD_IMAGE_TAG}\` to \`${process.env.IMAGE_TAG}\` in \`${process.env.KUSTOMIZATION_PATH}\`.`,
    "",
    "**Changes**",
    "",
    `[Compare ${base}...${head}](${compareUrl})`,
    "",
  ];

  try {
    const commits = [];
    let status = "";
    for (let page = 1; ; page += 1) {
      const response = await github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
        per_page: 100,
        page,
      });
      status = response.data.status;
      commits.push(...response.data.commits);
      if (response.data.commits.length < 100) break;
      if (page >= 100) throw new Error("comparison exceeds 10,000 commits");
    }

    if (status === "behind" || status === "diverged") {
      lines.push(`> Warning: GitHub reports the release comparison as \`${status}\`.`, "");
    }

    if (commits.length === 0) {
      lines.push("No commits were found between these release refs.");
    } else {
      for (const commit of commits) {
        let pullRequest = null;
        try {
          const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({
            owner,
            repo,
            commit_sha: commit.sha,
            per_page: 100,
          });
          pullRequest =
            response.data
              .filter((pr) => pr.merged_at)
              .sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at))[0] ?? null;
        } catch (error) {
          core.warning(`Unable to find a pull request for ${commit.sha}: ${error.message}`);
        }

        let subject = commit.commit.message.split("\n", 1)[0];
        if (pullRequest) {
          subject = subject.replace(new RegExp(`\\s*\\(#${pullRequest.number}\\)$`), "");
        }
        subject = subject
          .replace(/\[/g, "\\[")
          .replace(/\]/g, "\\]");
        const shortSha = commit.sha.slice(0, 7);
        const commitLink =
          "[`" + shortSha + "`](https://github.com/" + owner + "/" + repo + "/commit/" + commit.sha + ")";
        const prLink = pullRequest ? ` ([#${pullRequest.number}](${pullRequest.html_url}))` : "";
        const author = pullRequest?.user?.login ?? commit.author?.login ?? commit.committer?.login;
        const attribution = author ? ` by @${author}` : "";
        lines.push(`- ${commitLink} ${subject}${prLink}${attribution}`);
      }
    }
  } catch (error) {
    core.warning(`Unable to generate the release changelog: ${error.message}`);
    lines.push(`> Changelog unavailable: ${error.message}`);
  }

  const bodyPath = path.join(process.env.RUNNER_TEMP, "kustomize-image-pr.md");
  fs.writeFileSync(bodyPath, `${lines.join("\n")}\n`);
  core.setOutput("body-path", bodyPath);
};
