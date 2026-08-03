# Hosted Provider Admission And Cost Guard

Status: implemented and PostgreSQL-verified
Last verified: 2026-07-10

## 목적

개인 self-host 사용자가 실수로 provider job을 무제한 생성하거나, 외부에 노출된 API가 인증 우회와 함께 비용을 폭증시키는 상황을 막는다. 이 guard는 모델별 입력 길이/TTS segment 제한을 대체하지 않는다. 기존 요청 크기 제한을 통과한 job에도 추가로 적용되는 coarse attempt budget이다.

## 설정

| Environment variable                | Default | 의미                                                              |
| ----------------------------------- | ------: | ----------------------------------------------------------------- |
| `PROVIDER_MAX_ACTIVE_ATTEMPTS`      |     `4` | 한 사용자에게 동시에 `queued` 또는 `running`일 수 있는 attempt 수 |
| `PROVIDER_MAX_ATTEMPTS_PER_MINUTE`  |    `60` | rolling 60초 동안 새로 승인할 attempt 수                          |
| `PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY` |  `1000` | UTC 00:00부터 다음 UTC 00:00까지 승인할 attempt 수                |

- 각 값은 0 이상의 정수만 허용한다.
- 명시적 `0`은 해당 제한만 unlimited로 만든다. 기본값이 0인 제한은 없다.
- API와 worker는 Compose에서 동일한 값을 받는다. 값을 바꾼 뒤에는 두 service를 함께 재시작한다.
- 기본 active limit은 순차 실행되는 whole-book workflow를 막지 않는다. 일일 1000 attempt를 넘는 매우 큰 작업은 `needs_review`에서 다음 UTC day 또는 관리자의 명시적 설정 변경 후 재시도한다.

## 권위 경계

`apps/server/src/services/provider-job-admission/`이 admission의 단일 권위 경계다.

1. PostgreSQL이 target logical job을 읽고 사용자별 transaction advisory lock을 획득한다.
2. 현재 attempt가 이미 있으면 같은 attempt/outbox를 재사용한다. 이 경로는 budget을 다시 소비하지 않는다.
3. `provider_job_attempts`를 사용자 단위로 집계해 active, rolling minute, UTC day 제한을 차례로 판정한다.
4. 승인되면 attempt 생성, `provider_jobs.current_attempt_id`/`attempt_count` 갱신, outbox 생성을 같은 SQL statement에서 수행한다.
5. 거절되면 attempt/outbox를 만들지 않고 logical job을 안전한 admission failure로 전환한다. 연결된 book workflow는 `needs_review`와 `provider_admission_rejected` review target을 기록한다.
6. commit 이후에만 BullMQ publish를 수행한다. publish 실패나 startup reconciliation은 기존 attempt/outbox를 재사용하므로 budget을 두 번 소비하지 않는다.

제한은 logical job 수가 아니라 실제 승인된 attempt 수를 센다. 따라서 failed/cancelled job의 retry가 새 attempt를 만들면 minute/day budget을 다시 소비한다.

## API 계약

직접 analysis/TTS job endpoint와 workflow start/retry endpoint는 admission 거절 시 HTTP 429를 반환한다.

```json
{
  "error": "provider_job_admission_rejected",
  "code": "provider_job_admission_rejected",
  "limit": "attempts_per_minute",
  "retryAfterSeconds": 37
}
```

- `limit`은 `active_attempts`, `attempts_per_minute`, `attempts_per_utc_day` 중 하나다.
- 시간 경계가 계산 가능한 minute/day 제한은 `Retry-After` header와 `retryAfterSeconds`를 함께 반환한다.
- active attempt 종료 시간은 알 수 없으므로 active 제한에는 retry 시간이 생략될 수 있다.
- 응답, DB progress, workflow review target에는 raw SQL/provider response/API key가 들어가지 않는다.

## Workflow 복구

admission에 막힌 child job은 provider 호출 전에 `failed`가 되고 workflow는 `needs_review`로 이동한다. `workflowReviewTargets`에는 stage, plan item, provider job id, 제한 종류, 안전한 error code, 가능한 retry 시간이 저장된다. worker advancement는 이 상태에서 다음 child job을 만들지 않는다.

사용자는 active attempt가 끝나거나 minute/day budget이 회복된 뒤 기존 workflow retry endpoint를 사용한다. retry는 같은 logical job을 `queued`로 되돌리지만 새 attempt가 승인되므로 정상적으로 budget을 소비한다.

## 검증

- 실제 PostgreSQL: replica 동시 admission, active count, duplicate idempotency, rolling-minute expiry, UTC-day rollover, retry accounting, workflow review persistence.
- Route: analysis job/TTS resolve/workflow retry의 안전한 429와 `Retry-After`.
- Queue: attempt-specific BullMQ id, outbox-before-publish, startup reconciliation과 retained attempt 재사용.
- Static deploy: `.env.example`, API/worker Compose 환경의 세 제한값 일치.

운영 확인 명령:

```bash
pnpm --filter server build
pnpm check:hosted
pnpm check:server:production
pnpm test -- apps/server/src/db/migrate.integration.test.ts
```
