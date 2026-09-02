# 아키텍처 (System View)

> 시스템을 한 장으로 보는 문서. **왜(결정)** 는 `AGENTS.md`, **모듈 계약** 은
> `docs/spec/*.md`. 이 문서는 **조각이 어떻게 맞물리는가**(런타임·데이터흐름·
> 상태·배포)를 다루고 상세는 아래로 링크한다.

## 1. 컨텍스트 (누가 관여하나)

```
 사용자 ──명령/정책설정──▶ AutoPay ──조작──▶ 쇼핑몰/결제사 웹
   ▲                         │
   └────결제 통지/확인────────┘
                    최종 승인(패턴 B): 사용자 폰(결제사 앱)
```

- **신뢰 안 함**: 쇼핑몰/결제사 웹페이지(프롬프트 인젝션 원천), 에이전트 두뇌.
- **신뢰함**: 브로커 코어(policy/executor/audit/notify).
- 근거·신뢰경계: `AGENTS.md §2, §2.6`.

## 2. 컨테이너 (실행 단위)

MVP는 단일 크롬 익스텐션(MV3) + 공용 스키마 패키지.

```
pnpm workspace
├─ packages/shared              # Zod 스키마·타입 (경계의 단일 진실)
└─ packages/broker-extension    # MV3 익스텐션
   ├─ background (service worker)   ← 두뇌 모듈 + 코어 오케스트레이션
   ├─ content scripts              ← "손"(DOM 조작): navigate/read/click/fill
   ├─ side panel (React)           ← 주 콘솔: 활동·승인(confirm)·감시 (우측 도킹)
   ├─ options page (React)         ← 정책·프로필·감사 로그 (전체 탭)
   └─ chrome.notifications         ← 완료/거절 OS 알림 (action popup 미사용)
후속: packages/mcp-server (두뇌 외부화 ③), packages/agent-skill
```

- 스택·버전: `docs/stack.md`. 제어/두뇌 부착 방식: `docs/spec/agent-integration.md`.

## 3. 컴포넌트 (broker-extension 내부)

```
background (service worker)
  ├─ AgentLoop(두뇌)   ── BrokerTools 인터페이스로만 코어 접근 ──┐
  ├─ BrokerAPI         결제 요청 라우팅·검증·오케스트레이션        │
  ├─ PolicyEngine      (request,policy,usage,verifiedAmount)→decision (순수)
  ├─ Executor          SimplePayAdapter: KakaoAdapter/CoupayAdapter/TossAdapter
  ├─ WatchEngine       지정가 감시(alarms) → 조건 충족 시 requestPayment 트리거
  ├─ RefStore          PII·빌링키 참조 암호화 저장(executor 전용 복호화)
  ├─ AuditLog          추가 전용 기록 + usageFor 집계
  └─ Notifier          chrome.notifications (+선택 채널)
content scripts        페이지 직렬화·DOM 실행 (Executor/AgentLoop의 손)
```

| 컴포넌트 | 신뢰 | 스펙 |
|---|---|---|
| AgentLoop(두뇌) | Untrusted | `spec/agent-integration.md` |
| BrokerAPI | 경계 | `spec/broker-api.md` |
| PolicyEngine | Trusted | `spec/policy.md` |
| Executor | Trusted | `spec/executor.md` |
| WatchEngine | Trusted | `spec/watch.md` |
| RefStore | Trusted | `spec/refstore.md` |
| AuditLog | Trusted | `spec/audit.md` |
| Notifier | Trusted | `spec/notify.md` |
| 공용 스키마 | 경계 | `spec/data-model.md` |
| 권한/매니페스트 | — | `spec/manifest.md` |

## 4. 런타임 데이터 흐름 (결제 1건)

```
두뇌(AgentLoop) ──BrokerTools.requestPayment(req)──▶ BrokerAPI
  BrokerAPI: safeParse(req)  [실패→reject+audit]
  Executor.verify(tab) ─▶ verifiedAmount
  PolicyEngine.evaluate(req, policy, usage, verifiedAmount)
     ├ deny    ─▶ result=rejected(violation), audit, notify(설정 시)
     ├ confirm ─▶ Side Panel 승인 요청 → resolveConfirmation (패턴 C·임계값 초과)
     └ allow   ─▶ Executor.pay(...)
                    ├ 패턴 B: 식별정보 입력→폰 푸시→폰 승인 대기→완료 파싱
                    └ 패턴 C: [결제하기] 클릭→완료 파싱 (외부게이트 없음)
  성공 ─▶ usage 갱신, audit(approved), Notifier.completed
두뇌 ◀──getPaymentResult(id): 요약만(비밀 없음)──
```

- 상세 순서: `spec/broker-api.md §2.3`. 패턴 정의: `AGENTS.md §2.5`.
- **금액 독립 검증**: 에이전트 주장 금액이 아니라 Executor가 파싱한
  `verifiedAmount`로 정책 판정(위조 방지).

## 5. 상태 / 저장소

| 데이터 | 위치 | 비고 |
|---|---|---|
| 감사 로그 | `chrome.storage.local` | 추가 전용. usage 집계 근거 (`spec/audit.md`) |
| 정책 | `chrome.storage.local` | 옵션 페이지에서 사용자 편집 |
| 감시 항목(watch) | `chrome.storage.local` | 지정가 감시 스펙 (`spec/watch.md`) |
| 사용자 프로필(PII: 휴대폰/생년월일) | `refstore`(암호화, WebCrypto) | 패턴 B 식별정보. 로그 금지 (`spec/refstore.md`) |
| 빌링키 참조(패턴 A, 후순위) | `refstore`(암호화) | 원시 카드번호 저장 안 함 |
| 결제 비밀·로그인 자격증명 | **저장 안 함** | 범위 밖 (`AGENTS.md §1.1 범위`) |

## 6. 신뢰 경계 & 격리 (어디서 강제되나)

- 두뇌(Untrusted)는 **BrokerTools 인터페이스 밖으로 코어 접근 불가**
  (`spec/agent-integration.md`).
- 경계를 넘는 모든 메시지는 `shared` Zod로 검증, 실패 시 거절.
- 격리의 실제 강제력은 두뇌 부착 방식에 의존(①내장=코드규율, ③MCP=강제).
  잔여 리스크(세션 쿠키)는 `AGENTS.md §2.6`에 명시.

## 7. 빌드 / 배포

- WXT로 MV3 번들 빌드(HMR·manifest 자동생성). 산출물을 크롬에 로드.
- CI: typecheck + Biome lint + Vitest(정책 엔진) — 시크릿 없이 통과.
  E2E(Playwright)는 익스텐션 로드 + 테스트 쇼핑몰. (`docs/methodology.md`)
- 실제 카드·계정 금지, 더미 프로필·테스트 머천트만.

## 8. 링크 맵 (어디에 뭐가 있나)

| 알고 싶은 것 | 문서 |
|---|---|
| 왜 이 결제 모델인가 / 결정 | `AGENTS.md` |
| 결제수단별 근거·플로우 | `docs/payment-flows.md` |
| 시스템이 어떻게 맞물리나 | **이 문서** |
| 제어(DOM)·두뇌 부착 | `docs/spec/agent-integration.md` |
| 모듈 입출력 계약 | `docs/spec/{data-model,policy,broker-api,executor,audit,notify}.md` |
| 스택·버전 | `docs/stack.md` |
| 개발 방법론·DoD | `docs/methodology.md` |
