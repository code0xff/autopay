# @autopay/agent-skill (설계 — 미구현)

Claude Code용 **스킬** — 사용자가 "○○ 사줘/지정가로 주문"이라고 하면 AutoPay
MCP 도구로 검색·비교·선택·장바구니·체크아웃·결제 요청을 수행한다.

설계: [`docs/spec/mcp-integration.md`](../../docs/spec/mcp-integration.md) §6.

## 구성 (구현 예정)
- `SKILL.md`: 트리거(사줘/구매/최저가/지정가)와 절차(정책 요약 확인 → 검색 →
  후보 비교 → 선택 → 장바구니 → 체크아웃 → `request_payment` → 결과 보고).
- 금지 규칙(프롬프트): 정책 우회·키패드 조작·FDS 회피·비밀 요구 금지, 최종
  승인은 사용자(패턴 B 폰 / 패턴 C 확인).

## 전제
- MCP 서버(`@autopay/mcp-server`) 등록 + 익스텐션 브리지 연결 필요.
- 도구만 호출(페이지 직접 접근 없음) → 격리 우월(AGENTS §2.6).
