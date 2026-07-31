# Contributing

Hype Comms currently accepts changes from members of the Hypothetical Money Machine GitHub
organization.

## Workflow

1. Create a short-lived branch from `main`.
2. Keep contracts backward compatible or document the intentional version change.
3. Run `npm run check` and the relevant native desktop packaging smoke test.
4. Open a pull request describing user-visible behavior, security impact, and test evidence.

Do not commit credentials, signing material, message contents from real users, generated
installers, or local databases. Database migrations and realtime event contracts require
forward- and backward-compatibility tests before merge.
