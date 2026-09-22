import { useState } from "react";
import { unlock } from "./rpc-client.js";

// 잠금 해제 폼 — 옵션 페이지 전용이었으나, 사이드패널에서도 옵션으로 이동하지
// 않고 그 자리에서 해제할 수 있도록 공유 컴포넌트로 뺐다(두 곳에서 import).
export function Unlock({ locked, onDone }: { locked: boolean; onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
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
        className="btn btn-primary btn-block"
        onClick={async () => {
          try {
            await unlock(pass);
            setPass("");
            setErr("");
            onDone();
          } catch {
            setErr("패스프레이즈가 올바르지 않습니다");
          }
        }}
      >
        잠금 해제
      </button>
      {err && (
        <div className="badge danger" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </div>
  );
}
