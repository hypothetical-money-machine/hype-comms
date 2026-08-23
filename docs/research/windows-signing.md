# Windows code-signing references

This is a vendor-reference note, not the signing runbook. Service eligibility, pricing, and
electron-builder support change frequently. Check the vendor documentation before purchasing or
changing the release setup.

The repository currently contains Azure Trusted Signing integration, but no Azure signing identity.
Windows installers are unsigned. [windows-signing.md](../windows-signing.md) is the current
configuration and verification guide.

| Service | Repository status | Vendor documentation |
| --- | --- | --- |
| Azure Trusted Signing / Artifact Signing | Wired into the Windows release job; not configured | [Overview](https://learn.microsoft.com/en-us/azure/trusted-signing/overview), [quickstart](https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart), [pricing](https://azure.microsoft.com/en-us/pricing/details/trusted-signing/) |
| SSL.com eSigner | No repository integration | [Code signing](https://www.ssl.com/certificates/code-signing/), [signing service](https://www.ssl.com/products/software-integrity/signing-service/) |
| DigiCert KeyLocker | No repository integration | [DigiCert code signing](https://www.digicert.com/signing/code-signing-certificates) |
| Sectigo cloud signing | No repository integration | [Sectigo code signing](https://www.sectigo.com/ssl-certificates-tls/code-signing) |

Publicly trusted code-signing keys use hardware-backed or cloud-HSM custody. Do not add a newly
issued certificate as a `.pfx` repository secret. The current Windows release automation expects
Azure's service and checks the issued publisher subject in both the package metadata and signed
artifacts.

electron-builder's Windows signing documentation is the source for its supported configuration
shape: [code signing](https://www.electron.build/docs/features/code-signing/code-signing-win) and
[environment configuration](https://www.electron.build/docs/features/code-signing/).
