# AutoPay

**자율 지출 거버넌스 계층** — AI 에이전트가 사용자를 대신해 웹에서 상품을
검색·결제하되, 정책·감사·격리·통지로 사용자가 통제권과 가시성을 잃지 않게 한다.
주 타깃은 국내 결제 환경(카카오페이·토스페이·쿠팡).

핵심 설계·근거는 **[AGENTS.md](AGENTS.md)** (프로젝트 단일 기준), 현재 구현
상태는 **[docs/status.md](docs/status.md)**.

## 무엇을 하나

- **정책 통제**: 금액 한도(건당/일/월)·횟수·머천트·카테고리·결제수단을 정책으로.
  모든 결제는 정책 검증을 통과해야 실행된다.
- **비밀 격리**: 브로커는 원시 결제 비밀을 보관·입력하지 않는다. 최종 승인은
  폰(패턴 B) 또는 사전 승인 원터치(패턴 C, 쿠팡). "훔칠 게 없는" 설계.
- **감사·통지**: 모든 결제 시도를 감사 로그로, 완료/거절을 즉시 알림.
- **지정가 감시**: 상품·상한가를 정하면 조건 충족 시 결제(정책 게이트 경유).

## 구조

```
packages/shared              공용 Zod 스키마·타입(경계의 단일 진실)
packages/broker-extension    Chrome MV3 익스텐션(신뢰 영역)
  src/policy                 정책 엔진(순수 함수, 100% 커버리지)
  src/{audit,notify,refstore,watch,executor,broker}  신뢰 코어(주입식·유닛테스트)
  src/platform               chrome 어댑터(kv/notify/page-bridge)
  src/background             합성 루트 + UI RPC
  entrypoints                background · sidepanel · options (WXT/React)
docs/                        설계·스펙·규범 (spec/ 11종)
```

## 개발

요구: Node 20+, pnpm 9.

```bash
pnpm install            # 의존성 설치 (postinstall이 wxt prepare 실행)
pnpm test               # 전체 유닛 테스트 (86)
pnpm typecheck          # 타입 체크
pnpm lint               # Biome
pnpm --filter @autopay/broker-extension build   # 익스텐션 빌드(.output/chrome-mv3)
pnpm --filter @autopay/broker-extension dev     # WXT 개발 모드
```

### Chrome에 로드

1. `pnpm --filter @autopay/broker-extension build`
2. Chrome → 확장 프로그램 → 개발자 모드 → "압축해제된 확장 프로그램 로드"
3. `packages/broker-extension/.output/chrome-mv3` 선택
4. 툴바 아이콘 클릭 → Side Panel(우측), 옵션에서 정책·프로필 설정

## 워크플로

기본 브랜치 `dev`. 기능 완결 단위 커밋 + Codex 리뷰(자세히는
[docs/methodology.md](docs/methodology.md)). 개발/테스트에 실제 카드·계정 금지.

## 상태

M0(스켈레톤)·M1(익스텐션) 완료·검증. M2(자율 에이전트/MCP)·M3(실결제 라이브
셀렉터)·M4(빌링키)는 라이브 연결 잔여 — [docs/status.md](docs/status.md) 참조.
