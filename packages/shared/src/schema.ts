import { z } from "zod";

// 신뢰 경계를 넘는 모든 메시지·저장 레코드의 단일 진실 (docs/spec/data-model.md).
// 경계에서 schema.safeParse() 실패 = 즉시 거절. 비밀·빌링키·PII 원문 필드 없음.
//
// 격리 강화(Codex 리뷰 반영):
//  - 인바운드 객체는 .strict() — 미지의 필드(cardNumber/cvv/billingKey 등)를
//    조용히 버리지 않고 거절한다(fail-closed, AGENTS §4).
//  - origin은 https 오리진만 허용 — 자격증명(user:pass@)·경로·쿼리·프래그먼트에
//    비밀/PII가 실려 경계를 넘는 것을 차단한다.

// ── 금액/상품 ────────────────────────────────
export const Currency = z.literal("KRW"); // MVP는 KRW만
export const Amount = z.number().int().nonnegative(); // 원 단위 정수

// ── 결제수단 (단일 진실. 다른 스펙·모듈은 이걸 참조) ──
// kakao/toss=패턴 B(폰 승인), coupay=패턴 C(원터치)
export const PaymentMethod = z.enum(["kakaopay", "tosspay", "coupay"]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

// ── 오리진 URL: https, 자격증명·경로·쿼리·프래그먼트 없음 ──
export const OriginUrl = z
  .string()
  .url()
  .refine(
    (s) => {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        return false;
      }
      return (
        u.protocol === "https:" &&
        u.username === "" &&
        u.password === "" &&
        (u.pathname === "" || u.pathname === "/") &&
        u.search === "" &&
        u.hash === ""
      );
    },
    { message: "must be an https origin without credentials, path, query, or fragment" },
  );

export const LineItem = z
  .object({
    title: z.string().min(1).max(200), // 길이 상한(로그·audit 유출 표면 축소)
    category: z.string().max(80).optional(), // 정책 카테고리 매칭용
    quantity: z.number().int().positive(),
    unitPrice: Amount,
  })
  .strict();
export type LineItem = z.infer<typeof LineItem>;

// ── 결제 요청 (에이전트 → 브로커) ──────────────
export const Merchant = z
  .object({
    origin: OriginUrl, // 쇼핑몰 origin (정책 머천트 매칭 키)
    name: z.string().min(1).max(80), // 길이 상한(유출 표면 축소)
  })
  .strict();
export type Merchant = z.infer<typeof Merchant>;

export const PaymentRequest = z
  .object({
    merchant: Merchant,
    items: z.array(LineItem).min(1),
    totalAmount: Amount, // 에이전트가 주장하는 총액(검증 대상)
    currency: Currency,
    method: PaymentMethod,
    checkoutTabId: z.number().int(), // 체크아웃 진행 탭
  })
  .strict();
export type PaymentRequest = z.infer<typeof PaymentRequest>;

// ── 정책 ─────────────────────────────────────
export const PaymentPolicy = z
  .object({
    limits: z
      .object({
        perTransaction: Amount,
        daily: Amount,
        monthly: Amount,
        maxTransactionsPerDay: z.number().int().nonnegative(),
      })
      .strict(),
    merchants: z
      .object({
        mode: z.enum(["allowlist", "any"]),
        origins: z.array(OriginUrl),
      })
      .strict(),
    categories: z
      .object({
        mode: z.enum(["allowlist", "denylist"]),
        values: z.array(z.string()),
      })
      .strict(),
    methods: z.array(PaymentMethod).min(1),
    confirmation: z
      .object({
        requireUserConfirmationAbove: Amount, // 초과 시 명시적 확인 요구
        alwaysConfirm: z.boolean(), // true면 모든 건 확인
      })
      .strict(),
    notifications: z
      .object({
        channels: z.array(z.enum(["chrome", "telegram", "email", "webhook"])),
        notifyOnRejection: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PaymentPolicy = z.infer<typeof PaymentPolicy>;

// ── 사용량 스냅샷 (정책 엔진 입력, 순수성 유지용) ──
export const UsageSnapshot = z
  .object({
    spentToday: Amount,
    spentThisMonth: Amount,
    countToday: z.number().int().nonnegative(),
  })
  .strict();
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

// ── 판정 결과 (정책 엔진 출력) ─────────────────
export const PolicyViolation = z.enum([
  "merchant_not_allowed",
  "category_not_allowed",
  "method_not_allowed",
  "over_per_transaction",
  "over_daily",
  "over_monthly",
  "over_count",
  "amount_mismatch", // 검증된 실제 금액과 요청 총액 불일치
]);
export type PolicyViolation = z.infer<typeof PolicyViolation>;

export const Decision = z.discriminatedUnion("type", [
  z.object({ type: z.literal("allow") }),
  z.object({ type: z.literal("confirm"), reason: z.enum(["threshold", "always"]) }),
  z.object({ type: z.literal("deny"), violation: PolicyViolation }),
]);
export type Decision = z.infer<typeof Decision>;

// ── 결과 (브로커 → 에이전트) ───────────────────
// 에이전트向 결과는 내부 AuditRecord보다 거칠다(정보 최소화, AGENTS §4 격리).
export const PaymentResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("approved"),
    receipt: z
      .object({
        amount: Amount,
        merchant: z.string(),
        orderId: z.string(),
        at: z.string(),
      })
      .strict(),
  }),
  z.object({ status: z.literal("rejected"), violation: PolicyViolation }),
  z.object({ status: z.literal("pending_user_confirmation") }),
  z.object({
    status: z.literal("canceled"),
    reason: z.enum(["user_declined", "phone_declined", "confirm_timeout", "content_changed"]),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }), // timeout 포함
]);
export type PaymentResult = z.infer<typeof PaymentResult>;

// ── 감사 레코드 (불변 기록) ────────────────────
export const AuditRecord = z
  .object({
    id: z.string(), // uuid
    at: z.string(), // ISO8601
    merchant: Merchant,
    amount: Amount,
    method: PaymentMethod,
    decision: Decision,
    outcome: z.enum(["approved", "rejected", "failed", "canceled", "timeout", "confirm_required"]),
    orderId: z.string().optional(), // 성공 시 쇼핑몰 주문번호
    // 비밀·빌링키·PII 원문 금지 (docs/methodology.md §3)
  })
  .strict();
export type AuditRecord = z.infer<typeof AuditRecord>;

// ── MCP 브리지 프로토콜 (docs/spec/mcp-integration.md §3·§4) ──
// mcp-server(로컬 WS 허브) ↔ 익스텐션 background 간 프레임. 스킬은 이 표면
// 밖으로 브로커·페이지에 접근하지 못한다(§10 불변식). 비밀·빌링키·세션 없음.

// open()용: 임의 쇼핑몰 URL(검색 결과 페이지 등)이라 OriginUrl보다 완화되지만
// 자격증명은 여전히 금지(https만, user:pass@ 없음).
export const SafeHttpUrl = z
  .string()
  .url()
  .refine(
    (s) => {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        return false;
      }
      return u.protocol === "https:" && u.username === "" && u.password === "";
    },
    { message: "must be an https url without credentials" },
  );

const Selector = z.string().min(1).max(300);

// request_payment 인자 — checkoutTabId는 익스텐션이 자신이 추적 중인 브리지 탭으로
// 채운다(에이전트에 탭 id를 노출하지 않음).
export const BridgeRequestPaymentArgs = z
  .object({
    merchant: Merchant,
    items: z.array(LineItem).min(1),
    totalAmount: Amount,
    currency: Currency,
    method: PaymentMethod,
  })
  .strict();
export type BridgeRequestPaymentArgs = z.infer<typeof BridgeRequestPaymentArgs>;

export const BridgeToolCall = z.discriminatedUnion("tool", [
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("open"),
      args: z.object({ url: SafeHttpUrl }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("read_page"),
      args: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("click"),
      args: z.object({ selector: Selector }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("fill"),
      args: z.object({ selector: Selector, value: z.string().max(500) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("request_payment"),
      args: BridgeRequestPaymentArgs,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("get_payment_result"),
      args: z.object({ requestId: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      tool: z.literal("get_policy_summary"),
      args: z.object({}).strict(),
    })
    .strict(),
]);
export type BridgeToolCall = z.infer<typeof BridgeToolCall>;

export const BridgeToolResult = z.discriminatedUnion("ok", [
  z.object({ id: z.string().min(1), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.string().min(1), ok: z.literal(false), error: z.string() }).strict(),
]);
export type BridgeToolResult = z.infer<typeof BridgeToolResult>;

// 인증(핸드셰이크): 익스텐션(WS 클라이언트)이 접속 직후 토큰을 보낸다.
// 토큰 불일치·중복 접속은 허브가 거부(spec §5 단일 연결).
export const BridgeAuth = z.object({ type: z.literal("auth"), token: z.string().min(16) }).strict();
export type BridgeAuth = z.infer<typeof BridgeAuth>;

export const BridgeFrame = z.discriminatedUnion("type", [
  BridgeAuth,
  z.object({ type: z.literal("auth_result"), ok: z.boolean() }).strict(),
  z.object({ type: z.literal("call"), call: BridgeToolCall }).strict(),
  z.object({ type: z.literal("result"), result: BridgeToolResult }).strict(),
  // 생존 확인(spec §4.1): 익스텐션이 ping, 허브가 pong.
  z
    .object({ type: z.literal("ping") })
    .strict(),
  z.object({ type: z.literal("pong") }).strict(),
]);
export type BridgeFrame = z.infer<typeof BridgeFrame>;
