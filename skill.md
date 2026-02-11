# OA Skill — https://oa.1xp.vc

> Observability Agent: K8s 클러스터의 로그/이벤트/메트릭을 수집하는 읽기 전용 데이터 게이트웨이.
> 이 문서는 OA가 `GET /skill.md`로 HTTPS 서빙한다.

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

## Pod 검색

`GET /v1/pods?ns=*&q=<substring>`

- `ns`: namespace (`*` = 전체)
- `selector`: 라벨 셀렉터
- `q`: Pod 이름 부분 검색

응답: namespace, name, podIP, labels, annotations, containers[], status

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
- 절대 시간 모드에서는 logs의 `timestamps=true` 가 강제된다 (라인의 timestamp로 `[start,end]` post-filter 필요)
- K8s API만으로 `end` 컷은 불가: OA가 **라인 파싱 후 end 밖의 라인을 제거**한다

### selector 기반 (여러 Pod)
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

### 로그 라인 제외 필터 (excludePatterns)
`include.logs.excludePatterns: string[]`는 substring match로 라인을 제거한다 (grep -v 같은 동작).
timeWindow 필터링과 함께 **post-filter 단계에서 적용**된다.

예:
```json
{
  "include": {
    "logs": {
      "enabled": true,
      "tailLines": 2000,
      "previous": true,
      "timestamps": true,
      "excludePatterns": ["GET /healthz", "healthcheck"]
    }
  }
}
```

### Pod 직접 지정 (단일/특정 Pod)
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

---

## NDJSON 레코드 타입

| type | 설명 | 주요 필드 |
|------|------|-----------|
| `meta` | 번들 메타정보 | bundleId, createdAt, params |
| `log` | 컨테이너 로그 | namespace, pod, container, ts, line, previous?, skipped?, reason? |
| `event` | K8s 이벤트 | namespace, reason, message, ts, involvedObject |
| `metrics_text` | Pod 메트릭 | namespace, pod, port, path, ts, ok/skipped/error, content |

### previous 로그가 없을 때 (정상)
Pod가 재시작하지 않으면 `previous=true` 로그가 없어서 K8s가 400/404를 줄 수 있다. 이는 정상이며 bundle은 실패하면 안 된다.
OA는 이 경우 아래처럼 skip 레코드를 남길 수 있다:
```json
{"type":"log","namespace":"ns","pod":"p","container":"c","ts":"...","previous":true,"skipped":true,"reason":"no_previous_container"}
```

### 메트릭 3가지 상태
| 상태 | 의미 | 필드 |
|------|------|------|
| 성공 | scrape 정상 | `ok: true`, `content: "# HELP ..."` |
| 정상 skip | annotation 없음 (메트릭 미제공 Pod) | `skipped: true`, `reason: "annotation_missing"` |
| 실패 | annotation 있는데 접속 실패 (**⚠️ 이상 신호**) | `ok: false`, `error: "timeout after 2000ms"` |

---

## 분석 가이드 (AI Agent가 수행)

### 우선순위
1. **Events**: OOMKilled, CrashLoopBackOff, FailedScheduling
2. **Logs**: panic, fatal, segfault, timeout, connection refused
3. **Metrics**: `ok:false`는 이상 신호 (Pod 다운/네트워크 문제), `skipped:true`는 정상

### 분석 방법
- 반복 에러를 signature별로 그룹핑 + 발생 횟수
- 최초/최종 시각 기록
- 드릴다운: 좁은 selector, 단일 pod, 짧은 시간으로 후속 bundle

---

## Pod 타겟 해석 UX

| 사용자 입력 | 동작 |
|------------|------|
| "베라체인 메인넷 로그 분석해줘" | `GET /v1/pods?q=berachain-mainnet` → 매칭 Pod 전부 bundle |
| "베라체인 메인넷 0번만" | `target.pods: [{pod: "berachain-apis-mainnet-0"}]` |
| "전체 클러스터 에러 로그" | `namespace: "*"`, logs만, ERROR/WARN 클러스터링 |

---

## 기본값

| 항목 | 기본값 |
|------|--------|
| namespace | `*` (전체) |
| containers | 전부 |
| sinceSeconds | 600 (10분) |
| tailLines | 2000 |
| previous | true |
| timestamps | true (절대 시간 모드에서는 강제 true) |

## 제한

| 항목 | 값 |
|------|---|
| maxPods | 20 |
| maxTotalLogLines | 50,000 |
| sinceSecondsMax | 3,600 (1시간) |
| maxMetricsPods | 20 |
| metricsTimeoutMs | 2,000 |
| bundle TTL | 60분 후 자동 삭제 |

---

## 참고
- 항상 bundle API를 선호 (raw endpoint는 소형 디버깅용)
- 큰 시간 범위보다 여러 작은 bundle로 드릴다운
- `metrics_text`의 `ok:false`는 그 자체로 이상 신호
- `skipped:true`는 정상 (해당 Pod에 메트릭이 없음)
