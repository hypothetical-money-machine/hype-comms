# Windows Authenticode signing

Windows release automation supports Azure Trusted Signing, but no Azure account, Entra app,
certificate profile, or publisher subject is configured. Windows releases therefore publish
unsigned NSIS installers today. DEV package smoke is also unsigned.

The release lane has three states:

| Configuration | Release behavior |
| --- | --- |
| Every Azure signing value is blank | Publish unsigned Windows artifacts |
| Some values are set | Fail before packaging or publication |
| Every value is set | Sign and verify every Windows artifact before publication |

Do not add certificate material, client secrets, or a real publisher subject to the repository.
External vendor notes are in [research/windows-signing.md](research/windows-signing.md).

## Build configuration

The desktop workspace uses `electron-builder@^26.15.3`. Its Azure configuration is
`win.azureSignOptions`; version 27 uses a different `win.sign` shape. Keep the version-26 key
until the dependency is upgraded with its matching configuration change.

The tagged Windows job reads the required values through
`scripts/require-windows-signing-env.mjs`. When enabled, it maps the Azure values to
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`, disables automatic certificate
discovery, and builds with production flavor, `forceCodeSigning`, and
`verifyUpdateCodeSignature`.

The packaged `app-update.yml` receives the issued publisher subject. The public `latest.yml`
contains only updater metadata. Package verification requires the publisher subject when signing is
enabled. The Windows release verification then checks every NSIS installer and unpacked
`hype-comms.exe` with `Get-AuthenticodeSignature`.

## Required repository configuration

Add these Actions repository secrets:

| Secret | Value |
| --- | --- |
| `HYPE_COMMS_WINDOWS_AZURE_TENANT_ID` | Entra Directory ID |
| `HYPE_COMMS_WINDOWS_AZURE_CLIENT_ID` | Entra application client ID |
| `HYPE_COMMS_WINDOWS_AZURE_CLIENT_SECRET` | Entra client-secret value |

Add these Actions repository variables:

| Variable | Value |
| --- | --- |
| `HYPE_COMMS_WINDOWS_AZURE_ENDPOINT` | Trusted Signing regional endpoint |
| `HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME` | Trusted Signing account name |
| `HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME` | Public Trust certificate profile name |
| `HYPE_COMMS_WINDOWS_PUBLISHER_NAME` | Exact issued certificate subject |

`HYPE_COMMS_WINDOWS_PUBLISHER_NAME` must match the `publisherName` written into
`app-update.yml` and the certificate subject reported by `Get-AuthenticodeSignature`.

## Provision and verify

Use a paid Azure subscription that is eligible for the service. Create a Trusted Signing account,
a Public Trust certificate profile, and an Entra app with the Trusted Signing Certificate Profile
Signer role. Copy the issued certificate subject into
`HYPE_COMMS_WINDOWS_PUBLISHER_NAME`. Confirm the Windows release runner can reach the regional
endpoint and has .NET 8.

With the configuration present, run on the Windows release runner:

```powershell
$env:HYPE_COMMS_BUILD_FLAVOR = "production"
npm run package:desktop:win
npm run verify:desktop-package
npm run verify:desktop-package:windows-release
```

For one installer and one unpacked executable, verify the result directly:

```powershell
Get-AuthenticodeSignature -LiteralPath .\hype-comms-<version>-win-arm64.exe |
  Select-Object Status, StatusMessage, @{n='Subject';e={$_.SignerCertificate.Subject}}
```

The status must be `Valid` and the subject must equal
`HYPE_COMMS_WINDOWS_PUBLISHER_NAME`. Verify both x64 and ARM64 installers and unpacked
executables.

The first signed update from an unsigned 0.1.x client still relies on HTTPS and the updater
checksum because that installed client has no `publisherName`. Confirm that update works, then
cut another signed release and confirm an already-signed client accepts the real artifact and
rejects a changed signer or stripped signature.
