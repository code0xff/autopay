import { useState } from "react";
import { lock, unlock } from "./rpc-client.js";

// 잠금 화면 — 잠겨 있으면 AutoPay는 비활성이고 이 화면만 보인다. 첫 실행(검증값 없음)이면
// 패스프레이즈를 두 번 입력해 설정한다. 해제 상태는 브라우저를 닫을 때까지 유지된다.
export function LockScreen({ firstRun, onDone }: { firstRun: boolean; onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pass) return;
    if (firstRun && pass !== confirm) {
      setErr("두 패스프레이즈가 다릅니다");
      return;
    }
    setBusy(true);
    try {
      await unlock(pass);
      setPass("");
      setConfirm("");
      setErr("");
      onDone();
    } catch (e) {
      setErr(
        e instanceof Error && e.message === "wrong_passphrase"
          ? "패스프레이즈가 올바르지 않습니다"
          : "잠금 해제에 실패했습니다",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="lock"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="card">
        <div className="label" style={{ marginBottom: 6 }}>
          {firstRun ? "패스프레이즈 설정" : "잠금 해제"}
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          {firstRun
            ? "AutoPay를 여는 패스프레이즈를 정하세요. 잊으면 저장된 본인 식별 정보를 복구할 수 없습니다."
            : "잠금을 해제해야 AutoPay가 결제 요청을 받고 승인할 수 있습니다."}
        </div>
        <label className="field">
          <span>패스프레이즈</span>
          <input
            className="input"
            type="password"
            autoComplete={firstRun ? "new-password" : "current-password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </label>
        {firstRun && (
          <label className="field">
            <span>패스프레이즈 확인</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !pass}>
          {firstRun ? "설정하고 시작" : "잠금 해제"}
        </button>
        {err && (
          <div className="badge danger" style={{ marginTop: 10 }}>
            {err}
          </div>
        )}
      </div>
    </form>
  );
}

// 헤더의 잠금 버튼 — 누르면 즉시 잠기고 잠금 화면으로 돌아간다.
export function LockButton({ onDone }: { onDone: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn-square"
      aria-label="AutoPay 잠그기"
      title="AutoPay 잠그기"
      onClick={async () => {
        try {
          await lock();
        } catch {}
        onDone();
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </button>
  );
}
