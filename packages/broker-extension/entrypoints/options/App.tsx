import type { PaymentPolicy } from "@autopay/shared";
import { useEffect, useState } from "react";
import type { UiState } from "../../src/background/compose.js";
import { PolicyForm } from "../../src/ui/PolicyForm.js";
import { ThemeToggle } from "../../src/ui/ThemeToggle.js";
import { Unlock } from "../../src/ui/Unlock.js";
import { getState, setBridgeToken, setProfile } from "../../src/ui/rpc-client.js";

export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const refresh = () =>
    getState()
      .then(setState)
      .catch(() => undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh는 안정적이며 마운트 시 1회만 로드
  useEffect(() => {
    refresh();
  }, []);

  if (!state) return <div className="options">불러오는 중…</div>;
  return (
    <div className="options">
      <header className="row between" style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>정책 · 설정</h1>
        <ThemeToggle />
      </header>

      <SiteAccessNotice />
      <GettingStarted state={state} />

      {/* 잠금(패스프레이즈)은 암호화된 본인 식별 정보(패턴 B)에만 필요하다 —
          정책·브리지·감사까지 잠그면 쿠팡(패턴 C)만 쓰는 사용자도 매번 해제해야 했다. */}
      <PolicyForm policy={state.policy} onSaved={refresh} />
      <BridgeCard
        connected={state.bridgeConnected}
        hasToken={state.hasBridgeToken}
        onSaved={refresh}
      />
      <Unlock locked={state.locked} onDone={refresh} />
      <ProfileForm hasProfile={state.hasProfile} locked={state.locked} onSaved={refresh} />
      <AuditTable state={state} />
    </div>
  );
}

// 첫 사용 체크리스트 — 설치 후 무엇이 남았는지 한눈에. 브로커가 알 수 없는 항목
// (쿠팡 로그인·원터치)은 안내만 한다.
function GettingStarted({ state }: { state: UiState }) {
  const limits = state.policy.limits;
  const limitsSet =
    limits.perTransaction > 0 && limits.daily > 0 && limits.maxTransactionsPerDay > 0;
  const steps: { done: boolean | null; title: string; hint: string }[] = [
    {
      done: state.bridgeConnected,
      title: "Claude Code 연결",
      hint: state.hasBridgeToken
        ? "토큰 등록됨 — Claude Code를 실행하면 자동 연결됩니다"
        : "아래 'MCP 브리지'에 토큰을 붙여넣으세요(pnpm bootstrap이 클립보드에 복사해 둠)",
    },
    {
      done: limitsSet,
      title: "결제 한도 설정",
      hint: "기본값은 0원(전부 거절)입니다 — 아래 '결제 한도'를 정하고 저장하세요",
    },
    {
      done: null,
      title: "쿠팡 로그인 · 원터치 결제 켜기",
      hint: "로그인은 직접 해두세요(AutoPay는 로그인을 다루지 않음). 원터치는 쿠팡 앱에서 켭니다",
    },
  ];
  if (steps.every((s) => s.done !== false)) return null; // 확인 가능한 단계가 다 끝나면 숨김
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 10 }}>
        시작하기
      </div>
      {steps.map((s) => (
        <div key={s.title} className="listrow" style={{ alignItems: "flex-start", gap: 10 }}>
          <span className={`badge ${s.done === true ? "ok" : s.done === false ? "warn" : "info"}`}>
            {s.done === true ? "완료" : s.done === false ? "필요" : "확인"}
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>{s.title}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {s.hint}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// AGENTS.md §2.6·§9 — 다른 브라우저 에이전트 익스텐션(Claude for Chrome 등)의
// 사이트 접근은 브로커가 강제할 수 없다(익스텐션 간 권한 격리 밖). 검증·차단이
// 아니라 안내 수준으로만 고지한다 — 이게 정직하게 할 수 있는 전부다.
function SiteAccessNotice() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("autopay-site-access-notice-dismissed") === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div
      className="card badge warn"
      style={{ marginBottom: 14, display: "block", padding: 16, borderRadius: "var(--radius-lg)" }}
    >
      <div style={{ marginBottom: 6 }}>
        다른 브라우저 에이전트 익스텐션(예: Claude for Chrome)을 함께 쓴다면, 그 익스텐션의 사이트
        접근 권한(특히 쿠키·결제창 도메인)을 AutoPay가 강제로 제한할 수 없습니다. 민감한 세션과
        자동쇼핑 세션은 별도 브라우저 프로필로 분리하는 걸 권장합니다.
      </div>
      <button
        type="button"
        className="icon-btn"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem("autopay-site-access-notice-dismissed", "1");
          } catch {}
        }}
      >
        확인함
      </button>
    </div>
  );
}

function ProfileForm({
  hasProfile,
  locked,
  onSaved,
}: {
  hasProfile: boolean;
  locked: boolean;
  onSaved: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [birth, setBirth] = useState("");
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 4 }}>
        본인 식별 정보 (패턴 B)
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        암호화 저장, 로그에 남기지 않음. {hasProfile ? "· 저장됨" : ""}
      </div>
      {locked ? (
        <div className="badge warn">먼저 잠금 해제하세요</div>
      ) : (
        <>
          <div className="grid2">
            <label className="field">
              <span>휴대폰</span>
              <input
                className="input mono"
                type="password"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label className="field">
              <span>생년월일</span>
              <input
                className="input mono"
                type="password"
                value={birth}
                onChange={(e) => setBirth(e.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={async () => {
              await setProfile({ phone, birth });
              setPhone("");
              setBirth("");
              onSaved();
            }}
          >
            저장
          </button>
        </>
      )}
    </div>
  );
}

function BridgeCard({
  connected,
  hasToken,
  onSaved,
}: {
  connected: boolean;
  hasToken: boolean;
  onSaved: () => void;
}) {
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 4 }}>
        MCP 브리지 (Claude Code 스킬 연동)
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        <code>~/.autopay/bridge-token</code>의 토큰을 붙여넣으세요. 결제는 여기서 항상
        정책·확인·감사를 거칩니다(AGENTS §2.6).
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <span className={`badge ${connected ? "ok" : hasToken ? "warn" : "danger"}`}>
          {connected ? "연결됨" : hasToken ? "토큰 등록됨 · 연결 대기" : "미등록"}
        </span>
      </div>
      <label className="field">
        <span>브리지 토큰</span>
        <input
          className="input mono"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? "다시 입력하면 교체됩니다" : ""}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={token.length < 16}
        onClick={async () => {
          try {
            await setBridgeToken(token);
            setToken("");
            setMsg({ kind: "ok", text: "등록됨 — 접속을 시도합니다" });
            onSaved();
          } catch (e) {
            setMsg({ kind: "err", text: `등록 실패: ${e instanceof Error ? e.message : "오류"}` });
          }
        }}
      >
        토큰 등록
      </button>
      {msg && (
        <div className={`badge ${msg.kind === "ok" ? "ok" : "danger"}`} style={{ marginTop: 10 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

function AuditTable({ state }: { state: UiState }) {
  const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;
  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 8 }}>
        최근 결제 (감사 로그)
      </div>
      <table>
        <thead>
          <tr>
            <th>시각</th>
            <th>가맹점</th>
            <th>금액</th>
            <th>결과</th>
          </tr>
        </thead>
        <tbody>
          {state.recentAudit.map((r) => (
            <tr key={r.id}>
              <td className="mono muted">{r.at.slice(5, 16).replace("T", " ")}</td>
              <td>{r.merchant.name}</td>
              <td className="mono">{won(r.amount)}</td>
              <td>{r.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
