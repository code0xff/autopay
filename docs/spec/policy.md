# Spec: 정책 엔진 (`broker-extension/policy`)

## 1. 목적

결제 요청을 사용자 정책·사용량과 대조해 **allow / confirm / deny**를 판정하는
**순수 함수**. 프로젝트의 마지막 방어선(AGENTS.md §2). 부수효과 없음 —
저장·네트워크·시계 접근 금지(현재 시각·사용량은 인자로 주입).

**비책임**: 실제 결제 실행(executor), 사용량 집계·저장(caller), 알림(notify).

## 2. 계약

```typescript
import type { PaymentRequest, PaymentPolicy, UsageSnapshot, Decision } from "shared";

/**
 * 순수 함수. 같은 입력 → 같은 출력.
 * @param verifiedAmount executor가 체크아웃에서 독립 파싱한 실제 결제 금액.
 *        생략 시(사전 판정) amount_mismatch 검사를 건너뜀.
 */
export function evaluate(
  request: PaymentRequest,
  policy: PaymentPolicy,
  usage: UsageSnapshot,
  verifiedAmount?: number,
): Decision;
```

## 3. 판정 알고리즘 (순서 고정)

deny 검사를 먼저, 통과하면 confirm 여부를 판정한다. **여러 위반 시 아래
순서상 첫 위반**을 반환(결정적).

```
1. amount_mismatch  : verifiedAmount 주어졌고 request.totalAmount !== verifiedAmount → deny
2. method_not_allowed    : request.method ∉ policy.methods → deny
3. merchant_not_allowed  : policy.merchants.mode==="allowlist"
                           && merchant.origin ∉ origins → deny   (정확 일치 또는 와일드카드 — 아래 "머천트 와일드카드" 참조. UI 기본 오리진은 ui.md)
4. category_not_allowed  : 아래 "카테고리 규칙" 위반 → deny
5. over_per_transaction  : amount > limits.perTransaction → deny
6. over_count            : usage.countToday + 1 > limits.maxTransactionsPerDay → deny
7. over_daily            : usage.spentToday + amount > limits.daily → deny
8. over_monthly          : usage.spentThisMonth + amount > limits.monthly → deny
9. confirm 판정:
     policy.confirmation.alwaysConfirm === true            → confirm(reason:"always")
     amount > confirmation.requireUserConfirmationAbove    → confirm(reason:"threshold")
10. 그 외 → allow
```

- **amount 정의**: `verifiedAmount ?? request.totalAmount`. 즉 executor가
  검증한 금액이 있으면 그것으로, 없으면 요청 총액으로 한도 검사.
- **경계는 초과에서만 위반**: `> limit`가 위반, `=== limit`는 허용(`≤`).

### 카테고리 규칙

- `mode:"allowlist"`: 모든 item의 category가 `values`에 포함되어야 통과.
  category 미지정 item이 하나라도 있으면 위반(보수적 기본).
- `mode:"denylist"`: 어떤 item의 category라도 `values`에 포함되면 위반.
  category 미지정 item은 denylist에선 통과.

## 4. 불변식

- 정책을 위반하는 요청은 **절대 `allow`를 반환하지 않는다.** (최상위 불변식)
- 순수: 동일 `(request, policy, usage, verifiedAmount)` → 동일 `Decision`.
- 결정적: 다중 위반 시 항상 §3 순서의 첫 위반.
- `Decision`은 셋 중 하나로 완전. 예외 throw 없음(입력은 이미 스키마 검증됨 가정).

## 5. 수용 기준

- [ ] `evaluate`가 순수 함수(시계·스토리지·랜덤 접근 없음)
- [ ] §3의 각 위반·confirm·allow 경로가 테스트로 커버됨
- [ ] 경계값(=limit 허용, >limit 위반) 테스트 존재
- [ ] 다중 위반 시 순서 우선순위 테스트 존재
- [ ] 커버리지 정책 엔진 100% 목표(순수 함수라 달성 가능)

## 6. 테스트 케이스 (Vitest 명세)

기준 정책(테스트 픽스처):
```
limits: perTransaction 50_000, daily 100_000, monthly 300_000, maxTransactionsPerDay 3
merchants: allowlist ["https://shop.example"]
categories: allowlist ["keyboard","mouse"]
methods: ["kakaopay"]
confirmation: requireUserConfirmationAbove 30_000, alwaysConfirm false
```
기준 usage: `{spentToday:0, spentThisMonth:0, countToday:0}`

| # | 변경점 | 기대 |
|---|---|---|
| 1 | 기준 그대로, amount 20,000 | `allow` |
| 2 | amount 40,000 (>30k 임계) | `confirm(threshold)` |
| 3 | alwaysConfirm=true, amount 10,000 | `confirm(always)` |
| 4 | amount 60,000 (>perTx 50k) | `deny(over_per_transaction)` |
| 5 | amount 50,000 (=perTx) | `confirm(threshold)` — =perTx는 deny 아님(`>` 경계). 단 30k 임계도 초과하므로 confirm |
| 6 | merchant.origin "https://evil.example" | `deny(merchant_not_allowed)` |
| 7 | merchants.mode="any" + 위 evil origin | `allow` |
| 8 | item category "gift" (allowlist 밖) | `deny(category_not_allowed)` |
| 9 | item category 미지정 (allowlist) | `deny(category_not_allowed)` |
| 10 | categories.mode="denylist" values ["gift"], item "keyboard" | `allow` |
| 11 | method "tosspay" (policy엔 kakaopay만) | `deny(method_not_allowed)` |
| 12 | usage.countToday=3, amount 10,000 | `deny(over_count)` |
| 13 | usage.spentToday=90,000, amount 20,000 (>daily 100k) | `deny(over_daily)` |
| 14 | usage.spentToday=80,000, amount 20,000 (=daily) | `allow` (경계) |
| 15 | usage.spentThisMonth=290,000, amount 20,000 (>monthly) | `deny(over_monthly)` |
| 16 | verifiedAmount 25,000, totalAmount 20,000 | `deny(amount_mismatch)` |
| 17 | verifiedAmount 20,000, totalAmount 20,000 | `allow` |
| 18 | 다중 위반: evil origin + amount 60,000 | `deny(merchant_not_allowed)` (순서상 머천트 먼저) |
| 19 | 다중 위반: amount_mismatch + over_per_tx | `deny(amount_mismatch)` (최우선) |
| 20 | amount 30,000 (=임계) | `allow` (confirm은 `>` 경계) |
| 21 | countToday 2 (=max-1) | `allow` (횟수 경계) |
| 22 | spentThisMonth 280,000, amount 20,000 (=monthly) | `allow` (월 경계) |
| 23 | denylist, item category 미지정 | `allow` (denylist는 미지정 통과) |
| 24 | 다중 item 중 하나가 allowlist 밖 | `deny(category_not_allowed)` |
| 25 | alwaysConfirm=true + over perTx | `deny(over_per_transaction)` (confirm이 deny를 못 덮음) |
| 26 | 순수성: 입력 객체 불변 | evaluate가 request·policy·usage를 변형하지 않음 |

## 머천트 와일드카드 (2026-10-15 사용자 결정)

allowlist 항목은 정확한 https 오리진 외에 `https://*.<도메인>` 형태를 허용한다.

- 매칭: 요청 오리진이 항목과 정확히 같거나, 항목이 `https://*.D`이고 요청 오리진이 **https**이며
  호스트가 `D`(apex)이거나 `.D`로 끝날 때(중첩 서브도메인 포함). 호스트 라벨 경계로 비교하므로
  `https://evilcoupang.com`, `https://coupang.com.evil.example`은 `*.coupang.com`에 불일치. http는 거절.
- 스키마(`MerchantOriginPattern`): 선두 `*.` 한 라벨만, 그 뒤 2라벨 이상(`*.com` 같은 TLD 단독 거부),
  포트·경로·자격증명 불가, 맨 `*`·`https://*` 거부. 요청의 `merchant.origin`은 여전히 `OriginUrl`(와일드카드 불가).
- 기본값: coupay → `https://*.coupang.com`, naverpay → `https://*.naver.com`, kakaopay/tosspay → 없음.
- 결정 배경: 좁은 allowlist(도메인 3개 나열)의 마찰보다 편의를 택했다.
- **잔여 리스크**: `*.naver.com`은 `blog.naver.com`·`cafe.naver.com` 등 사용자 콘텐츠 서브도메인을 포함한다.
  머천트 allowlist가 넓어진 만큼 한도·확인·out-of-band 승인이 더 중요한 방어선이 된다.

테스트: apex·서브도메인·중첩·대소문자·lookalike·http 거절·정확 항목 유지(`engine.test.ts`).
