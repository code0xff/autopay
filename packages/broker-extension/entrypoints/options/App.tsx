import type { PaymentPolicy } from "@autopay/shared";
import { useEffect, useState } from "react";
import type { UiState } from "../../src/background/compose.js";
import { ThemeToggle } from "../../src/ui/ThemeToggle.js";
import { Unlock } from "../../src/ui/Unlock.js";
import { getState, setBridgeToken, setPolicy, setProfile } from "../../src/ui/rpc-client.js";

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
      <Unlock locked={state.locked} onDone={refresh} />
      <PolicyForm policy={state.policy} onSaved={refresh} />
      <ProfileForm hasProfile={state.hasProfile} locked={state.locked} onSaved={refresh} />
      <BridgeCard
        connected={state.bridgeConnected}
        hasToken={state.hasBridgeToken}
        onSaved={refresh}
      />
      <AuditTable state={state} />
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

function PolicyForm({ policy, onSaved }: { policy: PaymentPolicy; onSaved: () => void }) {
  const [p, setP] = useState<PaymentPolicy>(policy);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const num = (v: string) => Number.parseInt(v.replace(/[^\d]/g, ""), 10) || 0;

  // 저장된 정책이 갱신되면 폼에 반영(저장 후·재로드 시 최신값 표시).
  // biome-ignore lint/correctness/useExhaustiveDependencies: policy 스냅샷이 바뀔 때만 동기화
  useEffect(() => {
    setP(policy);
  }, [JSON.stringify(policy)]);

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 10 }}>
        결제 한도
      </div>
      <div className="grid2">
        <label className="field">
          <span>건당</span>
          <input
            className="input mono"
            value={String(p.limits.perTransaction)}
            onChange={(e) =>
              setP({ ...p, limits: { ...p.limits, perTransaction: num(e.target.value) } })
            }
          />
        </label>
        <label className="field">
          <span>일 누적</span>
          <input
            className="input mono"
            value={String(p.limits.daily)}
            onChange={(e) => setP({ ...p, limits: { ...p.limits, daily: num(e.target.value) } })}
          />
        </label>
        <label className="field">
          <span>월 누적</span>
          <input
            className="input mono"
            value={String(p.limits.monthly)}
            onChange={(e) => setP({ ...p, limits: { ...p.limits, monthly: num(e.target.value) } })}
          />
        </label>
        <label className="field">
          <span>일 횟수</span>
          <input
            className="input mono"
            value={String(p.limits.maxTransactionsPerDay)}
            onChange={(e) =>
              setP({ ...p, limits: { ...p.limits, maxTransactionsPerDay: num(e.target.value) } })
            }
          />
        </label>
      </div>
      <label className="field">
        <span>초과 시 확인 요구 (₩)</span>
        <input
          className="input mono"
          value={String(p.confirmation.requireUserConfirmationAbove)}
          onChange={(e) =>
            setP({
              ...p,
              confirmation: {
                ...p.confirmation,
                requireUserConfirmationAbove: num(e.target.value),
              },
            })
          }
        />
      </label>
      <label className="listrow">
        <span>항상 확인</span>
        <input
          type="checkbox"
          checked={p.confirmation.alwaysConfirm}
          onChange={(e) =>
            setP({ ...p, confirmation: { ...p.confirmation, alwaysConfirm: e.target.checked } })
          }
        />
      </label>

      <div className="label" style={{ margin: "16px 0 10px" }}>
        허용 머천트
      </div>
      <label className="listrow">
        <span>모든 머천트 허용</span>
        <input
          type="checkbox"
          checked={p.merchants.mode === "any"}
          onChange={(e) =>
            setP({
              ...p,
              merchants: { ...p.merchants, mode: e.target.checked ? "any" : "allowlist" },
            })
          }
        />
      </label>
      {p.merchants.mode === "allowlist" && (
        <label className="field">
          <span>
            허용 오리진 목록 (쉼표로 구분, 예: https://coupang.com, https://www.coupang.com)
          </span>
          <input
            className="input mono"
            value={p.merchants.origins.join(", ")}
            onChange={(e) =>
              setP({
                ...p,
                merchants: {
                  ...p.merchants,
                  origins: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              })
            }
          />
        </label>
      )}

      <div className="label" style={{ margin: "16px 0 10px" }}>
        결제 수단
      </div>
      <div className="row" style={{ gap: 14, marginBottom: 10 }}>
        {(["coupay", "kakaopay", "tosspay"] as const).map((m) => (
          <label key={m} className="listrow" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={p.methods.includes(m)}
              onChange={(e) =>
                setP({
                  ...p,
                  methods: e.target.checked ? [...p.methods, m] : p.methods.filter((x) => x !== m),
                })
              }
            />
            <span>{m}</span>
          </label>
        ))}
      </div>

      <div className="label" style={{ margin: "16px 0 10px" }}>
        카테고리
      </div>
      <label className="listrow">
        <span>거부 목록 모드(체크 해제 시 허용 목록 모드)</span>
        <input
          type="checkbox"
          checked={p.categories.mode === "denylist"}
          onChange={(e) =>
            setP({
              ...p,
              categories: { ...p.categories, mode: e.target.checked ? "denylist" : "allowlist" },
            })
          }
        />
      </label>
      <label className="field">
        <span>
          {p.categories.mode === "denylist" ? "거부" : "허용"} 카테고리 목록 (쉼표로 구분, 비워두면{" "}
          {p.categories.mode === "denylist" ? "아무 것도 거부하지 않음" : "아무 것도 허용하지 않음"}
          )
        </span>
        <input
          className="input mono"
          value={p.categories.values.join(", ")}
          onChange={(e) =>
            setP({
              ...p,
              categories: {
                ...p.categories,
                values: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
            })
          }
        />
      </label>

      <button
        type="button"
        className="btn btn-primary btn-block"
        style={{ marginTop: 10 }}
        onClick={async () => {
          try {
            await setPolicy(p);
            setMsg({ kind: "ok", text: "저장됨" });
            onSaved();
          } catch (e) {
            setMsg({ kind: "err", text: `저장 실패: ${e instanceof Error ? e.message : "오류"}` });
          }
        }}
      >
        정책 저장
      </button>
      {msg && (
        <div className={`badge ${msg.kind === "ok" ? "ok" : "danger"}`} style={{ marginTop: 10 }}>
          {msg.text}
        </div>
      )}
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
            className="btn btn-primary"
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
        className="btn btn-primary"
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
