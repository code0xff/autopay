import { useEffect, useState } from "react";
import type { UiState } from "../../src/background/compose.js";
import { PolicyForm } from "../../src/ui/PolicyForm.js";
import { ThemeToggle } from "../../src/ui/ThemeToggle.js";
import { Unlock } from "../../src/ui/Unlock.js";
import { getState, resolveConfirmation } from "../../src/ui/rpc-client.js";

const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

// 사이드패널 = 기본 화면. 구매는 Claude Code(MCP 브리지)가 하고, 여기서는
// ① 대기 중인 결제를 승인하고(쿠페이 원터치는 폰 승인이 없어 이게 유일한 게이트)
// ② 오늘 남은 한도를 보고 ③ 정책을 바로 고친다. 브리지·본인정보·감사 로그 같은
// 설정은 옵션 페이지에 있다.
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

      {state && (
        <div className="body">
          <Pending
            state={state}
            onResolve={async (id, ok) => {
              try {
                await resolveConfirmation(id, ok);
              } catch {
                // 결과는 폴링으로 갱신됨 — 콘솔 예외로 새지 않게 흡수
              }
              refresh();
            }}
          />

          {/* locked는 "메모리에 PII 복호화 키가 없다"는 뜻일 뿐이라 워커 재시작마다 true다 —
              키가 실제로 필요한 순간(카카오·토스 승인 대기)에만 해제 카드를 띄운다. */}
          {state.locked && state.pending.some((p) => p.method !== "coupay") && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                카카오·토스 결제를 진행하려면 본인 식별 정보 잠금을 해제하세요
              </div>
              <Unlock locked={state.locked} onDone={refresh} />
            </div>
          )}

          <Remaining state={state} />
          <PolicyForm policy={state.policy} onSaved={refresh} />
        </div>
      )}
    </div>
  );
}

// 오늘 남은 한도 — 정책 요약(getPolicySummary와 같은 값)을 한눈에.
function Remaining({ state }: { state: UiState }) {
  const s = state.summary;
  const c = s.confirmation;
  const confirmRule = c.alwaysConfirm
    ? "모든 결제에 승인 필요"
    : c.requireUserConfirmationAbove > 0
      ? `${won(c.requireUserConfirmationAbove)} 초과 시 승인 필요`
      : "승인 없이 실행";
  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 10 }}>
        오늘 남은 한도
      </div>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <span className="amount mono">{won(s.remainingDailyBudget)}</span>
        <span className="muted mono" style={{ fontSize: 12 }}>
          {s.remainingCountToday}회 남음
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        이번 달 {won(s.remainingMonthlyBudget)} · 건당 최대 {won(s.perTransactionLimit)} ·{" "}
        {confirmRule}
      </div>
    </div>
  );
}

function Pending({
  state,
  onResolve,
}: {
  state: UiState;
  onResolve: (requestId: string, approved: boolean) => void;
}) {
  if (state.pending.length === 0) return null; // 대기 건이 있을 때만 맨 위에 보인다
  return (
    <>
      {state.pending.map((p) => (
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
    </>
  );
}
