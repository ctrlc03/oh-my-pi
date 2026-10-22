# Run omp from GitHub

The composite action in [`.github/actions/omp`](../.github/actions/omp/action.yml) runs omp in GitHub Actions for these triggers:

| Trigger | What it does | Mode |
| --- | --- | --- |
| `issue_comment`, `pull_request_review_comment` | A collaborator mentions `@omp`; the comment is the prompt, the answer is posted back and file changes are pushed (to the PR branch, or to a new branch with a pull request). | [`write`](#approval-mode-and-tools) by default |
| `pull_request` (`pull_request_target` for forks) | [Reviews the pull request](#automatic-pull-request-review): one review with a summary and inline comments, replaced on the next push. | Always read-only |
| `issues` (`opened`) | [Triages the issue](#issue-triage): one comment with suggested labels, a possible duplicate and clarifying questions; labels applied only with `apply-labels: true`. | Always read-only |
| `schedule`, `workflow_dispatch` | [Runs a prompt](#scheduled-and-manual-tasks) from an input and opens a pull request with the result. | `write` by default |

The agent runs headlessly in the checked-out repository (`omp -p --mode json`) and its final answer is posted back. For a mention, if it changed files they are pushed:

- On a pull request from the same repository, as a commit on the PR branch.
- On an issue, as a new branch (`omp/issue-<number>-<run id>`) with a pull request opened against the default branch.

Nothing in this repository runs it: no workflow under `.github/workflows/` uses the action, and any event it does not handle (`push` included) is skipped. You add a workflow to the repository where you want it, using the examples below.

## Setup

1. **Provider key.** Add the API key for your model provider as a repository (or environment) secret, for example `ANTHROPIC_API_KEY`. Provider variables are listed in [environment variables](./environment-variables.md). The action never reads a secret itself; you pass it to the action step with `env:`.
2. **Allow Actions to open pull requests.** For issue requests and scheduled / dispatched tasks that produce a pull request, enable *Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests* (an organization setting may override it). Without it the push succeeds, the PR creation fails, and the reply says so.
3. **Add a workflow** from the sections below as `.github/workflows/omp*.yml`; each trigger has its own example with the least-privilege `permissions:` it needs, and you can use any subset. Replace `OWNER/oh-my-pi@REF` with the repository that holds the action and a ref of it. Pin a full commit SHA: the action receives your provider key.

## Comment mentions

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

## Automatic pull request review

On `pull_request` the action reviews the pull request read-only and posts **one review**: a summary comment plus inline comments on the lines where it found concrete problems. The `review` agent profile's behaviour is used (read-only tools, a prompt asking for findings with file and line instead of edits), and the run is pinned read-only whatever the inputs say: `--approval-mode always-ask`, `--tools read,grep,find,glob,ast_grep`, `--no-extensions`, and a settings overlay (`--config`) that selects the built-in `review` profile, turns off project MCP servers and sets `tools.outsideProject: deny`.

```yaml
name: omp review

on:
   pull_request:
      types: [opened, ready_for_review, synchronize]

permissions:
   contents: read
   pull-requests: write

jobs:
   review:
      # A fork's pull_request run has no secrets and a read-only token, so skip it here
      # (see the pull_request_target variant below).
      if: github.event.pull_request.head.repo.full_name == github.repository
      runs-on: ubuntu-latest
      timeout-minutes: 20
      # A new push replaces the review in flight instead of queueing behind it.
      concurrency:
         group: omp-review-${{ github.event.pull_request.number }}
         cancel-in-progress: true
      steps:
         - uses: actions/checkout@v4
           with:
              persist-credentials: false

         - uses: OWNER/oh-my-pi/.github/actions/omp@REF
           env:
              ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
           with:
              model: anthropic/claude-sonnet-4-5
              max-cost: "1.50"
              max-time: 15m
```

What happens, in order:

1. `prepare.sh` skips the run (a notice in the log, no cost) unless the activity type is in `pr-actions`, the pull request is not a draft, its author is not a bot and its `author_association` is in `pr-associations`. A fork pull request also needs `allow-fork-prs: true` and `pull_request_target` (below). It skips when the head commit already has a review from `bot-login` (a re-run does not pay twice) or when the pull request has moved past the event's head commit (the run for the newer push reviews that one).
2. It checks out the head commit, lists the changed files and patches through the API and writes the prompt: the title and description (marked as the author's words, not instructions) and the diff. The model can read the rest of the checkout.
3. The model's answer is a markdown summary followed by one fenced `json` block, `{"findings": [{"path", "line", "severity", "body"}]}`. `publish-review.sh` keeps a finding as an **inline comment** only if its `path` and `line` are in the pull request's diff (GitHub rejects a whole review over one misplaced comment); the rest, and anything beyond `max-inline-comments`, is listed under "Findings" in the summary. The review is posted with `gh api repos/<owner>/<repo>/pulls/<n>/reviews` as event `COMMENT` on the reviewed commit, with a hidden marker (`<!-- omp-review sha=<head> -->`). If GitHub still rejects it, the review is retried once with every finding in the summary, and as a last resort the summary is posted as a plain comment and the job fails.
4. **No duplicate reviews.** After the new review is posted, the earlier omp reviews of that pull request (found by the marker and by `bot-login` as the author) and their inline comments are collapsed as outdated through the GraphQL `minimizeComment` mutation. A push therefore *replaces* the previous review without deleting anything or losing replies. Failing to collapse is a warning, not a failure.

### Fork pull requests

A `pull_request` run for a fork has no secrets and a read-only token, so it cannot review. To review forks use `pull_request_target`, which has both, with the safeguards described in [Safety and cost](#safety-and-cost): the review is read-only, the job's own checkout is the base branch (the action then checks out the pull request head so the agent can read it, and nothing else runs it), and no skills, rules, MCP servers or extensions from the fork are loaded.

```yaml
name: omp review (forks)

on:
   pull_request_target:
      types: [opened, ready_for_review, synchronize]

permissions:
   contents: read
   pull-requests: write

jobs:
   review:
      runs-on: ubuntu-latest
      timeout-minutes: 20
      concurrency:
         group: omp-review-${{ github.event.pull_request.number }}
         cancel-in-progress: true
      steps:
         # The default checkout of pull_request_target is the BASE branch. Never set
         # `ref:` to the pull request head here, and never build, test or run anything
         # from the pull request in this workflow.
         - uses: actions/checkout@v4
           with:
              persist-credentials: false

         - uses: OWNER/oh-my-pi/.github/actions/omp@REF
           env:
              # A dedicated, spend-limited key: the review is read-only, but the
              # key is in the agent's environment.
              ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_REVIEW }}
           with:
              allow-fork-prs: "true"
              pr-associations: OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR,FIRST_TIME_CONTRIBUTOR,FIRST_TIMER,NONE
              max-cost: "1.00"
              max-time: 10m
```

## Issue triage

On `issues` `opened` the action triages the issue and posts **one comment**. The run is read-only like a review. Before the agent starts, `prepare.sh` fetches the repository's labels and searches the repository's issues for possible duplicates (the whole title, then each of its longest words, through the search API; the search words are reduced to `[a-z0-9]`, so title text cannot add search qualifiers). Both lists go into the prompt. The agent proposes labels, names a duplicate if it is sure, and asks up to three specific clarifying questions when the issue cannot be acted on, then ends its answer with `{"labels": [...], "duplicate_of": <number or null>}`.

What is posted is checked against what existed before the agent ran: a proposed label counts only if it is one of the repository's labels (at most 5), and `duplicate_of` counts only if it was a search candidate; anything else is dropped. The comment ends with `Suggested labels: ...`, or, with `apply-labels: true`, the labels are added through the labels API and it ends with `Labels applied: ...`.

```yaml
name: omp triage

on:
   issues:
      types: [opened]

permissions:
   contents: read
   issues: write

jobs:
   triage:
      runs-on: ubuntu-latest
      timeout-minutes: 10
      steps:
         # Default branch: the agent reads the repository to judge the report.
         - uses: actions/checkout@v4
           with:
              persist-credentials: false

         - uses: OWNER/oh-my-pi/.github/actions/omp@REF
           env:
              ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
           with:
              model: anthropic/claude-sonnet-4-5
              max-cost: "0.50"
              max-time: 8m
              apply-labels: "true"
              # Triage issues from everyone, not only collaborators (see Safety and cost).
              triage-associations: OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR,FIRST_TIME_CONTRIBUTOR,FIRST_TIMER,NONE
```

Without `apply-labels`, `issues: write` is still needed to post the comment.

## Scheduled and manual tasks

`schedule` and `workflow_dispatch` runs execute a prompt and publish the result like an issue request: file changes go to a new branch (`omp/task-<run id>`) and a pull request is opened against the branch the run was on (the default branch for a schedule). The agent's final message is the pull request description; when nothing changed there is no pull request and the message goes to the job summary. These events are started by the workflow file or by someone with write access, so there is no association check and the prompt is a trusted instruction. The approval mode, `tools`, `max-cost` and the other inputs apply as for mentions (default `write`).

The task comes from the `prompt` input; for `workflow_dispatch` an empty `prompt` falls back to the dispatch's own `prompt` input. With neither, the run fails with an error.

```yaml
name: omp weekly maintenance

on:
   schedule:
      - cron: "0 6 * * 1"
   workflow_dispatch:
      inputs:
         prompt:
            description: What omp should do (empty runs the weekly dependency update)
            required: false

permissions:
   contents: write
   pull-requests: write

jobs:
   task:
      runs-on: ubuntu-latest
      timeout-minutes: 45
      steps:
         - uses: actions/checkout@v4
           with:
              persist-credentials: false

         - uses: OWNER/oh-my-pi/.github/actions/omp@REF
           env:
              ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
           with:
              model: anthropic/claude-sonnet-4-5
              max-cost: "3.00"
              max-time: 30m
              prompt: ${{ inputs.prompt || 'Update outdated dependencies in package.json to their latest compatible versions, refresh the lockfile and fix what breaks. Summarize each bump and any breaking change.' }}
              # Updating dependencies needs a shell (installs, tests). yolo auto-approves
              # every command, so keep this job on an isolated runner with no other secrets.
              approval-mode: yolo
```

A scheduled workflow only runs from the default branch, and `${{ inputs.* }}` is empty on a schedule, which is why the example falls back to a fixed prompt. Each run opens its own pull request; close the previous one if you do not want them to pile up. Pull requests opened with the workflow token do not trigger your CI; see the note on `github-token` above.

## What a run does

1. **Parse event** (`prepare.sh`). Reads `$GITHUB_EVENT_PATH` and applies the checks for the event: `issue_comment` and `pull_request_review_comment` (the checks above and, for a pull request, a checkout of its head branch (same repository) or `refs/pull/<n>/head` (fork, only with `allow-fork-prs`)), `pull_request` / `pull_request_target` (review, `prepare-review.sh`), `issues` (triage, `prepare-triage.sh`), `schedule` / `workflow_dispatch` (task, `prepare-task.sh`). Any other event, `push` included, is skipped with a notice. It writes the prompt: for a mention the comment as the request, the issue or PR title and body (and the file, line and diff hunk for a review comment) as context.
2. **Install omp** (`install.sh`). `bun install -g @oh-my-pi/pi-coding-agent@<omp-version>` by default; with `omp-source: owner/repo@ref` it clones that fork ref and runs `bun setup`, which builds the native addon from source (the Rust toolchain on GitHub-hosted runners is enough, but expect minutes, not seconds).
3. **Run omp** (`run.sh`). `omp -p --mode json --no-session --no-title --approval-mode <mode> --max-time <time>`, plus `--model`, `--thinking`, `--max-cost`, `--tools` and `--no-extensions` when set, with the prompt on stdin. Reviews and triage replace the approval mode, tools and extensions with the fixed read-only set described above and add `--config` (a settings overlay written to the work directory); a fork pull request also gets `--no-skills --no-rules`. The workflow token is removed from the agent's environment. The answer is the text of the last assistant message in the JSON event stream; the cost is the sum of the per-message costs in it.
4. **Publish** (`publish.sh`). Posts the answer as a comment (with a link to the run and the approximate cost), then pushes and opens a PR as described above. For a review, `publish-review.sh` posts a pull request review instead and for triage `publish-triage.sh` posts the triage comment (and labels); neither pushes anything. For a scheduled or dispatched task there is no thread, so the answer goes to the job summary. The workspace's `.git` is never read: the working tree is staged on top of the commit omp started from in a private repository (see [The workflow token](#safety-and-cost)), so changes are published as a single commit and any commits the agent made itself are folded into it. A submodule or embedded git repository change fails the step instead. If omp failed or hit its spend cap, a short failure comment is posted and **nothing is pushed**; the step then exits nonzero so the job fails.

A push made with the workflow token does not trigger other workflows (GitHub's rule against recursive runs). If your CI must run on the commits omp makes, supply a personal access token or GitHub App token as `github-token`.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `trigger-phrase` | `@omp` | Mention that triggers a run. |
| `allowed-associations` | `OWNER,MEMBER,COLLABORATOR` | `author_association` values allowed to trigger a run with a comment mention. |
| `model` | _(empty)_ | `--model`. Empty uses the configured default. |
| `thinking` | _(empty)_ | `--thinking` level. |
| `max-cost` | _(empty)_ | `--max-cost` in USD (see [CLI reference](./cli-reference.md)). Empty means no cap. A run that reaches the cap exits with code 3 and publishes nothing. Requires an omp version that has the flag. |
| `max-time` | `30m` | `--max-time`: seconds or `20m` / `1h`. |
| `approval-mode` | `write` | `--approval-mode`: `always-ask`, `write` or `yolo`. See below. |
| `tools` | _(empty)_ | `--tools` allowlist, for example `read,grep,find,edit,write`. Empty keeps the default tool set. |
| `project-extensions` | `false` | Load extensions found in the checked-out repository. Without it the run passes `--no-extensions`. |
| `allow-fork-prs` | `false` | Run on pull requests whose head is in a fork (mentions and automatic reviews). Changes are never pushed to the fork; reviews stay read-only. |
| `create-pr` | `true` | Publish changes. When `false`, only the reply is posted and changes are discarded with the runner. |
| `branch-prefix` | `omp/` | Prefix of branches created for issue requests (`omp/issue-<n>-<run id>`) and tasks (`omp/task-<run id>`). |
| `git-user-name`, `git-user-email` | `github-actions[bot]` | Commit author. |
| `omp-version` | `latest` | npm version or dist-tag to install. |
| `omp-source` | _(empty)_ | `owner/repo@branch-or-tag` of a public fork to build from source instead of using npm. |
| `github-token` | `github.token` | Token for the thread, comments, pushes and PRs. Never exposed to the agent. |
| `prompt` | _(empty)_ | The task for `schedule` and `workflow_dispatch` runs. For a dispatch, empty falls back to the dispatch's own `prompt` input; with neither, the run fails. |
| `pr-actions` | `opened,ready_for_review,synchronize` | `pull_request` activity types that start a review. The workflow's own `types:` must list them too. |
| `pr-associations` | `OWNER,MEMBER,COLLABORATOR` | `author_association` of pull request authors whose pull requests are reviewed. |
| `triage-associations` | `OWNER,MEMBER,COLLABORATOR` | `author_association` of issue authors whose new issues are triaged. |
| `apply-labels` | `false` | Apply the labels triage proposes (only labels that already exist). Otherwise the comment only suggests them. |
| `bot-login` | `github-actions[bot]` | Login that posts reviews, used to recognize earlier omp reviews. Set it when `github-token` is a personal access token or app token. |
| `max-inline-comments` | `20` | Most inline comments in one review; further findings go into the summary. |

Outputs: `exit-code`, `events-file` (the JSON event stream; upload it with `actions/upload-artifact` if you want the transcript), `answer-file`, `pull-request-url` (the pull request opened for an issue request or a scheduled / dispatched run).

### Approval mode and tools

The run is non-interactive: a tool call that would prompt is denied (see [approval mode](./approval-mode.md)). `approval-mode`, `tools` and `project-extensions` apply to mentions and to scheduled / dispatched tasks. Pull request reviews and issue triage always run `always-ask` with the read-only tools `read,grep,find,glob,ast_grep` and ignore all three.

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
- **Repository content is trusted code.** The agent loads project inputs from the checkout, such as `AGENTS.md`, skills, rules, hooks and MCP servers ([project inputs and trust](https://github.com/can1357/oh-my-pi#project-inputs-and-trust)). Extensions are skipped unless `project-extensions: true`. Because a PR can change those files, run the action on a branch you have reviewed rather than on arbitrary PR heads wherever you can.
- **Fork pull requests.** By default the action does not run on fork PRs (a mention gets a reply saying so; an automatic review just skips). `allow-fork-prs: true` lets the agent read untrusted code with your secrets present. For a mention that is only sensible with `approval-mode: always-ask` or with no secrets beyond a throwaway key. An automatic review is always read-only, see below. Note also that `pull_request_review_comment` and `pull_request` events for forks arrive without secrets and with a read-only token, so for forks only `issue_comment` (mentions) and `pull_request_target` (reviews) can work.
- **`pull_request_target` is only for the read-only review.** That event runs with secrets and a write-capable token in the context of the base repository, so the dangerous pattern is checking out the PR head and *running* it (a build, a test, a script, an install) in the same job. Never do that. The action's review mode does not run anything from the PR: the agent has `read`, `grep`, `find`, `glob` and `ast_grep` only, in `always-ask` approval mode with `tools.outsideProject: deny` (it cannot read the runner's environment or files outside the checkout), no extensions, no project MCP servers, and, for a fork, no skills or rules from the PR either. Your workflow must still use the default `actions/checkout` (the base branch; do not set `ref:` to the PR head) and must not run PR code in other steps. Do **not** use `pull_request_target` (or `workflow_run` chained from an untrusted `pull_request`) for mentions, `issues` or tasks: those modes edit files and run with approval modes that can be looser. The `issue_comment` and `pull_request_review_comment` triggers are safe only because of the author gate; keep that gate.
- **Review and triage cannot be steered into writing.** For `pull_request`, `pull_request_target` and `issues` runs the `approval-mode`, `tools` and `project-extensions` inputs are ignored: the run is always read-only as described above, and nothing is committed or pushed whatever the workspace holds. The model's output is used narrowly: a review is posted as event `COMMENT` (never an approval or a change request); inline comments are posted only on lines that appear in the pull request's diff (anything else goes into the summary); triage labels are applied only if they already exist in the repository (and only with `apply-labels: true`), and a duplicate is named only if it was one of the search candidates. Free text is posted verbatim, so a prompt-injected review can still say something wrong, but it cannot take an action.
- **Who gets reviewed or triaged.** `pr-associations` and `triage-associations` default to `OWNER,MEMBER,COLLABORATOR`, the same as mentions, because every review is model spend and a stranger can open a pull request or an issue on a public repository at will. Open-source projects that want to review outside contributors add `CONTRIBUTOR,FIRST_TIME_CONTRIBUTOR,FIRST_TIMER,NONE`, and for fork pull requests also `allow-fork-prs: true`; pair that with `max-cost`, a job `timeout-minutes` and a concurrency group. Bot authors (Dependabot, other apps) are skipped, and so are draft pull requests until they are marked ready.
- **The workflow token.** `permissions:` in the example grants write access to contents, issues and pull requests, not more. The action pushes to the workflow's own repository and not to whatever `origin` is configured to. The agent can write `.git/config`, `.git/info/attributes` and `.gitattributes`, and git runs the commands those name (`filter.*.clean`, `diff.*.textconv`, `core.sshCommand`, `core.askPass`, `core.fsmonitor`, hooks, config includes, aliases); running git in that repository with the token in the environment would hand the token and the provider key to the agent. So `publish.sh` never runs git against the workspace's `.git`. It creates a private repository outside the workspace, fetches the commit omp started from with the token, stages the workspace files into it (the workspace is only a work tree), commits and pushes from there. Its configuration is written by the script; system and global git config are disabled (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), `core.hooksPath` and `core.fsmonitor` are off, and no filter or textconv driver is defined, so a `filter=x` in an agent-written `.gitattributes` names nothing. `gh` is then run from outside any repository. Consequences: Git LFS filters are not applied (files are committed as they are in the workspace), and submodules or embedded repositories are refused. A hostile agent with a shell can still tamper with the working tree itself, which is why `write` is the default mode; steps you add after the action in the same job still run against the agent-modified workspace.
- **Same-repo PRs are pushed to directly.** The commit lands on the PR author's branch without a review step. Use `create-pr: false` to get replies only, or restrict `allowed-associations`.
- **Cost.** A run is bounded by `max-time`, optionally `max-cost`, and the job's `timeout-minutes`; set all three. The cost in the reply footer is the sum of per-message costs from the event stream and may omit subagent spend. Use one concurrency group per thread, as in the example, so a flurry of comments does not run in parallel. GitHub-hosted runner minutes are billed separately from model spend.
- **Privacy.** The issue or PR text, the files the agent reads, and tool output are sent to your model provider.

## Local dry run

The scripts only need `bash`, `jq`, `git` and, for publishing, `gh`. To exercise them without GitHub, export the variables listed at the top of each script, point `GITHUB_EVENT_PATH` at a saved event payload, put stub `gh` and `omp` executables first on `PATH`, set `OMP_BIN` to the stub, and use a `file://` directory of bare repositories as `GITHUB_SERVER_URL`. Run `prepare.sh`, `run.sh` and `publish.sh` in that order, as the action does; `prepare.sh` writes `skip=true` to `$GITHUB_OUTPUT` when the event does not start a run.

`packages/coding-agent/test/github-action-triggers.test.ts` does this for every trigger (a comment mention, `pull_request`, `pull_request_target`, `issues`, `schedule`, `workflow_dispatch`, and `push`, which must not run): fake event payloads, stub `omp` and `gh` that record their arguments, and real git against temporary bare repositories. It asserts the prompt, the `omp` flags and the `gh` calls of each, and runs `shellcheck` over the scripts.
