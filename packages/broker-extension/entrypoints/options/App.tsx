import type { PaymentPolicy } from "@autopay/shared";
import { useEffect, useState } from "react";
import type { UiState } from "../../src/background/compose.js";
import { getState, setPolicy, setProfile, toggleTheme, unlock } from "../../src/ui/rpc-client.js";

export function App() {
  const [state, setState] = useState<UiState | null>(null);
  const refresh = () => getState().then(setState);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh는 안정적이며 마운트 시 1회만 로드
  useEffect(() => {
    refresh();
  }, []);

  if (!state) return <div className="options">불러오는 중…</div>;
  return (
    <div className="options">
      <header className="row between" style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>정책 · 설정</h1>
        <button type="button" className="icon-btn" onClick={toggleTheme}>
          테마
        </button>
      </header>

      <Unlock locked={state.locked} onDone={refresh} />
      <PolicyForm policy={state.policy} onSaved={refresh} />
      <ProfileForm hasProfile={state.hasProfile} locked={state.locked} onSaved={refresh} />
      <AuditTable state={state} />
    </div>
  );
}

function Unlock({ locked, onDone }: { locked: boolean; onDone: () => void }) {
  const [pass, setPass] = useState("");
  if (!locked)
    return (
      <div className="card badge ok" style={{ marginBottom: 14 }}>
        잠금 해제됨
      </div>
    );
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 8 }}>
        잠금 해제 (PII 암호화 키)
      </div>
      <label className="field">
        <span>패스프레이즈</span>
        <input
          className="input"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary"
        onClick={async () => {
          await unlock(pass);
          setPass("");
          onDone();
        }}
      >
        잠금 해제
      </button>
    </div>
  );
}

function PolicyForm({ policy, onSaved }: { policy: PaymentPolicy; onSaved: () => void }) {
  const [p, setP] = useState<PaymentPolicy>(policy);
  const num = (v: string) => Number.parseInt(v.replace(/[^\d]/g, ""), 10) || 0;

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
      <button
        type="button"
        className="btn btn-primary btn-block"
        style={{ marginTop: 10 }}
        onClick={async () => {
          await setPolicy(p);
          onSaved();
        }}
      >
        정책 저장
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
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label className="field">
              <span>생년월일</span>
              <input
                className="input mono"
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
