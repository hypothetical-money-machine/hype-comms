# Contributing

Hype Comms currently accepts changes from members of the Hypothetical Money Machine GitHub
organization.

## Pull request checks

Pull requests, including pull requests from forks, run on disposable GitHub-hosted infrastructure.
The workflows receive a read-only token and no repository secrets.

Before pushing a fork pull request, use Node.js 24.18.x from `.node-version` and npm 11.16.x, then
run:

```bash
npm ci
npm run check
```

CI repeats these checks and runs the PostgreSQL and desktop packaging lanes on hosted runners.

## Reading the history

Issue and pull request numbers in commit messages from before the public repository migration,
such as `Closes #227`, do not correspond to current issue numbers. The tracker was renumbered
during the migration; the commits themselves were not rewritten.

## Workflow

1. Create a short-lived branch from `main`.
2. Keep contracts backward compatible or document the intentional version change.
3. Run `npm run check` and the relevant native desktop packaging smoke test.
4. Open a pull request describing user-visible behavior, security impact, and test evidence. For
   renderer or other user-visible desktop UI changes, include final-state screenshot(s) in the
   PR's Screenshots section; use `N/A — no renderer/UI changes` when the change is not visual.

Read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. Do not report suspected
vulnerabilities in public issues; follow [the security policy](SECURITY.md) instead.

Do not commit credentials, signing material, message contents from real users, generated
installers, or local databases. Database migrations and realtime event contracts require
forward- and backward-compatibility tests before merge.

## Licensing

Hype Comms is licensed under the [MIT license](LICENSE). Contributions are inbound-license-outbound:
your contribution is licensed to everyone under MIT, same as the rest of the project.

To keep the project's options open, by submitting a contribution you agree that the maintainers
may include your contribution in a future version of Hype Comms published under a different
license. Already-released versions stay available under the MIT license forever; only later
versions can change terms.
