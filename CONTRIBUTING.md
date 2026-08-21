# Contributing

Hype Comms currently accepts changes from members of the Hypothetical Money Machine GitHub
organization.

## Workflow

1. Create a short-lived branch from `main`.
2. Keep contracts backward compatible or document the intentional version change.
3. Run `npm run check` and the relevant native desktop packaging smoke test.
4. Open a pull request describing user-visible behavior, security impact, and test evidence. For
   renderer or other user-visible desktop UI changes, include final-state screenshot(s) in the
   PR's Screenshots section; use `N/A — no renderer/UI changes` when the change is not visual.

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

