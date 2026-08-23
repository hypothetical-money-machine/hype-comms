# GitHub issues

Hype Comms tracks issues and product requirements in GitHub Issues. Use `gh` from the repository.
It infers the repository from the remote.

## Common commands

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use a heredoc for a multiline issue body. Fetch labels and filter comments with `jq` when a task
requires them.

## Pull requests

PRs as a request surface: no

External pull requests are not feature requests in this repository. If that policy changes, use
the corresponding `gh pr` commands and triage only authors whose association is `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, or `NONE`.

GitHub uses one number sequence for issues and pull requests. Resolve a bare `#42` with
`gh pr view 42`, then fall back to `gh issue view 42`.

## Skill instructions

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a
ticket, run `gh issue view <number> --comments`.

## Wayfinding

`/wayfinder` uses one map issue and linked child issues.

- Create the map with `gh issue create --label wayfinder:map`. Its body contains the Notes,
  Decisions-so-far, and Fog sections.
- Link each child issue as a GitHub sub-issue. If sub-issues are unavailable, add it to the map's
  task list and put `Part of #<map>` at the top of the child.
- Apply one `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`. Assign the
  child to the driving developer when claimed.
- Use GitHub issue dependencies for blockers:

  ```bash
  gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by \
    -F issue_id=<blocker-database-id>
  ```

  Get the database ID, not the issue number or node ID, with
  `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. If issue dependencies are unavailable,
  add `Blocked by: #<number>` at the top of the child issue.
- The frontier is the first unassigned open child in map order with no open blocker.
- Claim it with `gh issue edit <number> --add-assignee @me`.
- Resolve it with `gh issue comment <number> --body "<answer>"`, then `gh issue close <number>`,
  and add the resulting context link to the map.
