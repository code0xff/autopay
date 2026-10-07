import { useEffect, useRef, useState } from "react";
import type { AssistantState } from "../assistant/assistant.js";
import { CrowMark } from "./CrowMark.js";
import { Markdown } from "./Markdown.js";
import { AssistantSkeleton } from "./Skeleton.js";
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

const SEND_ERRORS: Record<string, string> = {
  no_response: "백그라운드가 응답하지 않습니다. 확장 프로그램을 리로드한 뒤 다시 시도하세요.",
  internal_error: "이전 요청이 아직 실행 중이거나 내부 오류가 났습니다. 잠시 후 다시 시도하세요.",
  locked: "잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.",
};

const EXAMPLES = [
  "쿠팡에서 2만원 이하 무선 마우스 검은색으로 사줘",
  "쿠팡에서 A4 복사용지 가장 싼 걸로 사줘",
  "오늘 남은 한도 알려줘",
];

export function AssistantTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, refresh } = useAssistant(1000);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  // 전송 직후 백그라운드 상태에 반영되기 전까지 화면에 먼저 보여줄 내 메시지.
  const [sending, setSending] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const count = state?.messages.length ?? 0;
  const lastLen = state?.messages[count - 1]?.text.length ?? 0;
  const running = state?.running ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 새 메시지·스트리밍 진행 시 맨 아래로
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, lastLen, running, sending]);
  // 입력창은 내용만큼 자란다(상한은 CSS max-height).
  // biome-ignore lint/correctness/useExhaustiveDependencies: text가 바뀔 때마다 높이를 다시 잰다
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const signedIn = state?.signedIn ?? false;
  const noModels = (state?.models.length ?? 0) === 0;
  // 입력창의 모델 선택에 쓸 목록 — 아직 없으면 한 번 불러온다.
  useEffect(() => {
    if (signedIn && noModels) assistantLoadModels().catch(() => undefined);
  }, [signedIn, noModels]);

  if (!state) {
    return (
      <div className="chat">
        <div className="chat-scroll">
          <AssistantSkeleton />
        </div>
      </div>
    );
  }
  if (!state.signedIn) {
    return (
      <div className="chat">
        <div className="chat-empty">
          <span className="chat-mark">
            <CrowMark size={26} />
          </span>
          <div className="chat-empty-title">ChatGPT 계정을 연결하세요</div>
          <div className="muted">연결하면 여기서 바로 "○○ 사줘"라고 요청할 수 있습니다.</div>
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            설정에서 연결
          </button>
        </div>
      </div>
    );
  }

  const send = async (preset?: string) => {
    const t = (preset ?? text).trim();
    if (!t || state.running || sending !== null) return;
    setErr("");
    setSending(t);
    if (!preset) setText("");
    try {
      // 백그라운드가 응답하지 않으면 조용히 멈춘 것처럼 보인다 — 상한을 두고 알린다.
      await Promise.race([
        assistantSend(t),
        new Promise((_, reject) => setTimeout(() => reject(new Error("no_response")), 8000)),
      ]);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setErr(SEND_ERRORS[code] ?? `전송 실패: ${code || "알 수 없는 오류"}`);
      if (!preset) setText(t); // 못 보낸 글은 입력창에 되돌린다
    }
    await refresh();
    setSending(null);
  };
  const model = state.model ?? state.models[0]?.slug ?? "";

  return (
    <div className="chat">
      {state.messages.length === 0 && sending === null ? (
        <div className="chat-empty">
          <span className="chat-mark">
            <CrowMark size={26} />
          </span>
          <div className="chat-empty-title">무엇을 도와드릴까요?</div>
          <div className="muted">결제는 항상 정책 한도와 금액 검증을 거칩니다.</div>
          <div className="chat-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => void send(ex)}>
                {ex}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-scroll" ref={scrollRef} aria-live="polite">
          {state.messages.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 대화는 뒤에만 추가되는 목록이라 인덱스가 안정적
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "assistant" ? <Markdown text={m.text} /> : m.text}
            </div>
          ))}
          {sending !== null && <div className="msg user">{sending}</div>}
          {(state.running || sending !== null) && (
            <div className="msg working" aria-label="작업 중">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}
      {err && <div className="chat-error">{err}</div>}
      <div className="composer">
        <textarea
          ref={inputRef}
          rows={3}
          value={text}
          placeholder="구매 요청이나 질문을 입력하세요"
          aria-label="요청 입력"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bar">
          {state.messages.length > 0 && (
            <button
              type="button"
              className="composer-icon"
              aria-label="새 대화"
              title="새 대화"
              disabled={state.running}
              onClick={() => assistantReset().then(refresh)}
            >
              {/* 네모 + 연필 — 채팅 앱에서 "새 대화"로 통용되는 아이콘 */}
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <span className="spacer" />
          {state.models.length > 0 && (
            <select
              className="composer-model"
              aria-label="모델"
              value={model}
              disabled={state.running}
              onChange={(e) => assistantSetModel(e.target.value).then(refresh)}
            >
              {state.models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {state.running ? (
            <button
              type="button"
              className="composer-send"
              aria-label="중단"
              title="중단"
              onClick={() => assistantStop().then(refresh)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              aria-label="보내기"
              title="보내기 (Enter)"
              disabled={!text.trim()}
              onClick={() => void send()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 19V5M6 11l6-6 6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
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
      <DiagnosticLog lines={state.log} />
    </div>
  );
}

// 진단 로그 — 주문 탭 요청이 어디까지 갔고 어디서 멈췄는지 보여준다. 단계·오류 코드·
// 서버 오류 설명만 담기고 토큰이나 대화 내용은 없어서 그대로 복사해 공유해도 된다.
function DiagnosticLog({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");
  return (
    <details className="diag">
      <summary>진단 로그 ({lines.length}줄)</summary>
      <pre className="mono">{text || "아직 기록이 없습니다."}</pre>
      <button
        type="button"
        className="btn btn-outline btn-block"
        disabled={lines.length === 0}
        onClick={() =>
          navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? "복사됨" : "로그 복사"}
      </button>
    </details>
  );
}
