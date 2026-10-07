import { useEffect, useRef, useState } from "react";
import type { UiState } from "../background/compose.js";
import { AssistantTab, ChatGptCard } from "./Assistant.js";
import { CrowMark } from "./CrowMark.js";
import { PolicyForm } from "./PolicyForm.js";
import { HomeSkeleton } from "./Skeleton.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { LockButton, LockScreen } from "./Unlock.js";
import {
  AuditTable,
  BridgeCard,
  GettingStarted,
  NotificationCheck,
  SiteAccessNotice,
} from "./cards.js";
import { cancelExecution, getState, resolveConfirmation } from "./rpc-client.js";

// 사이드패널과 옵션 페이지가 같은 탭 앱을 띄운다 — 화면이 겹치거나 한쪽에만
// 있는 기능이 생기지 않도록. 탭은 기능별: 홈(승인·남은 한도) / 정책 / 기록 / 설정.

type Tab = "home" | "assistant" | "policy" | "history" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "홈" },
  { id: "assistant", label: "주문" },
  { id: "policy", label: "정책" },
  { id: "history", label: "기록" },
  { id: "settings", label: "설정" },
];
const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

export function AppShell({ wide = false }: { wide?: boolean }) {
  const [state, setState] = useState<UiState | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  // 잠금 해제 상태의 이전 값 — locked→unlocked 전환 감지용. 아직 첫 로드 전이면 null.
  const wasLockedRef = useRef<boolean | null>(null);
  // 마지막 getState 실패 사유 — 성공하면 null. 무한 "불러오는 중…" 대신 원인을 보여준다.
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = () =>
    getState()
      .then((s) => {
        setState(s);
        setLoadError(null);
        const wasLocked = wasLockedRef.current;
        if (!s.locked && (wasLocked === null || wasLocked === true)) {
          // 최초 로드 또는 잠금 해제 직후에만 탭을 자동 선택 — 폴링 갱신으로는 건드리지 않음
          setTab(s.hasBridgeToken ? "home" : "settings");
        }
        wasLockedRef.current = s.locked;
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh는 안정적이며 마운트 시 1회 폴링 시작
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  const choose = (t: Tab) => setTab(t);
  const pendingCount = state?.pending.length ?? 0;

  return (
    <div className={wide ? "shell wide" : "shell"}>
      <header className="head">
        <span className="logo">
          <CrowMark />
        </span>
        <span className="brand">NightPay</span>
        <span className="spacer" />
        {state && !state.locked && <LockButton onDone={refresh} />}
        <ThemeToggle />
      </header>
      {state?.locked ? (
        <div className="body">
          <LockScreen firstRun={!state.hasPassphrase} onDone={refresh} />
        </div>
      ) : (
        <>
          <nav className="tabs" role="tablist" aria-label="NightPay">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-label={
                  t.id === "home" && pendingCount > 0
                    ? `${t.label} (승인 대기 ${pendingCount}건)`
                    : undefined
                }
                title={
                  t.id === "home" && pendingCount > 0 ? `승인 대기 ${pendingCount}건` : undefined
                }
                onClick={() => choose(t.id)}
              >
                <span className="tab-label">
                  {t.label}
                  {t.id === "home" && pendingCount > 0 && (
                    <span className="count" aria-hidden="true" />
                  )}
                </span>
              </button>
            ))}
          </nav>

          {!state ? (
            loadError ? (
              <div className="body">
                <p>상태를 불러오지 못했습니다</p>
                <p className="muted">{loadError}</p>
                <button type="button" className="btn btn-outline" onClick={refresh}>
                  다시 시도
                </button>
              </div>
            ) : (
              <div className="body">
                <HomeSkeleton />
              </div>
            )
          ) : (
            <div className={tab === "assistant" ? "body body-chat" : "body"}>
              {tab === "home" && <Home state={state} onRefresh={refresh} />}
              {tab === "assistant" && <AssistantTab onOpenSettings={() => choose("settings")} />}
              {tab === "policy" && <PolicyForm policy={state.policy} onSaved={refresh} />}
              {tab === "history" && <AuditTable refreshKey={state} />}
              {tab === "settings" && (
                <>
                  <BridgeCard
                    connected={state.bridgeConnected}
                    hasToken={state.hasBridgeToken}
                    onSaved={refresh}
                  />
                  <ChatGptCard />
                  <NotificationCheck />
                  <SiteAccessNotice />
                </>
              )}
            </div>
          )}
        </>
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
      <Remaining state={state} />
      <Executing state={state} onRefresh={onRefresh} />
      <Pending state={state} onResolve={resolve} />
    </>
  );
}

// 진행 중인 결제 — 실행은 시작됐는데 아직 안 끝난 건(쿠팡이 비밀번호를 요구해 입력을
// 기다리는 중 등). 이 동안에는 페이지 도구가 잠기므로, 그만두려면 여기서 취소한다.
function Executing({ state, onRefresh }: { state: UiState; onRefresh: () => void }) {
  if (state.executing.length === 0) return null;
  const focus = async (tabId: number) => {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // 탭이 이미 닫혔다 — 브로커가 곧 취소로 정리한다
    }
  };
  const cancel = async (id: string) => {
    try {
      await cancelExecution(id);
    } catch {
      // 결과는 폴링으로 갱신됨
    }
    onRefresh();
  };
  return (
    <>
      {state.executing.map((e) => (
        <div className="card" key={e.requestId}>
          <div className="row between">
            <span className="label">진행 중인 결제</span>
            <span className="badge warn">입력 대기</span>
          </div>
          <div className="row between" style={{ margin: "8px 0 4px" }}>
            <span style={{ fontWeight: 600 }}>{e.merchant}</span>
            <span className="amount mono">{won(e.amount)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            결제 탭에서 마무리하거나 여기서 취소하세요. 취소는 NightPay의 대기를 끝낼 뿐이며,
            쇼핑몰에서 이미 승인된 결제는 되돌리지 못합니다.
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-outline btn-block"
              onClick={() => cancel(e.requestId)}
            >
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => focus(e.tabId)}
            >
              결제 탭 열기
            </button>
          </div>
        </div>
      ))}
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
      <div className="card muted" style={{ fontSize: 13 }}>
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
