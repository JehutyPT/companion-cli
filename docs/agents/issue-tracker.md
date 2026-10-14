# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations, targeting `JehutyPT/companion-cli` explicitly with `--repo` or API paths when repository inference is unavailable.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write the exact multi-line body to a temporary file first.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **Edit the canonical body**: write the complete body to a temporary file, then run `gh issue edit <number> --body-file <file> --remove-label "<internal-readiness-label>"`. Every generic body edit invalidates readiness; preparation may restore it later.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Internal implementation contracts

The issue body's `## Implementation Contract` section is the sole implementation authority defined in `docs/agents/implementation-contract.md`. Metadata elsewhere in the body, parent PRDs, dependency issues, and comments are context only. Edit the body to update that section when preparing a ticket.

- **Parent edge**: use GitHub sub-issues, adding each implementation issue beneath its PRD. Keep the relationship for the life of the issue.
- **Blocker edge**: use GitHub issue dependencies: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where the database id comes from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. After the edge succeeds, remove the internal readiness label from the child if present.
- **Retain edges**: do not remove a blocker edge when its issue closes. Only blockers whose current state is open gate preparation and implementation.
- **Unblocking**: closing or removing the last blocker leaves the child unready until `/prepare-ticket` refreshes its contract.
- **Readiness**: use the internal readiness label configured in `docs/agents/issue-labels.md`. Apply it last only to an open, complete, validated contract with zero open blockers.
- **Invariant audit**: back wrappers with a GitHub Actions audit that handles `issues.edited` and `issues.closed`, plus a scheduled/manual sweep. A material body edit removes readiness; an edit that only toggles existing task-list checkbox states may preserve it. When a blocker closes, traverse every retained `blocking` edge and invalidate ready open dependents. Sweeps remove readiness from closed tickets and tickets with any open blocker. Paginate every `blocking` and `blockedBy` connection, retain all edges, and never promote an issue.

## External issues as a triage surface

**External issues as a request surface: no.** _(Set to `yes` only when third-party issues should enter `/triage`.)_

When enabled, triage only issues whose `authorAssociation` is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`. `OWNER`, `MEMBER`, and `COLLABORATOR` issues are internal work and never enter external triage.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, external PRs run through the same labels and states as external issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). If formal sub-issues are unavailable, report the limitation and leave publication incomplete until the relationship can be recorded. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). If formal dependencies are unavailable, report the limitation and leave affected tickets unready. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
