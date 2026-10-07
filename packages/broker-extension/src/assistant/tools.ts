import { BridgeToolCall } from "@autopay/shared";

// 내장 어시스턴트가 쓸 수 있는 도구 = MCP 브리지와 **같은 7개**(docs/spec/mcp-integration.md §3).
// 모델이 낸 인자는 여기서 BridgeToolCall 스키마로 다시 검증한 뒤에만 BridgeTools로 넘긴다 —
// 모델은 익스텐션 안에서 돌아도 신뢰하지 않는 에이전트다(docs/spec/assistant.md §2).

const selector = { type: "string", minLength: 1, maxLength: 300 };
const noArgs = { type: "object", properties: {}, additionalProperties: false };

function fn(name: string, description: string, parameters: unknown) {
  return { type: "function", name, description, parameters, strict: false };
}

export const ASSISTANT_TOOLS = [
  fn("open", "쇼핑몰 https URL(검색 결과·상품 페이지)을 브리지 탭에서 연다.", {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  }),
  fn(
    "read_page",
    "현재 브리지 탭의 보이는 요소 목록(텍스트·셀렉터·링크·금액)을 읽는다. open을 먼저 호출해야 한다.",
    noArgs,
  ),
  fn("click", "read_page가 준 selector의 요소를 클릭한다.", {
    type: "object",
    properties: { selector },
    required: ["selector"],
    additionalProperties: false,
  }),
  fn("fill", "입력 필드에 값을 채운다. 결제 비밀번호·카드번호·로그인 정보는 절대 넣지 않는다.", {
    type: "object",
    properties: { selector, value: { type: "string", maxLength: 500 } },
    required: ["selector", "value"],
    additionalProperties: false,
  }),
  fn(
    "request_payment",
    "체크아웃 화면에서 결제를 '요청'한다. 브로커가 금액을 독립 검증하고 정책을 적용한다. 승인을 대신하지 않는다.",
    {
      type: "object",
      properties: {
        merchant: {
          type: "object",
          properties: { origin: { type: "string" }, name: { type: "string", maxLength: 80 } },
          required: ["origin", "name"],
          additionalProperties: false,
        },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string", maxLength: 200 },
              quantity: { type: "integer", minimum: 1 },
              unitPrice: { type: "integer", minimum: 0 },
              category: { type: "string", maxLength: 80 },
            },
            required: ["title", "quantity", "unitPrice"],
            additionalProperties: false,
          },
        },
        totalAmount: { type: "integer", minimum: 0 },
        currency: { type: "string", enum: ["KRW"] },
        method: { type: "string", enum: ["kakaopay", "tosspay", "coupay"] },
      },
      required: ["merchant", "items", "totalAmount", "currency", "method"],
      additionalProperties: false,
    },
  ),
  fn("get_payment_result", "request_payment가 준 requestId의 결제 상태를 조회한다.", {
    type: "object",
    properties: { requestId: { type: "string" } },
    required: ["requestId"],
    additionalProperties: false,
  }),
  fn(
    "get_policy_summary",
    "결제 전에 먼저 호출: 잔여 예산·건당 한도·허용 머천트/결제수단·확인 규칙을 조회한다.",
    noArgs,
  ),
];

/** 모델의 함수 호출을 브리지 호출로 바꾼다. 스키마에 안 맞으면 null(실행하지 않음). */
export function toBridgeCall(id: string, name: string, argsJson: string): BridgeToolCall | null {
  let args: unknown;
  try {
    args = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
  } catch {
    return null;
  }
  const parsed = BridgeToolCall.safeParse({ id, tool: name, args });
  return parsed.success ? parsed.data : null;
}
