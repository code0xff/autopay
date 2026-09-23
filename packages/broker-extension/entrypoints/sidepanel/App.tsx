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
              await payActiveTab("coupay");
              setPayMsg("결제 요청 생성됨 — 아래에서 승인하세요");
              onRefresh();
            } catch (e) {
              setPayMsg(`실패: ${e instanceof Error ? e.message : "오류"}`);
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
