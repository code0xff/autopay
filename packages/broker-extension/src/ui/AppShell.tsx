import { useEffect, useState } from "react";
import type { UiState } from "../background/compose.js";
import { PolicyForm } from "./PolicyForm.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { Unlock } from "./Unlock.js";
import { AuditTable, BridgeCard, GettingStarted, ProfileForm, SiteAccessNotice } from "./cards.js";
import { getState, resolveConfirmation } from "./rpc-client.js";

// 사이드패널과 옵션 페이지가 같은 탭 앱을 띄운다 — 화면이 겹치거나 한쪽에만
// 있는 기능이 생기지 않도록. 탭은 기능별: 홈(승인·남은 한도) / 정책 / 기록 / 설정.

type Tab = "home" | "policy" | "history" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "홈" },
  { id: "policy", label: "정책" },
  { id: "history", label: "기록" },
  { id: "settings", label: "설정" },
];
const TAB_KEY = "autopay-tab";

const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

function initialTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t && TABS.some((x) => x.id === t)) return t as Tab;
  } catch {}
  return "home";
}

export function AppShell({ wide = false }: { wide?: boolean }) {
  const [state, setState] = useState<UiState | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
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

  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
  };
  const pendingCount = state?.pending.length ?? 0;

  return (
    <div className={wide ? "shell wide" : "shell"}>
      <header className="head">
        <span className="logo">A</span>
        <span className="brand">AutoPay</span>
        <span className="spacer" />
        <ThemeToggle />
      </header>
      <nav className="tabs" role="tablist" aria-label="AutoPay">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => choose(t.id)}
          >
            {t.label}
            {t.id === "home" && pendingCount > 0 && (
              <span className="count" aria-label={`승인 대기 ${pendingCount}건`}>
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {!state ? (
        <div className="body muted">불러오는 중…</div>
      ) : (
        <div className="body">
          {tab === "home" && <Home state={state} onRefresh={refresh} />}
          {tab === "policy" && <PolicyForm policy={state.policy} onSaved={refresh} />}
          {tab === "history" && <AuditTable state={state} />}
          {tab === "settings" && (
            <>
              <BridgeCard
                connected={state.bridgeConnected}
                hasToken={state.hasBridgeToken}
                onSaved={refresh}
              />
              {/* 잠금은 패턴 B 본인 식별 정보(PII)의 복호화 키일 뿐 — 쿠팡엔 불필요 */}
              <Unlock locked={state.locked} onDone={refresh} />
              <ProfileForm hasProfile={state.hasProfile} locked={state.locked} onSaved={refresh} />
              <SiteAccessNotice />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Home({ state, onRefresh }: { state: UiState; onRefresh: () => void }) {
  const resolve = async (id: string, ok: boolean) => {
    try {
      await resolveConfirmation(id, ok);
    } catch {
      // 결과는 폴링으로 갱신됨 — 콘솔 예외로 새지 않게 흡수
    }
    onRefresh();
  };
  return (
    <>
      <GettingStarted state={state} />
      <Pending state={state} onResolve={resolve} />
      {/* locked는 "메모리에 PII 복호화 키가 없다"는 뜻일 뿐이라 워커 재시작마다 true다 —
          키가 실제로 필요한 순간(카카오·토스 승인 대기)에만 해제 카드를 띄운다. */}
      {state.locked && state.pending.some((p) => p.method !== "coupay") && (
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            카카오·토스 결제를 진행하려면 본인 식별 정보 잠금을 해제하세요
          </div>
          <Unlock locked={state.locked} onDone={onRefresh} />
        </div>
      )}
      <Remaining state={state} />
    </>
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
  if (state.pending.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        승인 대기 중인 결제가 없습니다.
      </div>
    );
  }
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
