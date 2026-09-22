# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x (latest) | Yes |
| < 3.0 | No |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues by emailing **security@opencowork.ai** (or the maintainer contact listed in the repository). Include:

- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- Affected version(s)
- Potential impact assessment

### What to expect

- **Acknowledgement**: within 48 hours
- **Status update**: within 7 days
- **Fix timeline**: critical issues targeted within 14 days; others evaluated case-by-case

We will coordinate disclosure timing with you and credit reporters in the release notes unless you prefer to remain anonymous.

## Scope

In scope:
- Electron main process privilege escalation
- Arbitrary code execution via crafted input
- Credential / API key leakage
- Sandbox escape (Lima / WSL2 isolation)

Out of scope:
- Issues requiring physical access to a running machine
- Self-XSS or issues requiring the attacker to already have local code execution
- Vulnerabilities in third-party dependencies (report those upstream)

## Known accepted advisories

`scripts/audit-ci.mjs` fails CI on any high/critical dependency advisory that is
not explicitly accepted below. Each accepted entry has no upstream fix and is
re-reviewed on every dependency bump. The runtime mitigation for `extract-zip`
lives in `patches/extract-zip+2.0.1.patch`.

| Advisory | Package | Why accepted |
|----------|---------|--------------|
| GHSA-jmr9-qjv8-65gv | extract-zip | No fixed release (2.0.1 is latest). Symlink traversal blocked at runtime by our patch. |
| GHSA-7pqw-9j4j-h8q3 | extract-zip | Same as above — escaping-symlink arbitrary write blocked at runtime. |
| GHSA-qr28-p3wr-mxq3 | ngrok | Only 5.0.0-beta.2 is affected; fix is a downgrade to 4.3.3. Remote tunnels are opt-in and require a user-supplied token. |
| GHSA-jfgx-wxx8-mp94 | @mariozechner/pi-coding-agent | Every published version ≤ 0.73.1 is vulnerable; no upstream fix yet. |
| GHSA-r95r-rj6r-c39x | @mariozechner/pi-coding-agent | Every published version ≤ 0.73.1 is vulnerable; no upstream fix yet. |
| GHSA-7v5m-pr3q-6453 | @mariozechner/pi-coding-agent | Every published version ≤ 0.73.1 is vulnerable; no upstream fix yet. |

## Security Best Practices for Users

- Keep the app updated to the latest release.
- Store API keys only in the built-in credential store — never in plain text files.
- Review MCP server configurations before adding untrusted servers.
