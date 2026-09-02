# 구현 상태 (Status)

> 갱신: 2026-09-02. 무엇이 **실제로 만들어져 테스트·빌드로 검증**됐고, 무엇이
> 남았는지 정직하게 기록한다.

## 완료 (검증됨)

| 영역 | 상태 | 검증 |
|---|---|---|
| 모노레포·스택 (M0) | ✅ | pnpm workspace, TS strict, Vitest, Biome |
| `shared` Zod 스키마 | ✅ | strict 거부·origin 제약 포함, 유닛 테스트 |
| 정책 엔진 | ✅ | 순수 함수, **100% 커버리지**, 26 케이스 |
| audit / notify / refstore / watch | ✅ | 주입식 유닛 테스트 |
| executor 코어(스냅샷·TOCTOU 재검증) + 어댑터(카카오/쿠팡/토스) | ✅ | fake driver/bridge 유닛 테스트 |
| broker 오케스트레이션(정책·confirm·origin·동시성·예외수렴) | ✅ | 유닛 테스트 |
| 브로커 익스텐션 (M1) | ✅ | WXT MV3, Side Panel+Options+background, `wxt build` 성공 |
| Codex 리뷰 | ✅×3 | M0·M1코어·M1익스텐션, High/Medium 반영 |

**테스트 총계**: 86 (shared 8 + broker-extension 78). typecheck·biome 클린.

## 남은 작업 (이 환경에서 런타임 검증 불가 — 라이브 연결 필요)

- **M2 — 자율 에이전트/MCP(③)**: 두뇌 LLM 루프(Claude API)와 MCP 서버·Native
  Messaging Host. 코어는 `BrokerTools` 경계로 준비됨. LLM·네이티브 호스트
  런타임이 필요해 여기서 미검증.
- **M3 — 실결제 어댑터 라이브 셀렉터**: 카카오/쿠팡/토스 어댑터의 DOM 셀렉터·
  완료신호는 placeholder. 실결제 네트워크 캡처로 확정 필요(payment-flows 검증
  항목). 로직(스냅샷·재검증·매핑)은 완성·테스트됨.
- **M4 — 빌링키(패턴 A)**: refstore에 빌링키 저장 계약만 존재. PG 가맹점 계약
  전제.

## 알려진 한계 (설계상 명시)

- **카테고리 스푸핑**: 정책 카테고리는 에이전트 제출 items에 의존. 실제 장바구니
  상품 대조는 사이트별 파싱이 필요해 미구현(AGENTS §1.1 범위). TOCTOU 재검증은
  승인 후 변경을 막지만, 최초 카테고리 위장은 실장바구니 파싱 전까지 잔여.
- **교차 워커 원자성**: in-flight 가드는 단일 서비스워커 내 중복만 방지. MV3
  워커 재기동 시 in-memory 가드·세션 키가 소실됨(재잠금 필요).
- **세션 쿠키 탈취**(별도 익스텐션 에이전트): 브로커 통제 밖(AGENTS §2.6).

## 실행 방법

`README.md` 참조 (빌드·로드·테스트).
