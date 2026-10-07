import { useEffect, useRef, useState } from "react";
import type { AssistantState } from "../assistant/assistant.js";
import {
  assistantCallback,
  assistantLoadModels,
  assistantLogin,
  assistantLogout,
  assistantReset,
  assistantSend,
  assistantSetModel,
  assistantStop,
  getAssistant,
} from "./rpc-client.js";

// 내장 어시스턴트 UI(docs/spec/assistant.md §6). 실행은 background가 하고 여기선
// 상태를 폴링해 보여주기만 한다 — 패널을 닫았다 열어도 대화와 진행이 이어진다.

function useAssistant(intervalMs: number) {
  const [state, setState] = useState<AssistantState | null>(null);
  const refresh = () =>
    getAssistant()
      .then(setState)
      .catch(() => undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh는 안정적이며 마운트 시 1회 폴링 시작
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return { state, refresh };
}

export function AssistantTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, refresh } = useAssistant(1000);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const count = state?.messages.length ?? 0;
  const lastLen = state?.messages[count - 1]?.text.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 새 메시지·스트리밍 진행 시 맨 아래로
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, lastLen]);

  if (!state) return <div className="muted">불러오는 중…</div>;
  if (!state.signedIn) {
    return (
      <div className="card">
        <div className="label" style={{ marginBottom: 6 }}>
          주문
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          ChatGPT 계정을 연결하면 여기서 바로 "○○ 사줘"라고 요청할 수 있습니다.
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={onOpenSettings}>
          설정에서 ChatGPT 연결
        </button>
      </div>
    );
  }

  const send = async () => {
    const t = text.trim();
    if (!t || state.running) return;
    setErr("");
    try {
      await assistantSend(t);
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "전송 실패");
    }
    refresh();
  };

  return (
    <div className="chat">
      {state.messages.length === 0 && (
        <div className="card muted" style={{ fontSize: 13 }}>
          살 것을 적어 주세요. 예: "쿠팡에서 2만원 이하 무선 마우스 검은색으로 사줘". 결제는 항상
          정책 한도와 금액 검증을 거칩니다.
        </div>
      )}
      {state.messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 대화는 뒤에만 추가되는 목록이라 인덱스가 안정적
        <div key={i} className={`msg ${m.role}`}>
          {m.text}
        </div>
      ))}
      {state.running && <div className="msg tool">진행 중…</div>}
      <div ref={endRef} />
      <textarea
        className="input"
        value={text}
        placeholder="무엇을 살까요?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {state.running ? (
        <button
          type="button"
          className="btn btn-outline btn-block"
          onClick={() => assistantStop().then(refresh)}
        >
          중단
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!text.trim()}
          onClick={send}
        >
          보내기
        </button>
      )}
      {state.messages.length > 0 && !state.running && (
        <button
          type="button"
          className="btn btn-outline btn-block"
          onClick={() => assistantReset().then(refresh)}
        >
          새 대화
        </button>
      )}
      {err && <div className="badge danger">{err}</div>}
    </div>
  );
}

export function ChatGptCard() {
  const { state, refresh } = useAssistant(2000);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const signedIn = state?.signedIn ?? false;
  // 로그인되면 계정이 쓸 수 있는 모델 목록을 한 번 불러온다.
  useEffect(() => {
    if (signedIn) assistantLoadModels().catch(() => undefined);
  }, [signedIn]);

  if (!state) return null;
  const run = (p: Promise<unknown>) => {
    setErr("");
    p.catch((e) => setErr(e instanceof Error ? e.message : "실패")).finally(refresh);
  };
  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 4 }}>
        ChatGPT 연결 (주문 탭)
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        ChatGPT 계정으로 로그인하면 주문 탭의 요청을 내 ChatGPT 플랜으로 실행합니다. 토큰은 잠금
        패스프레이즈로 암호화해 이 브라우저에만 저장합니다.
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <span className={`badge ${state.signedIn ? "ok" : state.loginPending ? "warn" : "danger"}`}>
          {state.signedIn ? "연결됨" : state.loginPending ? "로그인 진행 중" : "미연결"}
        </span>
      </div>
      {state.signedIn ? (
        <>
          {state.models.length > 0 && (
            <label className="field">
              <span>모델</span>
              <select
                className="input"
                value={state.model ?? state.models[0]?.slug ?? ""}
                onChange={(e) => run(assistantSetModel(e.target.value))}
              >
                {state.models.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn-outline btn-block"
            onClick={() => run(assistantLogout())}
          >
            연결 해제
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => run(assistantLogin())}
        >
          ChatGPT로 로그인
        </button>
      )}
      {state.loginPending && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: "10px 0 6px" }}>
            승인 후 탭이 자동으로 닫히지 않고 "127.0.0.1" 연결 오류 화면에 머물면, 그 탭의 주소를
            복사해 여기에 붙여넣으세요.
          </div>
          <label className="field">
            <span>콜백 주소</span>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-outline btn-block"
            disabled={!url.startsWith("http://127.0.0.1:")}
            onClick={() => {
              run(assistantCallback(url.trim()));
              setUrl("");
            }}
          >
            주소로 로그인 완료
          </button>
        </>
      )}
      {(err || state.loginError) && (
        <div className="badge danger" style={{ marginTop: 10 }}>
          {err || state.loginError}
        </div>
      )}
    </div>
  );
}
