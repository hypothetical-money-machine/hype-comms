# Hype Comms release notes

The agent runbook for cutting a release is [docs/agents/releases.md](../agents/releases.md).

Prepare a desktop release with an explicit stable version:

```bash
npm run release -- 0.1.25
```

The command rejects unrelated worktree changes, updates `apps/desktop/package.json`, synchronizes
the matching workspace version in `package-lock.json`, and creates
`docs/releases/v<version>.md`. It uses an ephemeral local Git lock—a private ref and tiny owner
record—only to serialize concurrent preparations; otherwise its Git access is read-only. It never
changes a commit, branch, tag, or remote, runs checks, or publishes. Omitting the version exits with
an error after suggesting the next local patch, while re-running the exact target preserves an
existing nonempty notes file. An empty existing file is rejected so preparation cannot report
success for notes the workflow would refuse.

Every desktop release must include reviewed, user-facing notes in that versioned regular file;
symlinks and special files are rejected. The generated scaffold begins with a `release-notes:todo`
marker; replace the instructional bullets and remove the marker only after reviewing the final text.

Write for someone deciding whether to install the update. Lead with meaningful new behavior and
important fixes, omit internal delivery work, and call out any known limitation or manual action.
Use this compact shape, dropping empty sections:

```markdown
## Highlights

- Describe the user-visible change and why it matters.

## Fixes

- Describe the corrected behavior.

## Known limitations

- Describe any important limitation or required follow-up.
```

The release workflow prepends this file to GitHub's generated pull-request history. It rejects a
missing, empty, or still-unreviewed versioned file, prepends the reviewed text to any pre-existing
draft that lacks it, and refuses to publish a GitHub Release that does not contain the reviewed text.
