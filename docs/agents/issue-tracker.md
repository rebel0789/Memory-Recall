# Issue tracker: GitHub with local drafts

Issues and PRDs for this repo live in GitHub Issues for `rebel0789/Memory-Recall`. Use the `gh` CLI for canonical issue operations.

Local markdown under `.scratch/` may be used for offline notes, private scratch work, or draft issue/PRD shaping before publishing to GitHub. Local markdown is not the canonical tracker unless the user explicitly asks for a local-only draft.

## GitHub conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` - `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: yes.**

External PRs run through the same labels and states as issues. Collaborator-owned in-flight PRs are not part of the request queue.

Use the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List PRs for triage**: `gh pr list --state open --json number,title,author,isDraft,mergeStateStatus,mergeable,statusCheckRollup,labels,headRefName,updatedAt,url`. When open issues are empty, inspect open PRs before inventing backlog work. Maintainer-owned `CLEAN` PRs are release/review queue; bot or external `UNSTABLE` PRs are triage queue.
- **Detect superseded PRs**: compare `gh pr diff <number> --name-only` with the active branch (`git diff --name-only origin/main...HEAD`), staged (`git diff --cached --name-only`), and unstaged (`git diff --name-only`) file lists before cherry-picking or merging old green PRs into an active branch.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

For status-only queue checks, stop after listing issues/PRs and reading check
state; do not comment, label, close, merge, or publish without an explicit user
request.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either. Resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Local draft conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a GitHub issue unless the user explicitly asks for a local markdown draft.

## When a skill says "fetch the relevant ticket"

Use `gh issue view <number> --comments` or `gh pr view <number> --comments` depending on whether the ticket is an issue or PR.
