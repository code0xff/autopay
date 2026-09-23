# Spec: UI (`broker-extension/ui`)

## 1. 목적

사용자가 정책을 설정하고, 결제를 승인/거절하며, 결과를 인지하는 화면.
`docs/design/ui-mockup.html`은 M1 초기(shadcn neutral) 목업이며 **2026-09-23
Slate 재도색 이후로는 갱신되지 않았다** — 시각 기준은 실제 구현
(`src/ui/theme.css`)과 §3의 토큰 표를 따른다.

**비책임**: 판정(policy)·실행(executor). UI는 상태 표시와 사용자 입력만.

## 2. 표면 (Chrome 확장 UI 배치)

| 표면 | Chrome API | 역할 | MVP |
|---|---|---|---|
| **Side Panel** | `chrome.sidePanel` | **기본 화면** — 우측 도킹, 브라우징 중 상주. 탭 앱(`AppShell`) | ✅ |
| **Options page** | 전체 탭 | 사이드패널과 **같은 탭 앱**을 넓은 폭으로(화면 중복 없음) | ✅ |
| **Notifications** | `chrome.notifications` | 완료/거절 OS 알림(브라우저 밖에서도) | ✅ |
| ~~Action popup~~ | — | **미사용** | ❌ |

- **Action popup을 쓰지 않는 이유**: 포커스를 잃으면 닫힌다. 승인 플로우는
  사용자가 폰을 보러 시선을 옮기는(패턴 B) 순간이 있어 팝업이 사라져 버린다.
  Side Panel은 상주하므로 승인·진행 상태 표시에 적합.
- 세 표면 모두 확장 자체 컨텍스트(신뢰 영역). 페이지 주입 오버레이는
  격리가 약해 쓰지 않는다(`spec/agent-integration.md`).

## 3. 디자인 토큰 (구현 기준, 2026-09-23부터 Slate 적용)

> `~/workspace/design/slate/design.md`(개발자 콘솔용, 한국어 대응) 적용.
> 이전 shadcn neutral·각진 4px·Geist 조합은 폐기됨.

- **토큰**: `canvas`/`surface`/`subtle`/`line`/`ink`/`accent`/`ok`/`warn`/
  `danger` (light+dark) — `src/ui/theme.css`가 단일 진실.
- **형태**: 버튼·배지·아이콘버튼은 **완전히 둥근 pill**, 입력창은 `radius-xl`
  (20px), 카드·패널은 `radius-lg`(16px) — 컨트롤은 완전히 둥글게, 패널/필드는
  큰 반경의 "형태"로 구분한다는 Slate 규칙.
- **서체**: 시스템 한글 폰트 스택(`-apple-system, ..., Apple SD Gothic Neo,
  Noto Sans KR`) — 원격 웹폰트(Geist) 로드 제거, 오프라인 안전. 금액·시각·
  주문번호는 `.mono`(`tabular-nums`).
- **한글 라벨**: 트래킹 확대·대문자 변환 금지(Slate CJK 규칙 — 한글은 대소문자가
  없어 트래킹을 넓히면 "흩어진 글자"로 읽힌다). `.label`은 11.5px, 트래킹 0.
- **상태색(semantic, accent 아님)**: 완료=`ok`(초록), 거절/실패=`danger`(빨강),
  진행/폰승인=`accent`가 아니라 기존처럼 info 배지(현재 `accent`로 매핑),
  주의/미충족/패턴C=`warn`(주황).
- **포커스**: 모든 인터랙티브 요소에 `accent` 포커스 링(`:focus-visible`).
- **테마**: light/dark 토글을 Side Panel 헤더 + Options 헤더에 탑재. 기본은
  system, 선택은 per-viewer로 저장(`localStorage`, try/catch).
- **앱 아이콘**: "A" 워드마크. `primary` 토큰 배경(반경 `radius-sm`)에
  `on-primary` 글자, dark에서 토큰이 자동 반전.

## 4. 화면별 요소·상태

### 4.1 탭 앱 (`src/ui/AppShell.tsx`) — 사이드패널·옵션 공통

사이드패널과 옵션 페이지는 같은 탭 앱을 띄운다(옵션은 가운데 680px). 기능이
두 화면에 겹치거나 한쪽에만 있는 문제를 없애려고 2026-09-23 기능별 탭으로 재편.

**헤더**: 로고("A") + "AutoPay" + 테마 토글. 그 아래 **탭**(Slate Segmented —
pill 안의 pill, 선택 탭은 반전). 마지막 탭은 `localStorage`에 기억.

| 탭 | 내용 |
|---|---|
| **홈** | 시작하기 체크리스트(확인 가능한 단계가 끝나면 숨김) · **오늘 남은 한도**(일 잔여 mono·잔여 횟수·월 잔여·건당 최대·승인 규칙) · **승인 카드**(대기 건마다 한 장, 없으면 "승인 대기 중인 결제가 없습니다" 카드). 대기 건이 있으면 탭에 개수 배지(warn) |
| **정책** | `PolicyForm` — 한도(건당/일/월/횟수)·확인 임계값·항상 확인·허용 머천트·결제수단·카테고리 |
| **기록** | 감사 로그 테이블 |
| **설정** | MCP 브리지(토큰·연결 상태) · 본인 식별 정보(패턴 B PII) · 사이트 접근 고지 |

- 승인 카드: 가맹점, **금액(mono)**, 결제수단 배지, [거절] [승인하고 결제].
  패턴 C(쿠팡)일 때 "폰 승인이 없어 이 확인이 유일한 게이트" 안내.
- 제거된 것: 감시(Watch) 탭(`docs/spec/watch.md`), "현재 탭에서 결제" 수동
  트리거(사용자가 이미 결제 화면에 있어 쿠팡에서 직접 누르는 것과 차이가 없었음).

**승인 카드 상태 (data-model `Decision`/`PaymentResult` 매핑)**

| UI 상태 | 근거 | 표시 |
|---|---|---|
| 승인 대기 | decision=confirm | 카드 + [거절][승인] |
| 폰 승인 대기 | 패턴 B 실행 중 | info 배지 "폰에서 승인" + 진행 |
| 완료 | result=approved | success, 금액·주문번호 |
| 정책 거절 | result=rejected(violation) | destructive, 위반 사유 |
| 취소 | result=canceled | muted, 사용자 거절/미응답(사용자 행위이지 오류 아님) |
| 실패 | result=failed (timeout 포함) | destructive, 오류 요약 |

### 4.2 잠금 — AutoPay 활성 스위치

잠겨 있으면 **AutoPay는 비활성**이다.
- UI는 잠금 화면만 보인다(탭 없음). 첫 실행(검증값 없음)이면 "패스프레이즈 설정"
  (두 번 입력), 이후엔 "잠금 해제". 해제하면 탭 화면으로 넘어간다.
- 백그라운드 RPC는 `getState`·`unlock`만 허용하고 나머지는 `locked`로 거부.
- 브리지 도구(에이전트)는 전부 `autopay_locked`로 거부.
- 패스프레이즈는 항상 검증한다: 알려진 평문을 봉인한 검증값(`lock:verifier`)이
  열리는지 확인. 검증값 도입 전 설치본은 저장된 프로필 복호화로 검증 후 생성.
- 해제 상태는 **브라우저를 닫을 때까지** 유지 — 키 원본을 `chrome.storage.session`
  (디스크에 쓰지 않는 메모리 저장소)에 두고 서비스워커 재시작 시 복원한다.
- 헤더의 잠금 버튼으로 즉시 잠근다(세션 키 삭제).

### 4.3 Notifications
- 완료: "결제 완료 · ₩X · 가맹점 · 주문번호". 거절: 사유 요약.
- 본문에 비밀·PII 원문 금지. `notifyOnRejection=false`면 거절 알림 미발송.

### 4.4 첫 실행 / 온보딩 (first-run)
확장 설치 후 Options에서 순서대로 안내한다.
1. **정책 최소 설정**: 한도·허용 머천트·카테고리(기본값은 가장 제한적).
2. **결제수단 선택**: 사용할 간편결제 켜기. **쿠팡 원터치는 사용자가 쿠팡
   앱에서 직접 켜야 함**을 안내(패턴 C 전제, AGENTS §2.5).
3. **본인 식별 정보 입력**(패턴 B 사용 시): 휴대폰·생년월일 → refstore 암호화
   저장(`spec/refstore.md`). 마스킹 표시.
4. **브라우저 프로필 분리 권고**: 민감 세션과 자동쇼핑 세션 분리(AGENTS §2.6
   잔여 리스크). 안내 배너.
5. 로그인은 사용자가 직접(범위 밖). 앱은 로그인 자격증명을 요구하지 않는다.

### 4.5 국제화(i18n)
국내 전용이라 **국문 고정, i18n은 범위 밖**. 문자열은 한 곳(메시지 상수)에
모아 후속 확장 여지만 남긴다.

## 5. 상호작용

- 승인/거절 → BrokerAPI로 전달(`spec/broker-api.md`). 낙관적 표시 금지 —
  실제 결과(완료/실패)로만 상태 전환.
- 정책 편집 → 저장 시 `shared` 스키마 검증 후 반영. 잘못된 값은 인라인 오류.
- 테마 토글 → data-theme 스탬프 + 저장. 기본 system.
- 스위치·칩 편집은 즉시 상태 반영(임시), 저장 액션으로 확정.

## 6. 불변식

- UI는 비밀·PII·빌링키를 **원문으로 표시/보관하지 않는다**(마스킹만).
- 결제 완료 표시는 **브로커가 확인한 결과**에만 근거(에이전트 보고 아님).
- 승인 대기 화면은 사용자가 떠나도 사라지지 않는다(Side Panel 상주).
- 모든 색 상태는 텍스트/배지로도 구분(색맹 접근성 — 색 단독 의존 금지).

## 7. 수용 기준

- [ ] Side Panel(승인+남은 한도+정책) + Options(전체 탭) + notifications 구현
- [ ] Action popup 미사용(승인은 Side Panel에서)
- [ ] Slate 토큰(canvas/surface/ink/accent/ok/warn/danger) + pill 컨트롤 + 시스템 한글 폰트 적용
- [ ] light/dark 토글(기본 system, 저장) 동작
- [ ] 승인 카드가 confirm/폰대기/완료/거절/실패 5상태를 표시
- [ ] PII·비밀 마스킹, 알림 본문에 원문 없음
- [ ] 색 단독이 아닌 텍스트/배지 병행, 키보드 포커스 가시

## 8. 테스트 케이스

1. Side Panel: confirm 상태 → [승인]/[거절] 노출
2. [승인] → 폰 승인 대기(패턴 B) 또는 즉시 완료(패턴 C 원터치) 전환
3. result=rejected → danger 배지 + 위반 사유
4. Options 저장: 음수 한도 등 잘못된 값 → 인라인 오류, 미저장
5. 테마 토글 → light/dark 전환 및 재로드 후 유지
6. PII 필드는 마스킹 표시(`010-****-5678`)
7. notifyOnRejection=false → 거절 알림 미발송
