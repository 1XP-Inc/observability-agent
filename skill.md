# OA Skill — https://oa.1xp.vc

> Observability Agent: 로그/이벤트/메트릭을 수집하는 읽기 전용 데이터 게이트웨이.
> K8s 클러스터와 bare metal/VM 서버(standalone) 모두 지원.
> 이 문서는 OA가 `GET /skill.md`로 HTTPS 서빙한다.

## 운영 모드

OA는 두 가지 모드로 동작한다. `KUBERNETES_SERVICE_HOST` 환경 변수 유무로 자동 감지.

| 모드 | 감지 조건 | 대상 | 로그 소스 | 이벤트 | 메트릭 소스 |
|------|-----------|------|-----------|--------|-------------|
| **K8s** | `KUBERNETES_SERVICE_HOST` 있음 | Pod (namespace/selector) | K8s container logs API | K8s Events | Pod annotation 기반 scrape |
| **Standalone** | `KUBERNETES_SERVICE_HOST` 없음 | Service (`OA_SERVICES` 설정) | 파일 tail | 없음 | 지정 URL 직접 scrape |

## Base
- **URL**: `https://oa.1xp.vc`
- **Auth**: `Authorization: Bearer <JWT>` (모든 요청에 필수)

## Auth/JWT
OA는 JWT를 **HS256 shared secret**으로 검증한다.
- `OA_JWT_SECRET` (필수, HS256 shared secret)

JWT 규칙:
- 알고리즘: **HS256**
- `exp` 클레임 **필수** (권장 5~15분)
- JWT 없거나 유효하지 않으면 → **401**

> **Client(AI Agent)는 `OA_JWT_SECRET`(ENV)으로 HS256 JWT를 직접 서명하여 요청한다.**
> 시크릿은 런타임 메모리에서만 사용하며, 로그/파일/출력에 절대 노출 금지.
---

## Primary Workflow (bundle-first)

1. **번들 생성**: `POST /v1/bundles`
2. **상태 폴링**: `GET /v1/bundles/{bundleId}` — `done`이 될 때까지 1~2초 간격, 최대 30초
3. **다운로드**: `GET /v1/bundles/{bundleId}/download` → `ndjson.gz`
4. **분석**: NDJSON 스트리밍 파싱 후 AI가 분석

---

## 타겟 검색

### K8s 모드: Pod 검색

`GET /v1/pods?ns=*&q=<substring>`

- `ns`: namespace (`*` = 전체)
- `selector`: 라벨 셀렉터
- `q`: Pod 이름 부분 검색

응답: namespace, name, podIP, labels, annotations, containers[], status

### Standalone 모드: 서비스 목록

`GET /v1/services`

등록된 서비스 목록을 반환한다. `OA_SERVICES` ENV로 설정된 서비스들.

응답 예시:
```json
{
  "items": [
    { "name": "solana-validator", "logs": ["/var/log/solana/validator.log"], "metrics": "http://localhost:9090/metrics" },
    { "name": "rpc-node", "logs": ["/var/log/solana/rpc.log"], "metrics": null }
  ]
}
```

---

## Bundle 요청

### timeWindow (상대/절대 시간)
OA는 두 가지 시간 윈도우를 지원한다. 둘 중 하나만 사용 가능.

1) 상대 시간:
```json
{ "timeWindow": { "sinceSeconds": 600 } }
```

2) 절대 시간 (UTC, ISO8601Z):
```json
{
  "timeWindow": {
    "start": "2026-02-09T00:00:00Z",
    "end": "2026-02-09T00:10:00Z"
  }
}
```

규칙:
- `sinceSeconds` 와 `start/end` 를 동시에 쓰면 400
- 절대 시간 모드에서 OA는 **라인 파싱 후 범위 밖의 라인을 제거**한다

### K8s 모드: selector 기반 (여러 Pod)
```json
{
  "timeWindow": { "sinceSeconds": 600 },
  "target": {
    "namespace": "*",
    "selector": "app=validator,chain=bera"
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

### K8s 모드: Pod 직접 지정 (단일/특정 Pod)
```json
{
  "timeWindow": { "sinceSeconds": 600 },
  "target": {
    "pods": [
      { "namespace": "default", "pod": "berachain-apis-mainnet-0" }
    ]
  },
  "include": {
    "logs": { "enabled": true, "tailLines": 2000, "previous": true, "timestamps": true },
    "events": { "enabled": true },
    "metrics": { "enabled": true }
  }
}
```

> `selector`와 `pods[]`는 둘 중 하나만 사용. 둘 다 → 400.

### Standalone 모드: 서비스 기반
```json
{
  "timeWindow": { "sinceSeconds": 600 },
  "target": {
    "kind": "services",
    "services": ["solana-validator", "rpc-node"]
  },
  "include": {
    "logs": { "enabled": true, "tailLines": 2000, "excludePatterns": ["healthcheck"] },
    "metrics": { "enabled": true }
  },
  "limits": {
    "maxTotalLogLines": 50000,
    "metricsTimeoutMs": 2000
  }
}
```

Standalone 규칙:
- `target.services`는 `OA_SERVICES`에 등록된 서비스 이름 배열 (필수)
- `kind`는 `"services"` (services 배열이 있으면 자동 추론)
- `events`는 standalone에서 지원하지 않음
- `previous`, `timestamps` 옵션 없음 (파일 tail은 항상 최신 N줄)
- 로그는 서비스별 설정된 파일 경로에서 tail 수집

### 로그 라인 제외 필터 (excludePatterns)
`include.logs.excludePatterns: string[]`는 substring match로 라인을 제거한다 (grep -v 같은 동작).
timeWindow 필터링과 함께 **post-filter 단계에서 적용**된다. K8s와 standalone 모두 동일.

예:
```json
{
  "include": {
    "logs": {
      "enabled": true,
      "tailLines": 2000,
      "excludePatterns": ["GET /healthz", "healthcheck"]
    }
  }
}
```

---

## NDJSON 레코드 타입

### 공통 레코드

| type | 설명 | 주요 필드 |
|------|------|-----------|
| `meta` | 번들 메타정보 | bundleId, createdAt, params |

### K8s 모드 레코드

| type | 설명 | 주요 필드 |
|------|------|-----------|
| `log` | 컨테이너 로그 | namespace, pod, container, ts, line, previous?, skipped?, reason? |
| `event` | K8s 이벤트 | namespace, reason, message, ts, involvedObject |
| `metrics_text` | Pod 메트릭 | namespace, pod, port, path, ts, ok/skipped/error, content |

### Standalone 모드 레코드

| type | 설명 | 주요 필드 |
|------|------|-----------|
| `log` | 파일 로그 | service, file, ts, line, skipped?, reason? |
| `metrics_text` | 서비스 메트릭 | service, url, ts, ok/skipped/error, content |

Standalone 로그 skip 사유:
- `file_not_found`: 로그 파일이 존재하지 않음
- `read_error`: 파일 읽기 실패 (권한 등)

Standalone 메트릭 상태:

| 상태 | 의미 | 필드 |
|------|------|------|
| 성공 | scrape 정상 | `ok: true`, `content: "# HELP ..."` |
| 정상 skip | 메트릭 URL 미설정 | `skipped: true`, `reason: "no_metrics_url"` |
| 타임아웃 | 응답 시간 초과 | `ok: false`, `error: "timeout"` |
| 실패 | 접속 실패 | `ok: false`, `error: "fetch_failed"` |

### K8s previous 로그
Pod가 재시작하지 않으면 `previous=true` 로그가 없어서 K8s가 400/404를 줄 수 있다. 이는 정상이며 bundle은 실패하면 안 된다.
OA는 이 경우 아래처럼 skip 레코드를 남긴다:
```json
{"type":"log","namespace":"ns","pod":"p","container":"c","ts":"...","previous":true,"skipped":true,"reason":"no_previous_container"}
```

### K8s 메트릭 3가지 상태
| 상태 | 의미 | 필드 |
|------|------|------|
| 성공 | scrape 정상 | `ok: true`, `content: "# HELP ..."` |
| 정상 skip | annotation 없음 (메트릭 미제공 Pod) | `skipped: true`, `reason: "annotation_missing"` |
| 실패 | annotation 있는데 접속 실패 (**이상 신호**) | `ok: false`, `error: "timeout after 2000ms"` |

---

## 분석 가이드 (AI Agent가 수행)

### 우선순위
1. **Events** (K8s만): OOMKilled, CrashLoopBackOff, FailedScheduling
2. **Logs**: panic, fatal, segfault, timeout, connection refused
3. **Metrics**: `ok:false`는 이상 신호 (서비스 다운/네트워크 문제), `skipped:true`는 정상

### 분석 방법
- 반복 에러를 signature별로 그룹핑 + 발생 횟수
- 최초/최종 시각 기록
- 드릴다운: K8s에서는 좁은 selector/단일 pod, Standalone에서는 단일 서비스, 짧은 시간으로 후속 bundle

---

## 타겟 해석 UX

### K8s 모드
| 사용자 입력 | 동작 |
|------------|------|
| "베라체인 메인넷 로그 분석해줘" | `GET /v1/pods?q=berachain-mainnet` → 매칭 Pod 전부 bundle |
| "베라체인 메인넷 0번만" | `target.pods: [{pod: "berachain-apis-mainnet-0"}]` |
| "전체 클러스터 에러 로그" | `namespace: "*"`, logs만, ERROR/WARN 클러스터링 |

### Standalone 모드
| 사용자 입력 | 동작 |
|------------|------|
| "솔라나 밸리데이터 로그 분석해줘" | `GET /v1/services` → `target.services: ["solana-validator"]` |
| "전체 서비스 상태 확인" | `GET /v1/services` → 모든 서비스 이름으로 bundle |
| "rpc 노드 메트릭만 확인" | `target.services: ["rpc-node"]`, logs 비활성, metrics만 |

---

## 기본값

### 공통
| 항목 | 기본값 |
|------|--------|
| sinceSeconds | 600 (10분) |
| tailLines | 2000 |

### K8s 모드
| 항목 | 기본값 |
|------|--------|
| namespace | `*` (전체) |
| containers | 전부 |
| previous | true |
| timestamps | true (절대 시간 모드에서는 강제 true) |

## 제한

### 공통
| 항목 | 값 |
|------|---|
| maxTotalLogLines | 50,000 |
| sinceSecondsMax | 3,600 (1시간) |
| metricsTimeoutMs | 2,000 |
| bundle TTL | 60분 후 자동 삭제 |

### K8s 모드
| 항목 | 값 |
|------|---|
| maxPods | 20 |
| maxMetricsPods | 20 |

---

## Standalone 설정

Standalone 모드는 `OA_SERVICES` ENV로 서비스를 정의한다:

```bash
export OA_JWT_SECRET="..."
export OA_SERVICES='[
  {"name":"solana-validator","logs":["/var/log/solana/validator.log"],"metrics":"http://localhost:9090/metrics"},
  {"name":"rpc-node","logs":["/var/log/solana/rpc.log"]}
]'
pm2 start dist/index.js
```

서비스 정의 필드:
| 필드 | 필수 | 설명 |
|------|------|------|
| `name` | O | 서비스 이름 (고유) |
| `logs` | X | 수집할 로그 파일 경로 배열 |
| `metrics` | X | Prometheus 메트릭 URL |

---

## 참고
- 항상 bundle API를 선호 (raw endpoint는 소형 디버깅용)
- 큰 시간 범위보다 여러 작은 bundle로 드릴다운
- `metrics_text`의 `ok:false`는 그 자체로 이상 신호
- `skipped:true`는 정상 (해당 서비스/Pod에 메트릭이 없음)
