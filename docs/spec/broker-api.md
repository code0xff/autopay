# Spec: 브로커 API (`shared` + `broker-extension/background`)

## 1. 목적

에이전트(Untrusted) ↔ 브로커(Trusted) 사이의 **유일한 통신 채널**. 에이전트가
호출 가능한 표면은 여기 정의된 것이 전부이며, **비밀·빌링키·세션정보를
반환하는 경로가 없다**(AGENTS.md §4). 모든 인바운드 메시지는 Zod로 검증하고
실패 시 거절.

**비책임**: 판정(policy), 실행(executor). background는 라우팅·검증·오케스트레이션만.

## 2. 계약

### 2.1 전송 계층

- **MVP 전송 = 두뇌 내장(①)**: 두뇌 모듈이 브로커 코어를 **동일한 도구
  인터페이스**로 내부 호출한다(`spec/agent-integration.md §5`). 이 API 계약은
  전송과 무관하게 동일하다.
- **격리 강화 시 = MCP/스킬(③)**: 같은 계약을 MCP로 노출하면 외부 두뇌(Claude
  Code/Codex)가 페이지 직접 접근 없이 호출한다(AGENTS §2.6이 우선하는 목표).
  브라우저-익스텐션 메시징(`externally_connectable`)도 이 계약을 재사용.
- 외부 전송(③/메시징) 사용 시 인바운드마다 **발신자 검증**: MCP는 Native Host
  인증, 익스텐션 메시징은 발신 extension ID allowlist. 검증 실패 = 처리 거부.

### 2.2 메서드 (요청/응답 스키마)

```typescript
import { z } from "zod";
import { PaymentRequest, PaymentResult, PaymentMethod } from "shared";

// requestPayment: 결제 실행 "요청"만. 비밀 접근 아님.
export const RequestPaymentReq = PaymentRequest;
export const RequestPaymentRes = z.object({ requestId: z.string() });

// getPaymentResult: 요약·사유만 반환
export const GetPaymentResultReq = z.object({ requestId: z.string() });
export const GetPaymentResultRes = PaymentResult;

// getPolicySummary: 에이전트가 헛수고 않도록 "요약"만 (정책 원문·비밀 미노출)
export const GetPolicySummaryReq = z.object({});
export const GetPolicySummaryRes = z.object({
  remainingDailyBudget: z.number().int().nonnegative(),
  remainingCountToday: z.number().int().nonnegative(),
  allowedCategories: z.array(z.string()),
  allowedMerchants: z.union([z.array(z.string().url()), z.literal("any")]),
  allowedMethods: z.array(PaymentMethod),   // coupay 포함 — shared 단일 enum
});
```

### 2.2.1 confirm 해소 (내부 인터페이스)

UI(Side Panel)의 [승인]/[거절]과 confirm 타임아웃이 오케스트레이션을 재개/취소한다.
에이전트에 노출되지 않는 내부 계약이다.

```typescript
// UI → background. requestId의 pending confirm을 해소.
resolveConfirmation(requestId: string, approved: boolean): Promise<void>;
```
- `approved:true` → 실행(5단계)으로 진행.
- `approved:false` → PaymentResult=canceled(reason:"user_declined"), audit(canceled).
- **confirm 타임아웃**(기본 5분, 정책화 가능) → canceled(reason:"confirm_timeout").

### 2.3 오케스트레이션 (requestPayment 처리 흐름)

```
1. safeParse(RequestPaymentReq) 실패 → 거절(스키마 오류), audit(rejected)
2. requestId 발급, 상태 pending 저장
3. executor.verify(checkoutTabId) → { verifiedAmount, snapshot } (독립 파싱)
     snapshot = 결제 대상 핵심 필드 해시. 사용자에게 보여주고 승인받는 대상.
4. usage = audit.usageFor(now)   ← 정책 입력용 사용량 스냅샷 산출(주입)
5. policy.evaluate(req, policy, usage, verifiedAmount)
     - deny  → result=rejected(violation), audit(rejected), (설정 시) notify
     - confirm → result=pending_user_confirmation, notify(confirm_required),
                 UI 확인 대기. resolveConfirmation()으로 재개(§2.2.1):
                   승인 → 6단계 / 거절·타임아웃 → canceled, audit(canceled)
     - allow → 6
     ※ adapter.hasExternalApproval=false(쿠팡)면 정책 confirm 규칙을 보수적으로
       적용(외부 게이트 없음 — executor.md).
6. executor.pay({..., approvedSnapshot: snapshot}) → 실행 직전 재검증
     (현재 스냅샷 ≠ approvedSnapshot이면 결제 안 하고 canceled — TOCTOU 방어,
      executor.md §2.1). 일치 시 (패턴 B)폰 푸시/(패턴 C)클릭 → 완료 독립 파싱
     PayOutcome → PaymentResult 매핑:
       approved → usage 반영은 audit(approved) 기록으로(=usageFor 근거), notify(completed)
       canceled → canceled(phone_declined), audit(canceled), notify
       timeout  → failed(error:"timeout"), audit(timeout), notify
       failed   → failed(error), audit(failed), notify
7. 에이전트는 getPaymentResult(requestId)로 요약만 수신
```

## 3. 불변식

- 에이전트에 노출되는 응답 어디에도 비밀·빌링키·세션·정책 원문이 없다.
- 검증되지 않은 인바운드는 신뢰 영역에 진입하지 못한다(safeParse 게이트).
- `getPolicySummary`는 잔여 예산·허용 목록 "요약"만. 한도 원문 수치 외
  민감정보 없음.
- 발신자 검증을 통과하지 못한 호출은 어떤 부수효과도 만들지 않는다.

## 4. 수용 기준

- [ ] 세 메서드의 요청/응답 스키마가 `shared`에 존재
- [ ] background가 각 인바운드를 safeParse로 검증 후에만 처리
- [ ] 발신자 검증 훅이 존재하고 실패 시 거부
- [ ] requestPayment 오케스트레이션이 §2.3 순서를 따름(통합 테스트)
- [ ] 응답에 비밀/빌링키 없음(리뷰 + grep)

## 5. 테스트 케이스

1. 잘못된 요청(스키마 위반) → 거절, 부수효과 없음, audit(rejected)
2. 미검증 발신자(외부 전송) → 거부, 부수효과 없음
3. deny 판정 → result=rejected(violation), notify(설정 시)
4. confirm 판정 → pending_user_confirmation; resolveConfirmation(true) → 실행 진행
5. confirm 거절: resolveConfirmation(false) → canceled(user_declined)
6. confirm 타임아웃 → canceled(confirm_timeout)
7. allow → executor 호출, 성공 시 approved + audit(approved) 기록(usageFor 반영)
8. executor timeout → PaymentResult=failed(error:"timeout"), audit(timeout)
9. executor canceled(폰 거절) → canceled(phone_declined)
10. 승인 후 대기 중 결제 대상 변경 → 실행 직전 재검증 불일치 → 결제 안 됨(canceled)
11. getPolicySummary → 잔여 예산/횟수/허용목록(coupay 포함)만, 비밀 없음
