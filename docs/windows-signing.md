# Windows Authenticode signing

The Windows release lane stays **inert** until Azure Trusted Signing is fully configured, then
**fail-closes**. Missing identity does not turn the job red: it keeps publishing unsigned NSIS
installers, the same as v0.1.29. A partial secret/variable set, or a configured job that fails to
sign, publishes nothing. DEV package-smoke stays unsigned.

This is the ops checklist for GitHub issue #158 / the tracker `#158`. Procurement research and the
SSL.com fallback live in [docs/research/windows-signing.md](research/windows-signing.md). Do not
put certificate material, client secrets, or a real publisher subject in the repository.

## electron-builder 26 vs 27

The desktop workspace pins `electron-builder@^26.15.3`. Installed 26.15.3 exposes Azure Trusted
Signing as `win.azureSignOptions` (`publisherName`, `endpoint`, `codeSigningAccountName`,
`certificateProfileName`) and reads `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
`AZURE_CLIENT_SECRET`. v27 renamed that object to `win.sign: { type: "azure", ... }` as a breaking
schema change. This repo uses the v26 key and does not bump electron-builder for the rename.

## Why this is blocked on ops

CA/B Forum rules no longer allow a newly issued public code-signing private key to be exported as a
`.pfx` and stored in `WIN_CSC_LINK`. The chosen path is **Azure Trusted Signing** (Basic SKU):
Microsoft holds the key in an HSM and the self-hosted Windows ARM64 runner signs over the network.

No Azure Trusted Signing account, Entra app, certificate profile, or publisher CN exists in this
repository today. The pipeline is wired; the identity is not. Do not invent those values.

## What the pipeline already does

On `v*` tags, `.github/workflows/desktop-release.yml` Windows lane:

1. Reads every secret and variable below via `scripts/require-windows-signing-env.mjs`.
   All blank → unsigned publish (`HYPE_COMMS_WINDOWS_SIGNING_ENABLED=false`). Some but not all
   set → fail. All set → map the three Azure secrets to `AZURE_TENANT_ID` /
   `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` and disable `CSC_IDENTITY_AUTO_DISCOVERY`.
2. When enabled, packages `HYPE_COMMS_BUILD_FLAVOR=production` with
   `win.azureSignOptions` + `win.forceCodeSigning: true` + `verifyUpdateCodeSignature: true`.
   The publisher subject is written into the **packaged** `app-update.yml` so later Windows
   updates verify Authenticode. `latest.yml` stays a version/path/sha512 pointer and does not
   carry `publisherName`.
3. When enabled, `npm run verify:desktop-package` also requires `publisherName` in
   `app-update.yml`.
4. When enabled, `npm run verify:desktop-package:windows-release` calls
   `Get-AuthenticodeSignature` on every NSIS installer and every unpacked `hype-comms.exe` and
   requires `Status = Valid` plus an exact publisher-subject match.
5. Only then stages GitHub Release assets and publishes `latest.yml`.

A 0.1.29 Windows client has no `publisherName` in its on-disk `app-update.yml`.
`electron-updater`'s `NsisUpdater.verifySignature` returns immediately in that case, so the first
signed installer is still accepted (HTTPS + manifest checksum only). The next signed-to-signed
update is when Authenticode is enforced.

## Repository secrets

Add these as **Actions repository secrets** (not variables). Scope them to this repository. Values
come from the Entra app registration created below.

| Secret | Value |
| --- | --- |
| `HYPE_COMMS_WINDOWS_AZURE_TENANT_ID` | Entra tenant ID (Directory ID), not the display name |
| `HYPE_COMMS_WINDOWS_AZURE_CLIENT_ID` | Application (client) ID of the app registration, not the object ID |
| `HYPE_COMMS_WINDOWS_AZURE_CLIENT_SECRET` | Client secret **value**, not the secret ID |

OIDC federation (`AZURE_FEDERATED_TOKEN_FILE`) can replace the client secret later. Do not block
first signing on that.

## Repository variables

Add these as **Actions repository variables**. They are not credentials, but a wrong publisher
subject will fail both packaging and the Authenticode gate.

| Variable | Value |
| --- | --- |
| `HYPE_COMMS_WINDOWS_AZURE_ENDPOINT` | Trusted Signing regional URI, for example `https://eus.codesigning.azure.net/` |
| `HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME` | Trusted Signing **account** name, not the Entra app display name |
| `HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME` | Certificate profile name (Public Trust) |
| `HYPE_COMMS_WINDOWS_PUBLISHER_NAME` | Exact certificate subject, copied from the issued profile. Example shape only: `CN=Hypothetical Money Machine, O=Hypothetical Money Machine, L=City, S=State, C=US`. Use the real subject; do not invent one. |

`HYPE_COMMS_WINDOWS_PUBLISHER_NAME` must equal:

- `win.azureSignOptions.publisherName` (electron-builder writes this into `app-update.yml`)
- `Get-AuthenticodeSignature … \| % { $_.SignerCertificate.Subject }` on a signed artifact

## Azure procurement

1. Use a **paid** Azure subscription. Trusted Signing rejects free/trial/sponsored subscriptions.
2. Confirm current eligibility (org identity, geography, history). If onboarding is closed, use the
   SSL.com eSigner fallback in the research note instead of inventing a `.pfx` secret.
3. Create a Trusted Signing account on the Basic SKU in a supported region.
4. Create a **Public Trust** certificate profile and complete identity validation (often 1–20
   business days). Org details must match public records.
5. Create an Entra app registration. Grant it **Trusted Signing Certificate Profile Signer** on the
   account/profile. Create a client secret and store the three secrets above.
6. After the profile is issued, copy the certificate subject into
   `HYPE_COMMS_WINDOWS_PUBLISHER_NAME`. Do not guess the CN.
7. Confirm the self-hosted `windows-release` runner can reach the regional endpoint and has a
   current **.NET 8** runtime. electron-builder 26 signs through `Invoke-TrustedSigning`. If the
   runner's PowerShell policy blocks that module, allow the release user to run it, or install the
   Azure Code Signing dlib the builder downloads. The verification script already invokes
   `powershell.exe -ExecutionPolicy Bypass` and does not depend on Actions-generated `.ps1` files.

## Signed artifact

A successful Windows release must produce, for both x64 and ARM64:

| File | Authenticode |
| --- | --- |
| `apps/desktop/release/hype-comms-<version>-win-x64.exe` | Valid, publisher subject matches |
| `apps/desktop/release/hype-comms-<version>-win-arm64.exe` | Valid, publisher subject matches |
| `apps/desktop/release/win-unpacked/hype-comms.exe` or `win-arm64-unpacked` / `win-x64-unpacked` | Valid, publisher subject matches |
| `apps/desktop/release/win-*/resources/app-update.yml` | `publisherName` equals the variable |

GitHub Release assets keep the same names. The public feed file is still `latest.yml`. SmartScreen
reputation will be new; the first downloads may show an unknown-publisher warning until Microsoft
accumulates clean volume.

## Test plan

After the secrets and variables exist, do not invent a local certificate. Verify on the Windows
release runner or a Windows host with the same env:

1. `HYPE_COMMS_BUILD_FLAVOR=production npm run package:desktop:win`
2. `HYPE_COMMS_BUILD_FLAVOR=production npm run verify:desktop-package`
3. `npm run verify:desktop-package:windows-release`
4. Manually, for one installer and one unpacked exe:

   ```powershell
   Get-AuthenticodeSignature -LiteralPath .\hype-comms-<version>-win-arm64.exe |
     Select-Object Status, StatusMessage, @{n='Subject';e={$_.SignerCertificate.Subject}}
   ```

   Expect `Status = Valid` and `Subject` identical to `HYPE_COMMS_WINDOWS_PUBLISHER_NAME`.
5. On a Windows dogfood machine still running an **unsigned** 0.1.x build, install or auto-update
   to the first signed build. electron-updater skips Authenticode when the running app recorded no
   publisher; that first hop is HTTPS + manifest checksum only. Confirm the new `app-update.yml`
   now contains `publisherName`.
6. Cut the **next** signed release and confirm the already-signed client rejects a tampered
   installer (wrong publisher or stripped signature) and accepts the real artifact.
7. Watch the Desktop release Windows job: configure → package → `verify:desktop-package` →
   optional Authenticode verify → stage assets. All-blank config must stay green and unsigned.
   A partial set must fail at configure. A full set that fails to sign must publish nothing.

Until the values exist, unsigned Windows releases continue. That is the inert gate, not a red job.
