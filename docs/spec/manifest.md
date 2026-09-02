# Spec: MV3 Manifest & 권한 정책 (`broker-extension`)

## 1. 목적

확장이 요청하는 권한을 **최소·명시적**으로 확정한다(coding-guide §4, agent-
integration). 권한은 곧 공격 표면이므로 필요한 것만, 근거와 함께.

## 2. 권한 (MVP)

| 권한 | 용도 | 근거 |
|---|---|---|
| `sidePanel` | 주 콘솔(우측 도킹) | ui.md |
| `notifications` | 완료/거절 OS 알림 | notify.md |
| `storage` | 정책·감사·감시·암호화 참조 저장 | audit/watch/refstore |
| `alarms` | 감시 폴링 스케줄 | watch.md |
| `scripting` | content script 주입("손") | agent-integration |
| `tabs` | 체크아웃 탭 식별·이동 | executor/broker-api |

- **`unlimitedStorage`**: 감사 로그 누적 대비(선택). 도입 시 audit 보존정책과 연동.
- **`debugger` 미사용**(방식 A 유지, agent-integration §2.2·§5).
- 원시 결제 비밀·로그인 관련 권한 없음(범위 밖).

## 3. host_permissions (도메인 화이트리스트)

- **최소·명시.** 지원 쇼핑몰 + 결제사 도메인만. 광범위 `<all_urls>` 금지.
- 결제사 도메인은 `docs/payment-flows.md`의 확정 목록과 연결(카카오
  `online-payment.kakaopay.com`, 토스 `pay.toss.im`, 쿠팡 `coupang.com` 등).
- 실결제 네트워크 캡처로 도메인 확정 전까지는 후보로 두고, 확정 시 갱신
  (payment-flows 검증 항목).
- content script는 가능하면 `scripting.registerContentScripts`로 **동적 등록**해
  대상 축소. 정적 `content_scripts` 광역 매칭 지양.

## 4. 후속 권한 (MVP 아님)

| 권한 | 용도 | 시점 |
|---|---|---|
| `nativeMessaging` | 두뇌 외부화(③ MCP/Native Host) | 격리 강화 |
| `externally_connectable` (명시 ID) | 별도 익스텐션 에이전트(②) | 후속 |

## 5. 불변식

- 선언된 모든 권한은 §2/§3 표에 근거가 있다(불명 권한 금지).
- `debugger`·`<all_urls>`·광역 host 권한을 선언하지 않는다.
- 결제사/쇼핑몰 host 권한은 payment-flows 화이트리스트와 일치.

## 6. 수용 기준

- [ ] manifest 권한이 §2/§3와 일치, 불명 권한 없음
- [ ] `debugger` 미포함, `<all_urls>` 미사용
- [ ] host_permissions가 payment-flows 도메인 목록과 동기화
- [ ] 후속 권한(nativeMessaging 등)은 해당 마일스톤 전까지 미선언
