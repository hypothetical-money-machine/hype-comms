# Windows code-signing certificate: procurement research

Resolves the research ticket for issue #47 ("Windows code-signing certificate path").
Researched against Microsoft Learn, electron-builder docs, and CA product pages.

Implementation and the ops checklist for GitHub issue #158 live in
[docs/windows-signing.md](../windows-signing.md). This file stays the procurement comparison.

## Current state (constraints from this repo)

- `.github/workflows/desktop-release.yml` packages Windows x64 + ARM64 installers with
  electron-builder on a **self-hosted Windows ARM64 runner** (matrix lane `windows-release`).
  The ticket asks about GitHub-hosted runner compatibility; note our Windows lane is actually
  self-hosted, which relaxes nothing important — every option below works on either.
- README "Desktop releases and updates": Windows installers are unsigned; updates are protected
  only by HTTPS + manifest checksum. `electron-updater` skips Authenticode verification because
  no `publisherName` is recorded in `app-update.yml`. Closing the gap means signing **and**
  setting `publisherName` so `verifyUpdateCodeSignature` becomes meaningful.
- macOS signing already works from CI secrets; the goal is an equivalent Windows path with no
  human in the loop.

## Background: the 2023 CA/Browser Forum rule change

Since June 1, 2023, the CA/B Forum Code Signing Baseline Requirements mandate that private keys
for **all** publicly trusted code-signing certificates (OV as well as EV) be generated and stored
in FIPS 140-2 Level 2+ hardware (USB token, HSM, or a CA-operated cloud HSM). The old workflow —
"export a `.pfx`, base64 it into a CI secret, point `WIN_CSC_LINK` at it" — is no longer possible
for newly issued certs. Every 2025 option is therefore one of:

1. a USB token plugged into a build machine (unusable for hosted CI, awkward even self-hosted),
2. a cloud HSM / signing service operated by the CA (SSL.com eSigner, DigiCert KeyLocker,
   Sectigo SigningStack/partners), or
3. Microsoft's own cloud service, Azure Trusted Signing (being renamed "Artifact Signing").

## Options compared

### 1. Azure Trusted Signing / Artifact Signing (Microsoft)

- **What it is**: fully managed signing; short-lived (≈3-day) certs issued from a Microsoft
  "ID Verified CS" CA, keys in FIPS 140-3 Level 3 HSMs, never touch the runner. Signing is
  `signtool /dlib` against a regional endpoint.
- **Eligibility (the key catch)**: as of the April 2, 2025 public-preview update, new
  subscriptions are limited to **US/Canada-based organizations with 3+ years of verifiable
  history**. Individual-developer onboarding (previously previewed for US/CA individuals) is
  paused until GA. Current Microsoft Learn docs list broader geographies (US, CA, EU, UK, AU,
  NZ, JP, KR, SG, CH, NO, IL for orgs; US/CA for individuals), so availability is in flux —
  check at purchase time. Identity validation: 1–20 business days; org details must match
  public records; individual validation pulls from the Azure billing account and requires
  government-ID verification (AU10TIX + Verified ID). Requires a **paid** Azure subscription
  (no free/trial/sponsored).
- **Pricing**: Basic SKU ≈ **$9.99/month** (5,000 signatures/month included), Premium ≈
  $99.99/month (100,000). Basic is far more than enough for our release cadence (each release
  signs a handful of files per arch). Cheapest recurring option by an order of magnitude.
- **electron-builder integration**: first-class. `win.sign: { type: "azure", endpoint,
codeSigningAccountName, certificateProfileName, publisherName }` plus three CI secrets
  (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) for an Entra app registration
  with the "Trusted Signing Certificate Profile Signer" role. In electron-builder v27 the
  `signtool /dlib` path is the default (winCodeSign toolset ≥ 1.3.0, .NET 8 runtime
  auto-downloaded); works on Windows runners natively and even on macOS/Linux via Wine.
  GitHub Actions OIDC federation (`AZURE_FEDERATED_TOKEN_FILE`) is supported if we want to
  avoid a long-lived client secret. Labeled **beta** in electron-builder but is the
  actively maintained path.
- **SmartScreen**: certs chain to Microsoft's ID Verified CS PCA; reputation still builds per
  publisher identity, but community experience and Microsoft's positioning indicate markedly
  faster/better SmartScreen treatment than a fresh OV cert from a third-party CA. Not an
  instant-trust guarantee.
- **Caveats**: network dependency to Azure during the build; no EV profile exists (irrelevant —
  we ship no kernel drivers); resources can't be migrated across tenants/subscriptions.

### 2. SSL.com OV/IV certificate + eSigner cloud signing

- **Cost**: OV cert **$129/yr** (org validation, business entity required) or IV $129/yr
  (individual, no entity needed); EV $349/yr. eSigner cloud-HSM subscription on top:
  **$15/month** Tier 1 (240 signings/mo, roll over). So ≈ **$309/yr** for OV + eSigner.
  Alternative: YubiKey FIPS token (+$249 one-time) — but a USB token doesn't work on hosted
  runners and is a liability even on our self-hosted VM.
- **CI integration**: eSigner CKA wraps the key as a Windows CSP/certificate-store entry so
  `signtool.exe` sees it; documented GitHub Actions flow. With electron-builder this means
  `win.sign: { type: "signtool", certificateSubjectName: ... }` after installing/activating
  CKA in a workflow step — more moving parts than the Azure path, and CKA is Windows-only
  (Linux/mac would use their CSC REST API with a custom `sign` hook). Per-signing malware
  scanning and OTP requirements must be disabled/automated for headless use.
- **SmartScreen**: normal OV reputation ramp. SSL.com's own FAQ now states Microsoft treats
  EV and OV equally for SmartScreen (since ~March 2024) — reputation is earned by clean
  download volume either way.
- **Eligibility**: no 3-year-history rule; IV works for individuals. Good fallback if Azure
  Trusted Signing onboarding is closed or the org is too young.

### 3. DigiCert OV/EV + KeyLocker

- OV code signing list price ≈ $500+/yr (frequently ~$369+ via resellers); EV ≈ $700+/yr.
  KeyLocker (DigiCert ONE cloud HSM) adds a subscription and per-signature quotas (typically
  ~1,000 signatures/yr included, overage billed). CI integration is via their `smctl`/CSP
  tooling + signtool, so electron-builder works through `certificateSubjectName` or a custom
  sign hook. Solid and enterprise-grade, but the most expensive path here and no SmartScreen
  advantage over cheaper OV options for a non-EV cert. Not recommended for a two-person team.

### 4. Sectigo OV/EV

- OV ≈ $250–430/yr depending on reseller/term; ships on a USB token by default. Cloud signing
  exists via partners (e.g., SigningStack/SignPath-style services) but is less turnkey than
  eSigner or Trusted Signing. Same token-in-CI problem; no differentiated benefit. Not
  recommended.

### EV in 2025: mostly not worth it for us

- The historical EV selling point — instant SmartScreen reputation — has been walked back by
  Microsoft; since ~2024 EV and OV build reputation the same way. EV remains required only for
  kernel-mode drivers and Windows Hardware Dev Center, which we don't use.
- EV keys are always hardware-bound (token or cloud HSM), so EV in CI forces the same cloud
  service costs on top of a pricier cert.

## Recommendation

**Primary: Azure Trusted Signing (Basic SKU, ~$10/month)**, provided the org can pass
onboarding (US/Canada org with 3+ years of verifiable history under the current preview
restriction, or whatever eligibility applies at GA).

Rationale:

- Cheapest by far (~$120/yr vs ~$309/yr SSL.com, ~$500–900/yr DigiCert) with a per-month exit.
- Best CI story for our exact stack: electron-builder ≥ v27 supports it natively via
  `win.sign.type: "azure"`; three env secrets, no certificate material stored anywhere, no
  token hardware, works on our self-hosted Windows ARM64 lane and on GitHub-hosted runners
  alike, and can even sign the cross-built x64 artifacts from a non-Windows lane if the
  release topology ever changes.
- Key custody is Microsoft-managed FIPS 140-3 L3; short-lived certs shrink the blast radius of
  a compromise — a good match for our threat model where the update bucket key is already
  treated as code execution on every pilot machine.
- SmartScreen treatment is at least as good as a fresh OV cert, likely better.

**Fallback: SSL.com OV (or IV) + eSigner Tier 1 (~$309/yr)** if Trusted Signing onboarding is
closed to us (org younger than 3 years, non-US/CA entity, or preview restrictions still in
force). It is the cheapest CA-based cloud-HSM path with a documented GitHub Actions flow.

Explicitly not recommended: DigiCert/Sectigo (cost, no benefit), any USB-token workflow
(incompatible with unattended CI), and EV generally (no remaining SmartScreen advantage; we
sign no drivers).

### Implementation notes for whoever picks this up

1. Create Azure Trusted Signing account (Basic) + org identity validation; expect 1–20
   business days for validation.
2. Certificate profile type: Public Trust. Create an Entra app registration, grant it
   "Trusted Signing Certificate Profile Signer", store `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
   `AZURE_CLIENT_SECRET` as repo secrets (or use GitHub OIDC federation to avoid the secret).
3. electron-builder config: this repo is on 26.15.3, so use `win.azureSignOptions` (v27 renamed
   that to `win.sign.type: "azure"`). Set `forceCodeSigning: true` only once the Azure identity
   is present so a misconfiguration fails the build instead of silently shipping unsigned. Until
   then the Windows lane stays inert and keeps publishing unsigned artifacts.
4. Set `publisherName` so electron-updater writes it into `app-update.yml` and starts
   verifying update signatures independent of transport. Note the README's rollout caveat:
   the first signed release must still be accepted by clients whose current install records
   no publisher; verify the upgrade path from an unsigned install before flipping any
   enforcement.
5. Timestamping defaults to `http://timestamp.acs.microsoft.com` for the Azure path — fine.

## Sources

- electron-builder Windows code signing (win.sign union, azure/hsm/pkcs11 backends, beta
  status, toolset ≥1.3.0 dlib path): https://www.electron.build/docs/features/code-signing/code-signing-win
- electron-builder code signing overview (env vars, GitHub Actions examples,
  forceCodeSigning): https://www.electron.build/docs/features/code-signing/
- Azure Trusted/Artifact Signing overview & quickstart (eligibility geographies, identity
  validation, regions, paid-subscription requirement):
  https://learn.microsoft.com/en-us/azure/trusted-signing/overview,
  https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart
- Azure Artifact Signing pricing (Basic 5,000 sigs/mo, Premium 100,000):
  https://azure.microsoft.com/en-us/pricing/details/trusted-signing/
- Trusted Signing FAQ (FIPS 140-3 L3, no EV, SmartScreen reputation, subscription types):
  https://learn.microsoft.com/en-us/azure/trusted-signing/faq
- Trusted Signing Public Preview update, Apr 2, 2025 (3-year org history, US/CA-only, individual
  onboarding paused):
  https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-public-preview-update/4399713
- SSL.com code signing products & pricing (IV/OV $129, EV $349, eSigner tiers from $15/mo,
  EV/OV SmartScreen parity since ~March 2024): https://www.ssl.com/certificates/code-signing/,
  https://www.ssl.com/products/software-integrity/signing-service/
