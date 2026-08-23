# Hype Comms release notes

The agent runbook for cutting a release is [docs/agents/releases.md](../agents/releases.md).

Prepare a desktop release with an explicit stable version:

```bash
npm run release -- 0.1.25
```

The command rejects unrelated worktree changes, updates `apps/desktop/package.json`, synchronizes
the matching workspace version in `package-lock.json`, and creates
`docs/releases/v<version>.md`. A private local Git lock prevents concurrent preparations. The
command does not change a commit, branch, tag, or remote, run checks, or publish. Omitting the
version reports the next local patch without changing files. Re-running the same target preserves a
nonempty notes file. An empty existing file is an error.

Every desktop release must include reviewed, user-facing notes in that versioned regular file;
symlinks and special files are rejected. The generated scaffold begins with a `release-notes:todo`
marker; replace the instructional bullets and remove the marker only after reviewing the final text.

Write for someone deciding whether to install the update. Lead with user-visible behavior and
important fixes. Omit internal delivery work. Include a known limitation or required manual action.
Use this compact shape, dropping empty sections:

```markdown
## Highlights

- Describe the user-visible change.

## Fixes

- Describe the corrected behavior.

## Known limitations

- Describe any important limitation or required follow-up.
```

The release workflow prepends this file to GitHub's generated pull-request history. It rejects a
missing, empty, or unreviewed versioned file and refuses to publish a GitHub Release without the
reviewed text.
