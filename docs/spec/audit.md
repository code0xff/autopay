# Spec: 감사 로그 (`broker-extension/audit`)

## 1. 목적

모든 결제 시도(성공/거절/실패/취소/확인요구)를 **불변 기록**으로 남긴다.
사용자가 나중에 "무엇이·언제·얼마·어디서" 결제됐는지 검증할 수 있어야 한다
(AGENTS.md §0 가시성). 또한 정책 엔진의 사용량 집계(daily/monthly/count)의
근거 데이터가 된다.

**비책임**: 판정·실행·알림. 기록과 조회만.

## 2. 계약

```typescript
import type { AuditRecord, UsageSnapshot } from "shared";

export interface AuditLog {
  append(record: AuditRecord): Promise<void>;   // 추가 전용(수정·삭제 없음)
  list(opts?: { since?: string; limit?: number }): Promise<AuditRecord[]>;
  /** 정책 엔진 입력용 사용량 집계 (approved 건만 합산) */
  usageFor(now: Date): Promise<UsageSnapshot>;
}
```

- 저장소: `chrome.storage.local` (append-only 컬렉션). 레코드 스키마는
  `shared`의 `AuditRecord`.
- **보존/용량 정책**: 감사 무결성상 자동 삭제하지 않는다. `chrome.storage.local`
  쿼터(약 10MB, `unlimitedStorage` 권한 시 확장)에 대비해 (a) `list`는
  페이지네이션(`since`/`limit`)으로만 조회, (b) 쿼터 임계 접근 시 사용자에게
  내보내기(JSON) 후 정리(archive)를 안내 — 조용한 삭제 금지. `usageFor` 집계는
  당월 범위만 스캔하도록 인덱스/캐시(월별 합계)로 O(1)에 가깝게 유지.
- `usageFor`: `outcome==="approved"`인 레코드만 대상으로
  - `spentToday` = 오늘(로컬 타임존) 합
  - `spentThisMonth` = 이번 달 합
  - `countToday` = 오늘 건수

## 3. 불변식

- **추가 전용**: 기존 레코드는 수정·삭제되지 않는다(감사 무결성).
- 레코드에 비밀·빌링키·PII(휴대폰번호·생년월일) 원문이 없다(`AuditRecord`
  스키마가 애초에 필드 미보유).
- `usageFor`는 approved 건만 합산(rejected/failed는 예산 소모 아님).
- 같은 레코드를 두 번 append해도 사용량이 이중 계상되지 않도록 `id` 유일.

## 4. 수용 기준

- [ ] `append/list/usageFor` 구현, 저장은 chrome.storage.local
- [ ] append가 기존 레코드를 변경하지 않음(추가 전용) 테스트
- [ ] `usageFor`가 오늘/이번달/건수를 정확히 집계(타임존 경계 포함)
- [ ] 레코드에 비밀·PII 원문 없음
- [ ] rejected/failed가 usage에 반영되지 않음

## 5. 테스트 케이스

1. append 후 list로 조회됨
2. approved 2건(20k, 30k) 같은 날 → `spentToday=50_000, countToday=2`
3. rejected 1건 추가 → usage 불변
4. 지난달 approved 건 → `spentThisMonth`에 미포함, `spentToday` 미포함
5. 자정 경계: 어제 23:59 vs 오늘 00:01 분리 집계
6. 동일 id 중복 append → 사용량 이중 계상 없음
