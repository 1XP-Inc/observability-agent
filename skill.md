# OA Skill

> Observability Agent: read-only data gateway for logs, events, and metrics.
> Supports both K8s clusters and bare metal/VM servers (standalone mode).
> This document is served by OA at `GET /skill.md`.

## Operating Modes

OA runs in one of two modes, auto-detected by the presence of `KUBERNETES_SERVICE_HOST`.

| Mode | Detection | Targets | Log Source | Events | Metrics Source |
|------|-----------|---------|------------|--------|----------------|
| **K8s** | `KUBERNETES_SERVICE_HOST` present | Pods (namespace/selector) | K8s container logs API | K8s Events | Pod annotation-based scrape |
| **Standalone** | `KUBERNETES_SERVICE_HOST` absent | Services (`OA_SERVICES` env) | File tail + journalctl | None | Direct URL scrape |

## Base
- **Auth**: `Authorization: Bearer <JWT>` (required on protected API requests)
- **No-auth endpoints**: `/healthz`, `/livez`, `/readyz`, `/skill.md`, `/.well-known/skill.md`

## Auth/JWT
OA verifies JWTs using an **HS256 shared secret**.
- `OA_JWT_SECRET` (required, HS256 shared secret, min 32 chars)

JWT rules:
- Algorithm: **HS256**
- `exp` claim **required** (recommended 5–15 min)
- Missing or invalid JWT → **401**
- Scoped JWT missing namespace/service/capability scope → **403**

> **The client (AI Agent) signs an HS256 JWT using `OA_JWT_SECRET` (env) and sends it with each request.**
> The secret is used only in runtime memory — never expose it in logs, files, or output.

Authorization claims:
```json
{
  "sub": "agent-01",
  "allowedNamespaces": ["prod", "monitoring"],
  "allowedServices": ["validator-*"],
  "capabilities": ["pods", "logs", "events", "metrics"],
  "admin": false
}
```

- K8s pod discovery requires `pods` capability and namespace scope.
- K8s namespace scopes support exact names and `*` wildcards; `allowedNamespaces: ["*"]` permits all namespaces and `ns=*`.
- K8s selector bundles require `pods` capability because selector targeting performs pod discovery internally.
- Bundle create/status/download enforce the bundle target scope and requested capabilities.
- Standalone `allowedServices` entries can use `*` wildcards; `allowedServices: ["*"]` permits all configured services.
- Non-admin discovery responses are redacted.
- Legacy JWTs with no authorization scope claims keep full access for compatibility.
---

## Primary Workflow (bundle-first)

1. **Create bundle**: `POST /v1/bundles`
2. **Poll status**: `GET /v1/bundles/{bundleId}` — every 1–2 s, up to 30 s until `done`
3. **Download**: `GET /v1/bundles/{bundleId}/download` → `ndjson.gz`
4. **Analyze**: stream-parse NDJSON, then AI analyzes

---

## Target Discovery

### K8s Mode: Pod Search

`GET /v1/pods?ns=<namespace>&q=<substring>`

- `ns`: namespace (`*` = all namespaces; requires admin or `allowedNamespaces: ["*"]`)
- `selector`: label selector
- `q`: pod name substring search

Response: namespace, name, labels, containers[], ready, phase. Admin responses also include podIP, annotations, and nodeName.

### Standalone Mode: Service List

`GET /v1/services`

Returns registered services configured via `OA_SERVICES` env, filtered by JWT service scope.

Admin response example:
```json
{
  "items": [
    { "name": "solana-validator", "logs": ["/var/log/solana/validator.log"], "journal": null, "metrics": "http://localhost:9090/metrics" },
    { "name": "rpc-node", "logs": ["/var/log/solana/rpc.log"], "journal": null, "metrics": null }
  ]
}
```

---

## Bundle Request

### timeWindow (relative / absolute)
OA supports two time window modes. Use only one at a time. In standalone mode, `timeWindow` is a journal-only selector.

1) Relative:
```json
{ "timeWindow": { "sinceSeconds": 600 } }
```

2) Absolute (UTC, ISO8601Z):
```json
{
  "timeWindow": {
    "start": "2026-02-09T00:00:00Z",
    "end": "2026-02-09T00:10:00Z"
  }
}
```

Rules:
- Using both `sinceSeconds` and `start/end` → 400
- In standalone mode, time windows apply only to journal sources; file sources use `tailLines`

### K8s Mode: selector-based (multiple Pods)
```json
{
  "timeWindow": { "sinceSeconds": 600 },
  "target": {
    "namespace": "*",
    "selector": "app=web,tier=backend"
  },
  "include": {
    "logs": { "enabled": true, "tailLines": 2000, "previous": true, "timestamps": true },
    "events": { "enabled": true },
    "metrics": { "enabled": true }
  },
  "limits": {
    "maxPods": 20,
    "maxTotalLogLines": 50000,
    "metricsTimeoutMs": 2000
  }
}
```

### K8s Mode: direct Pod targeting (single/specific Pods)
```json
{
  "timeWindow": { "sinceSeconds": 600 },
  "target": {
    "pods": [
      { "namespace": "default", "pod": "my-app-pod-0" }
    ]
  },
  "include": {
    "logs": { "enabled": true, "tailLines": 2000, "previous": true, "timestamps": true },
    "events": { "enabled": true },
    "metrics": { "enabled": true }
  }
}
```

> `selector` and `pods[]` are mutually exclusive. Providing both → 400.

### Standalone Mode: service-based
```json
{
  "target": {
    "kind": "services",
    "services": ["solana-validator", "rpc-node"]
  },
  "include": {
    "logs": { "enabled": true, "tailLines": 2000, "includePatterns": ["ERROR"], "excludePatterns": ["healthcheck"] },
    "metrics": { "enabled": true }
  },
  "limits": {
    "maxTotalLogLines": 50000,
    "metricsTimeoutMs": 2000
  }
}
```

Standalone rules:
- Use `target.kind: "services"` with a required `target.services` array of names registered in `OA_SERVICES`, or `target.kind: "all"` for every registered service
- `kind` is `"services"` when a services array is present and no explicit kind is supplied
- `events` is ignored in standalone requests
- `previous` and `timestamps` are ignored in standalone requests
- File logs are collected via `tail -n <include.logs.tailLines>` from paths configured per service
- Journal logs are collected via `journalctl`; they use `timeWindow` when supplied, otherwise `include.logs.tailLines`
- When logs are enabled, `timeWindow` is accepted only when selected standalone services include a configured journal source; file logs are never time-filtered
- OA applies include/exclude filters before the final `maxTotalLogLines`, then globally merges matching records by parsed timestamp. Untimestamped records inherit the previous timestamp seen from the same source for ranking, or source read order when no previous source timestamp exists
- Clients cannot request arbitrary file paths or journal units; only registered `OA_SERVICES` entries are available
- OA uses the current process OS permissions and does not elevate privileges

Standalone log API constraints:

| Field | Applies to | Behavior |
|-------|------------|----------|
| `include.logs.tailLines` | File logs, journal logs without `timeWindow` | Passed to `tail -n` for files and `journalctl -n` for journals |
| `timeWindow.sinceSeconds` | Journal logs only | Relative journal window; rejected when logs are enabled and selected services have no journal source |
| `timeWindow.start` / `timeWindow.end` | Journal logs only | Absolute journal window; both fields required together; rejected when logs are enabled and selected services have no journal source |
| `limits.maxTotalLogLines` | All standalone logs | Final result budget after filtering and global merge |

K8s selector bundle note:
- Selector targets list matching pods internally before collecting logs/events/metrics.
- Scoped tokens therefore need both `pods` capability and the requested data-source capabilities for selector bundles.

### Log Line Filters (includePatterns / excludePatterns)
`include.logs.includePatterns: string[]` keeps only lines containing at least one substring (like `grep`).
`include.logs.excludePatterns: string[]` removes lines by substring match (like `grep -v`).
Standalone applies include/exclude filters before the final `maxTotalLogLines` budget. `includePatterns` is standalone-only; `excludePatterns` also works in K8s mode.

Example:
```json
{
  "include": {
    "logs": {
      "enabled": true,
      "includePatterns": ["ERROR", "panic"],
      "excludePatterns": ["GET /healthz", "healthcheck"]
    }
  }
}
```

---

## NDJSON Record Types

### Common Records

| type | Description | Key Fields |
|------|-------------|------------|
| `meta` | Bundle metadata | bundleId, createdAt, params |

### K8s Mode Records

| type | Description | Key Fields |
|------|-------------|------------|
| `log` | Container log | namespace, pod, container, ts, line, previous?, skipped?, reason? |
| `event` | K8s event | namespace, reason, message, ts, involvedObject |
| `metrics_text` | Pod metrics | namespace, pod, port, path, ts, ok/skipped/error, content |

### Standalone Mode Records

| type | Description | Key Fields |
|------|-------------|------------|
| `log` | File log | service, file, ts, line, skipped?, reason? |
| `log` | Journal log | service, journal, journalScope?, journalUser?, ts, line, skipped?, reason? |
| `log_error` | User journal error | service, journal, journalScope, journalUser, ts, reason, error |
| `log_summary` | Log budget/source summary | ts, lineLimited, matchedLogRecords, returnedLogRecords, sources[] |
| `metrics_text` | Service metrics | service, url, ts, ok/skipped/error, content |

Standalone log skip reasons:
- `file_not_found`: log file does not exist
- `read_error`: file read failed (permissions, etc.)
- `journalctl_not_found`: journalctl binary not found
- `journal_permission_denied`: journalctl reported insufficient journal permissions
- `journal_read_error`: journalctl execution failed (permissions, etc.)

Standalone metrics status:

| Status | Meaning | Fields |
|--------|---------|--------|
| Success | Scrape OK | `ok: true`, `content: "# HELP ..."` |
| Normal skip | No metrics URL configured | `skipped: true`, `reason: "no_metrics_url"` |
| Timeout | Response timed out | `ok: false`, `error: "timeout after 2000ms"` |
| Failure | Connection failed | `ok: false`, `error: "fetch_failed: ECONNREFUSED"` |

### K8s Previous Logs
If a pod has not restarted, `previous=true` logs may not exist and K8s may return 400/404. This is normal and must not fail the bundle.
OA writes a skip record in this case:
```json
{"type":"log","namespace":"ns","pod":"p","container":"c","ts":"...","previous":true,"skipped":true,"reason":"no_previous_container"}
```

### K8s Metrics — 3 States
| Status | Meaning | Fields |
|--------|---------|--------|
| Success | Scrape OK | `ok: true`, `content: "# HELP ..."` |
| Normal skip | No annotation (pod does not expose metrics) | `skipped: true`, `reason: "annotation_missing"` |
| Failure | Annotation present but connection failed (**anomaly signal**) | `ok: false`, `error: "timeout after 2000ms"` |

---

## Analysis Guide (for AI Agents)

### Priority
1. **Events** (K8s only): OOMKilled, CrashLoopBackOff, FailedScheduling
2. **Logs**: panic, fatal, segfault, timeout, connection refused
3. **Metrics**: `ok:false` is an anomaly signal (service down / network issue), `skipped:true` is normal

### Analysis Method
- Group recurring errors by signature + count occurrences
- Record first/last occurrence timestamps
- Drill down: in K8s use narrower selector / single pod; in standalone use single service, lower `tailLines`, or a shorter journal `timeWindow`

---

## Target Interpretation UX

### K8s Mode
| User Input | Action |
|------------|--------|
| "Analyze backend logs" | `GET /v1/pods?q=backend` → bundle all matching pods |
| "Only my-app pod 0" | `target.pods: [{namespace: "default", pod: "my-app-pod-0"}]` |
| "All cluster error logs" | `namespace: "*"`, logs only, cluster ERROR/WARN |

### Standalone Mode
| User Input | Action |
|------------|--------|
| "Analyze solana validator logs" | `GET /v1/services` → `target.services: ["solana-validator"]` |
| "Check all service status" | `target.kind: "all"` |
| "Only rpc-node metrics" | `target.services: ["rpc-node"]`, logs disabled, metrics only |

---

## Defaults

### K8s Mode
| Field | Default |
|-------|---------|
| sinceSeconds | 600 (10 min) |
| tailLines | 2000 |
| namespace | `*` (all) |
| containers | all |
| previous | true |
| timestamps | true (forced true in absolute time mode) |

### Standalone Mode
| Field | Default |
|-------|---------|
| timeWindow | none (journal sources use `tailLines` unless requested) |
| tailLines | 2000 |

## Limits

### Common
| Field | Value |
|-------|-------|
| maxTotalLogLines | 50,000 |
| sinceSecondsMax | 3,600 (1 hour) |
| metricsTimeoutMs | 2,000 |
| bundle TTL | 60 min auto-delete |

### K8s Mode
| Field | Value |
|-------|-------|
| maxPods | 20 |
| maxMetricsPods | 20 |

---

## Standalone Configuration

Standalone mode defines services via the `OA_SERVICES` env:

```bash
export OA_JWT_SECRET="replace-with-at-least-32-random-chars"
export OA_SERVICES='[
  {"name":"solana-validator","logs":["/var/log/solana/validator.log"],"metrics":"http://localhost:9090/metrics"},
  {"name":"rpc-node","logs":["/var/log/solana/rpc.log"]}
]'
node dist/index.js
```

Service definition fields:
| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique service identifier |
| `logs` | No | Array of log file paths to collect |
| `journal` | No | systemd unit name (journalctl log collection) |
| `journalScope` | No | `system` (default) or `user` |
| `journalUser` | No | Username or UID required when `journalScope` is `user` |
| `metrics` | No | Prometheus metrics URL |

Standalone permission model:
- File and journal readability depends on the OS permissions of the OA process.
- OA does not create users, join system groups, run sudo, or bypass systemd journal permissions.
- Full system and user journal visibility is possible only when the existing process account can already read those journals.
- User journal permission and `journalUser` resolution failures are emitted as `log_error` records instead of empty log output.
- Metrics URLs are operator-provided trusted configuration and may point at localhost or private networks for compatibility.

Standalone time windows:
- File log requests read the latest configured line budget with `tail`; `sinceSeconds` and absolute windows do not seek or filter file contents.
- Journal requests use either `timeWindow` (`--since`/`--until`) or the configured line budget, not both.
- `timeWindow` on a standalone request is rejected when logs are enabled and the selected services have no configured journal source.

---

## Notes
- Always prefer the bundle API (raw endpoints are for small-scale debugging)
- Use multiple smaller bundles to drill down rather than one large time range
- `metrics_text` with `ok:false` is an anomaly signal by itself
- `skipped:true` is normal (the service/pod does not expose metrics)
