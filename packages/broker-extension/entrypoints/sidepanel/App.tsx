import { useEffect, useState } from "react";
import type { UiState } from "../../src/background/compose.js";
import {
  addWatch,
  getState,
  removeWatch,
  resolveConfirmation,
  toggleTheme,
} from "../../src/ui/rpc-client.js";

const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [tab, setTab] = useState<"activity" | "watch">("activity");
  const refresh = () => getState().then(setState);
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
        <span className="badge ok">감시 {state?.watches.length ?? 0}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={toggleTheme}>
          테마
        </button>
      </header>

      <nav className="tabs" role="tablist">
        <button type="button" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>
          활동
        </button>
        <button type="button" aria-selected={tab === "watch"} onClick={() => setTab("watch")}>
          감시
        </button>
      </nav>

      {state?.locked && (
        <div className="body">
          <div className="card badge warn">잠김 — 옵션에서 패스프레이즈로 잠금 해제하세요</div>
        </div>
      )}

      {tab === "activity" ? (
        <Activity
          state={state}
          onResolve={async (id, ok) => {
            await resolveConfirmation(id, ok);
            refresh();
          }}
        />
      ) : (
        <Watch state={state} onChange={refresh} />
      )}
    </div>
  );
}

function Activity({
  state,
  onResolve,
}: {
  state: UiState | null;
  onResolve: (requestId: string, approved: boolean) => void;
}) {
  return (
    <div className="body">
      {(state?.pending ?? []).length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          승인 대기 중인 결제가 없습니다.
        </div>
      )}
      {state?.pending.map((p) => (
        <div className="card" key={p.requestId}>
          <div className="label">결제 승인 요청</div>
          <div className="row between" style={{ margin: "8px 0 12px" }}>
            <span style={{ fontWeight: 600 }}>{p.merchant}</span>
            <span className="amount mono">{won(p.amount)}</span>
          </div>
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

      <div className="card">
        <div className="label" style={{ marginBottom: 8 }}>
          최근 활동
        </div>
        {(state?.recentAudit ?? []).length === 0 && <div className="muted">기록 없음</div>}
        {state?.recentAudit.map((r) => (
          <div className="listrow" key={r.id}>
            <span className={`badge ${outcomeClass(r.outcome)}`}>{r.outcome}</span>
            <span style={{ flex: 1 }}>{r.merchant.name}</span>
            <span className="mono muted">{won(r.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Watch({ state, onChange }: { state: UiState | null; onChange: () => void }) {
  const [title, setTitle] = useState("");
  const [ref, setRef] = useState("");
  const [max, setMax] = useState("30000");

  return (
    <div className="body">
      <div className="card">
        <div className="label" style={{ marginBottom: 10 }}>
          새 감시
        </div>
        <label className="field">
          <span>상품 이름</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>상품 URL</span>
          <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
        <label className="field">
          <span>상한가 (₩)</span>
          <input
            className="input mono"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={async () => {
            await addWatch({
              productRef: ref,
              title,
              maxPrice: Number.parseInt(max.replace(/[^\d]/g, ""), 10) || 0,
              freeShippingOnly: true,
              buyOnRestock: false,
              method: "coupay",
            });
            setTitle("");
            setRef("");
            onChange();
          }}
        >
          감시 시작
        </button>
      </div>

      {state?.watches.map((w) => (
        <div className="card" key={w.id}>
          <div className="row between">
            <span style={{ fontWeight: 600, fontSize: 13 }}>{w.title}</span>
            <span className={`badge ${w.status === "condition_met" ? "ok" : "warn"}`}>
              {w.status}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
            {won(w.maxPrice)} 이하 · {w.method}
          </div>
          <button
            type="button"
            className="btn btn-outline"
            onClick={async () => {
              await removeWatch(w.id);
              onChange();
            }}
          >
            삭제
          </button>
        </div>
      ))}
    </div>
  );
}

function outcomeClass(outcome: string): string {
  if (outcome === "approved") return "ok";
  if (outcome === "rejected" || outcome === "failed") return "danger";
  return "solid";
}
