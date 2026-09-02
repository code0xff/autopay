# Spec: Reference Store (`broker-extension/refstore`)

## 1. 목적

브로커가 보관해야 하는 **비-원시 민감 데이터**를 암호화 저장한다:
- **본인 식별 정보(PII)**: 휴대폰번호·생년월일 — 패턴 B(카카오/토스) 결제창
  자동 입력용. **MVP 필수.**
- **빌링키 참조**: 패턴 A(정기결제) 도입 시. 후순위.

**비책임 / 절대 금지**: 원시 결제 비밀(카드번호·CVV·결제 비밀번호)·로그인
자격증명은 저장하지 않는다(범위 밖, AGENTS §1.1). 저장 데이터를 에이전트나
Broker API로 반환하지 않는다.

## 2. 계약

```typescript
export interface Identity { phone: string; birth: string; } // 패턴 B 입력용 PII

export interface RefStore {
  /** 옵션 페이지(사용자 입력)에서만 호출. 저장 시 암호화. */
  setProfile(id: Identity): Promise<void>;
  /** executor 내부에서만 사용. 복호화된 값을 결제창 입력에 즉시 사용하고
   *  메모리에 남기지 않는다. Broker API·로그로 절대 반환 금지. */
  getIdentity(): Promise<Identity | null>;
  hasProfile(): Promise<boolean>;            // UI 상태용(값 미노출)

  // 패턴 A (후순위) — 원시 카드번호 아님, "참조"만
  setBillingRef(methodId: string, ref: string): Promise<void>;
  getBillingRef(methodId: string): Promise<string | null>; // executor 내부 전용
}
```

## 3. 암호화 방식

- `chrome.storage.local`에 **평문 저장 금지.** WebCrypto **AES-GCM**로 암호화.
- 키 파생: 사용자 패스프레이즈 → **PBKDF2**(솔트·충분한 iteration) 또는
  OS 키체인(Native Host 경유, 후속). 키는 저장소 밖에 둔다.
- 저장 레코드에는 IV·암호문만. 복호화는 refstore 내부에서만.

## 4. 불변식

- 원시 카드번호·CVV·결제 비밀번호·로그인 자격증명을 저장하지 않는다.
- `getIdentity`/`getBillingRef`는 **executor 내부에서만** 호출. Broker API 응답,
  로그, audit, UI(마스킹 제외)로 원문이 나가지 않는다.
- 저장은 항상 암호화(평문 키/값 금지). 키는 스토리지 밖.
- 프로필 등록/수정은 **옵션 페이지(사용자 직접 입력)에서만**. 에이전트 경유 금지.

## 5. 수용 기준

- [ ] `setProfile/getIdentity/hasProfile` 구현, AES-GCM 암호화 저장
- [ ] `chrome.storage.local`에 평문 PII가 없음(저장 후 확인)
- [ ] `getIdentity`가 executor 외부에서 호출되지 않음(설계/리뷰)
- [ ] 로그·audit·Broker API 응답에 phone/birth 원문 없음(grep)
- [ ] 원시 카드번호 저장 경로가 코드에 존재하지 않음

## 6. 테스트 케이스

1. setProfile 후 storage 원문 검사 → 평문 phone/birth 없음(암호문만)
2. getIdentity → 올바른 복호화 값(테스트 키)
3. 잘못된 키/패스프레이즈 → 복호화 실패(값 노출 없이 에러)
4. hasProfile → 값 노출 없이 boolean
5. getIdentity 반환값이 로그로 새지 않음(로거 목킹으로 확인)
