# M1 sign-off — private access and local vertical slice

Status: accepted as the local implementation baseline on 2026-07-24.

M1 closes the insecure shared-access-code prototype. The accepted baseline has one
PostgreSQL-backed workspace, an owner-seeded invitation model, single-use email magic links,
revocable device sessions, an Electron deep-link callback, and a minimal authenticated
workspace view. Credentials and authenticated networking remain in Electron main; the renderer
receives only validated, credential-free IPC data.

The acceptance evidence is the repository's identity, migration, route, deep-link, cookie, CSP,
and package tests together with the working owner/member magic-link flow. The full database suite
is exercised against PostgreSQL 18 when `HMM_TEST_DATABASE_URL` is present.

This sign-off intentionally does not claim hosted-production readiness. Cloud infrastructure,
operational alerts, signed packages, and production release acceptance remain M4 work. M1 is the
identity and local-service baseline on which M2 conversations are built.

The following old behavior is explicitly outside the accepted baseline:

- the shared access code and `/v1/chat/*` routes;
- SQLite as authoritative message or session storage;
- the unauthenticated development `#welcome` channel as a production path; and
- GitHub-hosted native package smoke tests before M4.
