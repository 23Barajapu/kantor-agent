# Security Policy

## Supported Versions

Only the latest release on the `main` branch receives security updates.

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| < 1.0 | No |

## Reporting a Vulnerability

If you discover a security vulnerability in Kantor Agent, please report it privately rather than opening a public issue.

Submit reports via email to security@23barajapu.com or through GitHub Security Advisories at https://github.com/23Barajapu/kantor-agent/security/advisories/new.

Include the following details in your report:
- Description of the vulnerability and attack vector
- Reproduction steps or proof of concept script
- Potential impact on users or host systems
- Suggested remediation if known

We will acknowledge receipt within 48 hours and provide status updates as investigation and remediation proceed.

## Security Model and Boundaries

Kantor Agent implements multiple defensive layers by design:
- Local loopback bind: the monitoring and chat server defaults strictly to `127.0.0.1`. Non-loopback binds (`0.0.0.0` or public interfaces) require explicit CLI flags.
- Chat token authentication: access to interactive chat and model inspection endpoints requires a 64-hexadecimal token stored with restricted filesystem permissions.
- Token redaction: logs, tunnel summaries, and CLI outputs redact raw tokens when binding non-loopback interfaces.
- Zero dependencies: eliminating npm supply-chain dependencies minimizes third-party injection risks.
- Process isolation: stopping or cleaning up servers guards against killing unrelated processes if PID reuse occurs.
