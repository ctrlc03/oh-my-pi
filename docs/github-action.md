# Run omp from GitHub

The composite action in [`.github/actions/omp`](../.github/actions/omp/action.yml) runs omp in GitHub Actions when someone mentions `@omp` in an issue comment, a pull request comment, or a pull request review comment. The comment becomes the prompt. The agent runs headlessly in the checked-out repository (`omp -p --mode json`), its final answer is posted back on the thread, and if it changed files they are pushed:

- On a pull request from the same repository, as a commit on the PR branch.
- On an issue, as a new branch (`omp/issue-<number>-<run id>`) with a pull request opened against the default branch.

Nothing in this repository runs it: no workflow under `.github/workflows/` uses the action. You add a workflow to the repository where you want it, using the example below.

## Setup

1. **Provider key.** Add the API key for your model provider as a repository (or environment) secret, for example `ANTHROPIC_API_KEY`. Provider variables are listed in [environment variables](./environment-variables.md). The action never reads a secret itself; you pass it to the action step with `env:`.
2. **Allow Actions to open pull requests.** For issue requests that produce a pull request, enable *Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests* (an organization setting may override it). Without it the push succeeds, the PR creation fails, and the reply says so.
3. **Add the workflow** below as `.github/workflows/omp.yml`. Replace `OWNER/oh-my-pi@REF` with the repository that holds the action and a ref of it. Pin a full commit SHA: the action receives your provider key.

## Example workflow

```yaml
name: omp

on:
   issue_comment:
      types: [created]
   pull_request_review_comment:
      types: [created]

# Least privilege for the job's token. contents: write pushes branches;
# pull-requests: write opens PRs and comments on them; issues: write comments on issues.
permissions:
   contents: write
   pull-requests: write
   issues: write

jobs:
   omp:
      # Only collaborators; the action checks author_association again.
      # (author_association is a property of the comment, so this is not spoofable by the issue text.)
      if: >-
         contains(github.event.comment.body, '@omp') &&
         github.event.comment.user.type != 'Bot' &&
         contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
      runs-on: ubuntu-latest
      timeout-minutes: 45
      # One run at a time per issue / PR; later requests queue instead of cancelling.
      # Job-level so that comments which do not mention @omp never occupy the group.
      concurrency:
         group: omp-${{ github.event.issue.number || github.event.pull_request.number }}
         cancel-in-progress: false
      steps:
         - uses: actions/checkout@v4
           with:
              fetch-depth: 0
              # Keeps the token out of .git/config, where the agent could read it.
              persist-credentials: false

         - uses: OWNER/oh-my-pi/.github/actions/omp@REF
           env:
              ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
           with:
              model: anthropic/claude-sonnet-4-5
              max-cost: "2.50"
              max-time: 20m
              approval-mode: write
```

Every comment is a workflow run; the job is skipped (and costs nothing) unless the `if:` passes. The action then re-checks the event: it must be a newly created comment, from a non-bot author whose `author_association` is in `allowed-associations`, mentioning the trigger phrase as a whole word (`@omp`, not `@ompx`).

## What a run does

1. **Parse event** (`prepare.sh`). Reads `$GITHUB_EVENT_PATH` for `issue_comment` or `pull_request_review_comment`, applies the checks above, and, for a pull request, checks out its head branch (same repository) or `refs/pull/<n>/head` (fork, only with `allow-fork-prs`). It writes the prompt: the comment as the request, the issue or PR title and body (and the file, line and diff hunk for a review comment) as context.
2. **Install omp** (`install.sh`). `bun install -g @oh-my-pi/pi-coding-agent@<omp-version>` by default; with `omp-source: owner/repo@ref` it clones that fork ref and runs `bun setup`, which builds the native addon from source (the Rust toolchain on GitHub-hosted runners is enough, but expect minutes, not seconds).
3. **Run omp** (`run.sh`). `omp -p --mode json --no-session --no-title --approval-mode <mode> --max-time <time>`, plus `--model`, `--thinking`, `--max-cost`, `--tools` and `--no-extensions` when set, with the prompt on stdin. The workflow token is removed from the agent's environment. The answer is the text of the last assistant message in the JSON event stream; the cost is the sum of the per-message costs in it.
4. **Publish** (`publish.sh`). Posts the answer as a comment (with a link to the run and the approximate cost), then pushes and opens a PR as described above. The workspace's `.git` is never read: the working tree is staged on top of the commit omp started from in a private repository (see [The workflow token](#safety-and-cost)), so changes are published as a single commit and any commits the agent made itself are folded into it. A submodule or embedded git repository change fails the step instead. If omp failed or hit its spend cap, a short failure comment is posted and **nothing is pushed**; the step then exits nonzero so the job fails.

A push made with the workflow token does not trigger other workflows (GitHub's rule against recursive runs). If your CI must run on the commits omp makes, supply a personal access token or GitHub App token as `github-token`.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `trigger-phrase` | `@omp` | Mention that triggers a run. |
| `allowed-associations` | `OWNER,MEMBER,COLLABORATOR` | `author_association` values allowed to trigger a run. |
| `model` | _(empty)_ | `--model`. Empty uses the configured default. |
| `thinking` | _(empty)_ | `--thinking` level. |
| `max-cost` | _(empty)_ | `--max-cost` in USD (see [CLI reference](./cli-reference.md)). Empty means no cap. A run that reaches the cap exits with code 3 and publishes nothing. Requires an omp version that has the flag. |
| `max-time` | `30m` | `--max-time`: seconds or `20m` / `1h`. |
| `approval-mode` | `write` | `--approval-mode`: `always-ask`, `write` or `yolo`. See below. |
| `tools` | _(empty)_ | `--tools` allowlist, for example `read,grep,find,edit,write`. Empty keeps the default tool set. |
| `project-extensions` | `false` | Load extensions found in the checked-out repository. Without it the run passes `--no-extensions`. |
| `allow-fork-prs` | `false` | Run on pull requests whose head is in a fork. Changes are never pushed to the fork. |
| `create-pr` | `true` | Publish changes. When `false`, only the reply is posted and changes are discarded with the runner. |
| `branch-prefix` | `omp/` | Prefix of branches created for issue requests. |
| `git-user-name`, `git-user-email` | `github-actions[bot]` | Commit author. |
| `omp-version` | `latest` | npm version or dist-tag to install. |
| `omp-source` | _(empty)_ | `owner/repo@branch-or-tag` of a public fork to build from source instead of using npm. |
| `github-token` | `github.token` | Token for the thread, comments, pushes and PRs. Never exposed to the agent. |

Outputs: `exit-code`, `events-file` (the JSON event stream; upload it with `actions/upload-artifact` if you want the transcript), `answer-file`, `pull-request-url`.

### Approval mode and tools

The run is non-interactive: a tool call that would prompt is denied (see [approval mode](./approval-mode.md)).

| `approval-mode` | The agent can | Notes |
| --- | --- | --- |
| `always-ask` | Read only | Edits and shell commands are denied. For questions and reviews. |
| `write` (default) | Read, edit and write files | Shell commands, browser and other `exec` tools are denied, so the agent cannot run tests or builds. |
| `yolo` | Everything, including arbitrary shell commands | The action logs a warning. Use only on an isolated runner with a minimal-scope token and no valuable secrets. |

omp's own default is `yolo`; the action deliberately defaults to `write`. Narrow further with `tools` or [`tools.approval` policies](./approval-mode.md#user-overrides) in repository settings.

## Safety and cost

Treat this as giving every listed collaborator a way to spend your money and run an LLM with write access to your repository. Read this before enabling it.

- **Prompt injection.** The agent reads issue and PR text, file contents, and any web pages or command output it fetches. Any of that can contain instructions. The prompt tells the model to treat title and body as data, but this is mitigation, not a guarantee. The real controls are the approval mode, the `tools` allowlist, and the token's permissions: assume the agent can do anything those allow, to any file in the checkout, if a hostile text reaches it. Do not enable `yolo` on repositories where untrusted people can get text in front of the agent (for example a PR from a contributor, reviewed by a maintainer who then comments `@omp`).
- **Who can trigger it.** Gate on `author_association` as shown. `CONTRIBUTOR` and `NONE` can comment on any public repository's issues; never include them. The action also refuses bot authors, which prevents loops where a reply that quotes `@omp` re-triggers a run.
- **Secrets exposure.** The provider key is in the agent's environment by necessity, and anything that can read the environment (under `yolo`, a shell command) can leak it into a comment, a commit or a PR. The workflow token is kept out of the agent's environment and, with `persist-credentials: false`, out of `.git/config`. Do not put other secrets in the job. Use a dedicated, spend-limited provider key.
- **Repository content is trusted code.** The agent loads project inputs from the checkout, such as `AGENTS.md`, skills, rules, hooks and MCP servers ([project inputs and trust](../README.md#project-inputs-and-trust)). Extensions are skipped unless `project-extensions: true`. Because a PR can change those files, run the action on a branch you have reviewed rather than on arbitrary PR heads wherever you can.
- **Fork pull requests.** By default the action replies that it does not run on fork PRs. `allow-fork-prs: true` lets the agent read untrusted code with your secrets present; it is only sensible with `approval-mode: always-ask` or with no secrets beyond a throwaway key. Note also that `pull_request_review_comment` events for forks arrive without secrets and with a read-only token, so only `issue_comment` can work for them.
- **Never use `pull_request_target` (or `workflow_run` chained from untrusted `pull_request`) to run this.** Those events run with secrets and a write token in the context of the base repository; checking out and running the PR head there (which this action does for a PR comment) hands the attacker's code your secrets. The `issue_comment` and `pull_request_review_comment` triggers in the example are safe only because of the author gate; keep that gate.
- **The workflow token.** `permissions:` in the example grants write access to contents, issues and pull requests, not more. The action pushes to the workflow's own repository and not to whatever `origin` is configured to. The agent can write `.git/config`, `.git/info/attributes` and `.gitattributes`, and git runs the commands those name (`filter.*.clean`, `diff.*.textconv`, `core.sshCommand`, `core.askPass`, `core.fsmonitor`, hooks, config includes, aliases); running git in that repository with the token in the environment would hand the token and the provider key to the agent. So `publish.sh` never runs git against the workspace's `.git`. It creates a private repository outside the workspace, fetches the commit omp started from with the token, stages the workspace files into it (the workspace is only a work tree), commits and pushes from there. Its configuration is written by the script; system and global git config are disabled (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), `core.hooksPath` and `core.fsmonitor` are off, and no filter or textconv driver is defined, so a `filter=x` in an agent-written `.gitattributes` names nothing. `gh` is then run from outside any repository. Consequences: Git LFS filters are not applied (files are committed as they are in the workspace), and submodules or embedded repositories are refused. A hostile agent with a shell can still tamper with the working tree itself, which is why `write` is the default mode; steps you add after the action in the same job still run against the agent-modified workspace.
- **Same-repo PRs are pushed to directly.** The commit lands on the PR author's branch without a review step. Use `create-pr: false` to get replies only, or restrict `allowed-associations`.
- **Cost.** A run is bounded by `max-time`, optionally `max-cost`, and the job's `timeout-minutes`; set all three. The cost in the reply footer is the sum of per-message costs from the event stream and may omit subagent spend. Use one concurrency group per thread, as in the example, so a flurry of comments does not run in parallel. GitHub-hosted runner minutes are billed separately from model spend.
- **Privacy.** The issue or PR text, the files the agent reads, and tool output are sent to your model provider.

## Local dry run

The scripts only need `bash`, `jq`, `git` and, for publishing, `gh`. To exercise them without GitHub, export the variables listed at the top of each script, point `GITHUB_EVENT_PATH` at a saved event payload, put stub `gh` and `omp` executables first on `PATH`, set `OMP_BIN` to the stub, and use a `file://` directory of bare repositories as `GITHUB_SERVER_URL`.
