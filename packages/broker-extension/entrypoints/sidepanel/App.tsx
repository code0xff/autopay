import type { PaymentResult } from "@autopay/shared";
import { useEffect, useState } from "react";
import type { UiState } from "../../src/background/compose.js";
import { ThemeToggle } from "../../src/ui/ThemeToggle.js";
import { Unlock } from "../../src/ui/Unlock.js";
import { getState, payActiveTab, resolveConfirmation } from "../../src/ui/rpc-client.js";

const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

// 사이드패널 = 승인 콘솔. 구매는 Claude Code(MCP 브리지)가 하고, 여기는 그
// 결제를 "승인"하거나(쿠페이 원터치는 폰 승인이 없어 이게 유일한 게이트),
// 에이전트 없이 순수 수동으로 결제를 트리거하는 두 가지 일만 한다.
// 감시(가격 폴링) 기능은 제거됨 — 실제로는 작동하지 않는 스텁이었고, 지금은
// 에이전트가 open()/read_page()로 직접 가격을 확인하는 편이 더 유연하다.
// 잠겨있으면 잠금 해제 폼만 보이고, 해제 후에 결제 트리거·승인 화면이 뜬다
// (쿠페이는 잠금 자체가 필요 없지만, "먼저 해제해야 뭔가 할 수 있다"는
// 일관된 멘탈모델을 위해 전체를 잠금 뒤에 둔다).
export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const refresh = () =>
    getState()
      .then(setState)
      .catch(() => undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh는 안정적이며 마운트 시 1회 폴링 시작
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <header className="head">
        <span className="logo">A</span>
        <span className="brand">AutoPay</span>
        <span className="spacer" />
        <ThemeToggle />
      </header>

      {/* 승인은 잠금과 무관하게 항상 보인다 — 잠금은 카카오·토스(패턴 B)의 암호화된
          본인 식별 정보에만 필요하다(그 경우 잠겨 있으면 실행이 no_profile로 실패). */}
      {state && (
        <Approval
          state={state}
          onRefresh={refresh}
          onResolve={async (id, ok) => {
            try {
              await resolveConfirmation(id, ok);
            } catch {
              // 결과는 폴링으로 갱신됨 — 콘솔 예외로 새지 않게 흡수
            }
            refresh();
          }}
        />
      )}

      {/* locked는 "메모리에 PII 복호화 키가 없다"는 뜻일 뿐이라 워커 재시작마다 true다 —
          키가 실제로 필요한 순간(카카오·토스 승인 대기)에만 해제 카드를 띄운다. */}
      {state?.locked && state.pending.some((p) => p.method !== "coupay") && (
        <div className="body">
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            카카오·토스 결제를 진행하려면 본인 식별 정보 잠금을 해제하세요
          </div>
          <Unlock locked={state.locked} onDone={refresh} />
        </div>
      )}
    </div>
  );
}

// 현재 탭 결제의 실패 코드 → 사용자가 바로 할 수 있는 조치 중심 문구.
const PAY_ERRORS: Record<string, string> = {
  no_active_tab: "활성 탭을 찾지 못했습니다. 쿠팡 주문/결제 탭을 연 뒤 다시 눌러주세요.",
  bad_tab_url: "이 탭의 주소를 읽을 수 없습니다. 쿠팡 주문/결제 탭에서 눌러주세요.",
  no_host_permission:
    "AutoPay가 읽을 수 있는 쿠팡 페이지가 아닙니다. 쿠팡 주문/결제 탭(checkout.coupang.com)을 연 상태에서 눌러주세요.",
  page_unreadable: "이 탭의 내용을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 눌러주세요.",
  amount_parse_failed:
    "결제 금액을 찾지 못했습니다. 상품 페이지가 아니라 쿠팡 '주문/결제' 화면에서 눌러주세요.",
  internal_error: "예기치 못한 오류입니다. 확장 프로그램의 서비스 워커 콘솔을 확인해주세요.",
};

const VIOLATIONS: Record<string, string> = {
  over_per_transaction: "건당 한도 초과",
  over_daily: "일 한도 초과",
  over_monthly: "월 한도 초과",
  over_count: "오늘 결제 횟수 초과",
  merchant_not_allowed: "허용되지 않은 쇼핑몰",
  method_not_allowed: "허용되지 않은 결제수단",
  category_not_allowed: "허용되지 않은 카테고리",
  amount_mismatch: "요청 금액과 화면 금액 불일치",
};

function describePayResult(result: PaymentResult | undefined, awaitingConfirm: boolean): string {
  if (!result) return "결제 요청을 만들었습니다.";
  switch (result.status) {
    case "rejected":
      return `정책에 의해 거절됨: ${VIOLATIONS[result.violation] ?? result.violation}`;
    case "failed":
      return `실패: ${PAY_ERRORS[result.error] ?? result.error}`;
    case "pending_user_confirmation":
      return awaitingConfirm
        ? "승인이 필요합니다 — 아래에서 승인하세요."
        : "결제를 진행 중입니다 — 결과는 알림으로 알려드립니다.";
    case "approved":
      return "결제가 완료되었습니다.";
    case "canceled":
      return "결제가 취소되었습니다.";
  }
}

function Approval({
  state,
  onResolve,
  onRefresh,
}: {
  state: UiState | null;
  onResolve: (requestId: string, approved: boolean) => void;
  onRefresh: () => void;
}) {
  const [payMsg, setPayMsg] = useState("");
  return (
    <div className="body">
      <div className="card">
        <div className="label" style={{ marginBottom: 8 }}>
          현재 탭에서 결제 (수동)
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          쿠팡 체크아웃 화면을 연 상태에서 누르면, 그 탭의 금액을 확인해 결제 요청을 만듭니다.
          (원터치 결제 ON + 정책 허용 필요, 에이전트 없이도 사용 가능)
        </div>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={async () => {
            setPayMsg("");
            try {
              const res = await payActiveTab("coupay");
              setPayMsg(describePayResult(res.result, res.awaitingConfirm === true));
              onRefresh();
            } catch (e) {
              const code = e instanceof Error ? e.message : "internal_error";
              setPayMsg(PAY_ERRORS[code] ?? `실패: ${code}`);
            }
          }}
        >
          현재 탭에서 결제 요청 (쿠팡)
        </button>
        {payMsg && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {payMsg}
          </div>
        )}
      </div>

      {(state?.pending ?? []).length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          승인 대기 중인 결제가 없습니다.
        </div>
      )}
      {state?.pending.map((p) => (
        <div className="card" key={p.requestId}>
          <div className="row between">
            <span className="label">결제 승인 요청</span>
            <span className={`badge ${p.method === "coupay" ? "warn" : "info"}`}>
              {p.method === "coupay" ? "쿠페이 · 원터치" : p.method}
            </span>
          </div>
          <div className="row between" style={{ margin: "8px 0 4px" }}>
            <span style={{ fontWeight: 600 }}>{p.merchant}</span>
            <span className="amount mono">{won(p.amount)}</span>
          </div>
          {p.method === "coupay" && (
            <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
              쿠팡 원터치는 폰 승인이 없어, 이 확인이 유일한 게이트입니다.
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-outline btn-block"
              onClick={() => onResolve(p.requestId, false)}
            >
              거절
            </button>
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => onResolve(p.requestId, true)}
            >
              승인하고 결제
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
