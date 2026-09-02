# 모듈 스펙 (Specs)

> 스펙 주도 개발. 각 모듈은 코드보다 스펙이 먼저다. 스펙과 코드가 충돌하면
> 스펙이 진실. 방법론은 `docs/methodology.md`, 상위 설계는 `AGENTS.md`.

## 스펙 구조 (모든 스펙 공통)

1. **목적(Purpose)** — 책임과 비책임
2. **입출력 계약(Contract)** — 타입/스키마, 신뢰 수준
3. **불변식(Invariants)** — 항상 참이어야 하는 조건
4. **수용 기준(Acceptance Criteria)** — 완료 체크리스트
5. **테스트 케이스(Test Cases)** — 정상/경계/실패

## 목록

| 스펙 | 모듈 | 패키지 | MVP |
|---|---|---|---|
| [data-model.md](data-model.md) | 공용 Zod 스키마·타입 | `shared` | ✅ |
| [policy.md](policy.md) | 정책 엔진 (순수 함수, TDD) | `broker-extension/policy` | ✅ |
| [broker-api.md](broker-api.md) | 에이전트↔브로커 메시지 계약 | `shared` + `background` | ✅ |
| [executor.md](executor.md) | SimplePayAdapter (카카오→토스) | `broker-extension/executor` | ✅ |
| [audit.md](audit.md) | 감사 로그 | `broker-extension/audit` | ✅ |
| [notify.md](notify.md) | 알림 | `broker-extension/notify` | ✅ |
| [refstore.md](refstore.md) | PII·빌링키 참조 암호화 저장 | `broker-extension/refstore` | ✅ |
| [watch.md](watch.md) | 감시 엔진(지정가 모니터링·트리거) | `broker-extension/watch` | ✅ |
| [agent-integration.md](agent-integration.md) | 제어 메커니즘(DOM) + 두뇌 부착 방식 + 도구 인터페이스 | `broker-extension` + 전송 | ✅ |
| [ui.md](ui.md) | UI 표면(Side Panel/Options/알림)·디자인 토큰·화면별 상태 | `broker-extension/ui` | ✅ |
| [manifest.md](manifest.md) | MV3 권한 정책·도메인 화이트리스트 | `broker-extension` | ✅ |

## 의존 순서 (구현 순서 권장)

```
data-model → policy → broker-api → audit/notify/refstore → executor → watch
(스키마)     (순수함수) (경계 검증)   (기록/통지/암호화저장)    (실결제)    (감시·트리거)
```
manifest·agent-integration·ui는 위와 병행(익스텐션 셋업·표면).
