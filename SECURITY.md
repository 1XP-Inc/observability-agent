# Security Policy

## Supported Versions

OA is currently pre-1.0. Security fixes are provided for the latest `0.1.x`
release line and the `main` branch.

| Version | Supported |
| ------- | --------- |
| `0.1.x` | Yes |
| `< 0.1` | No |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories:

https://github.com/1XP-Inc/observability-agent/security/advisories/new

Do not open a public issue with exploit details, tokens, logs, or private
infrastructure information. Include a concise description, affected version or
commit, reproduction steps, impact, and any suggested mitigation.

## Security Notes

- OA is a read-only gateway for target systems, but bundle artifacts contain
  copied logs and metrics and should be treated as sensitive.
- JWTs use HS256 shared-secret verification and require an `exp` claim. Keep
  `OA_JWT_SECRET` at least 32 random characters and rotate it if exposed.
- JWT authorization claims limit namespace, service, and data-source access.
  Use `admin: true` only for trusted operators because it permits cluster-wide
  pod discovery and bypasses scope checks.
- JWTs without authorization scope claims retain full access for compatibility
  with existing deployments. Issue scoped tokens with `admin: false`,
  `capabilities`, and namespace/service allowlists to opt into least privilege.
- `OA_TRUST_PROXY=true` trusts all forwarded IP headers. Use a concrete trusted
  proxy address or CIDR when the listener is reachable by clients.
- Standalone file, journal, and metrics sources are operator-configured through
  `OA_SERVICES`. OA does not block private network metrics URLs or elevate OS
  permissions for logs.
- K8s access is bounded by the service account RBAC granted to the process.
