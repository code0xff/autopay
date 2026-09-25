import type { AuditRecord } from "@autopay/shared";
import { useEffect, useState } from "react";
import type { UiState } from "../background/compose.js";
import {
  type NotificationDiagnosis,
  getAudit,
  setBridgeToken,
  testNotification,
} from "./rpc-client.js";

// 탭 앱(AppShell)의 카드들 — 홈·기록·설정 탭에서 쓴다.

// 첫 사용 체크리스트 — 설치 후 무엇이 남았는지 한눈에. 브로커가 알 수 없는 항목
// (쿠팡 로그인·원터치)은 안내만 한다.
// bridgeConnected는 SW 깨어남 직후 브리지 연결까지(~1-2초) false였다가 바뀌는
// 런타임 상태라 체크리스트에 쓰면 깜빡인다. 여기선 사용자가 할 일(토큰 등록
// 여부)만 본다 — 런타임 연결 상태는 설정 탭 BridgeCard가 이미 보여준다.
export function GettingStarted({ state }: { state: UiState }) {
  const limits = state.policy.limits;
  const limitsSet =
    limits.perTransaction > 0 && limits.daily > 0 && limits.maxTransactionsPerDay > 0;
  const steps: { done: boolean | null; title: string; hint: string }[] = [
    {
      done: state.hasBridgeToken,
      title: "Claude Code 연결",
      hint: state.hasBridgeToken
        ? "토큰 등록됨 — Claude Code를 실행하면 자동 연결됩니다"
        : "설정 탭의 'MCP 브리지'에 토큰을 붙여넣으세요(pnpm bootstrap이 클립보드에 복사해 둠)",
    },
    {
      done: limitsSet,
      title: "결제 한도 설정",
      hint: "한도가 0이면 모든 결제가 거절됩니다 — 정책 탭에서 한도를 정하고 저장하세요",
    },
    {
      done: null,
      title: "쿠팡 로그인 · 원터치 결제 켜기",
      hint: "로그인은 직접 해두세요(AutoPay는 로그인을 다루지 않음). 원터치는 쿠팡 앱에서 켭니다",
    },
  ];
  if (steps.every((s) => s.done !== false)) return null; // 확인 가능한 단계가 다 끝나면 숨김
  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 10 }}>
        시작하기
      </div>
      {steps.map((s) => (
        <div
          key={s.title}
          className="listrow"
          style={{ alignItems: "flex-start", justifyContent: "flex-start", gap: 12 }}
        >
          <span
            className={`badge ${s.done === true ? "ok" : s.done === false ? "warn" : "info"}`}
            style={{ flexShrink: 0, whiteSpace: "nowrap", marginTop: 2 }}
          >
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
export function SiteAccessNotice() {
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
      style={{ display: "block", padding: 16, borderRadius: "var(--radius-lg)" }}
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

// 알림 진단 — 결제 알림(비번 입력 요청·실패·완료)이 안 뜰 때 어디서 끊겼는지
// 가리는 용도. 발송 실패는 sender가 삼키고 정책 channels가 비면 조용히 아무 데도
// 안 가서, 밖에서 보면 증상이 완전한 침묵이라 이게 없으면 원인을 못 찾는다.
export function NotificationCheck() {
  const [res, setRes] = useState<NotificationDiagnosis | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      setRes(await testNotification());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  };
  const verdict = (r: NotificationDiagnosis): string => {
    if (r.error) return `Chrome이 알림 생성을 거부했습니다: ${r.error}`;
    if (r.permission === "denied")
      return "Chrome에서 이 확장의 알림이 꺼져 있습니다 — Chrome 설정 → 알림에서 허용하세요.";
    if (!r.chromeChannelEnabled)
      return "정책의 알림 채널에 chrome이 없습니다 — 그래서 결제 알림이 발송되지 않습니다.";
    return "알림을 보냈습니다. 화면에 안 뜬다면 macOS 알림 설정(집중 모드 포함)을 확인하세요.";
  };
  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 6 }}>
        알림 확인
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        비밀번호 입력 요청·결제 완료/실패 알림이 안 뜨면 여기서 경로를 점검하세요.
      </div>
      <button type="button" className="btn btn-outline btn-block" onClick={run} disabled={busy}>
        테스트 알림 보내기
      </button>
      {res && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          <div>{verdict(res)}</div>
          <div className="mono" style={{ marginTop: 6 }}>
            채널: {res.channels.length ? res.channels.join(", ") : "(없음)"} · 권한:{" "}
            {res.permission ?? "알 수 없음"}
          </div>
        </div>
      )}
      {err && (
        <div className="badge danger" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </div>
  );
}

export function BridgeCard({
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
    <div className="card">
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

const PAGE_SIZE = 10;

// 감사 결과 → 상태 배지(점 + 단어, 색은 의미만)
const OUTCOME: Record<AuditRecord["outcome"], { label: string; tone: string }> = {
  approved: { label: "완료", tone: "ok" },
  rejected: { label: "거절", tone: "danger" },
  failed: { label: "실패", tone: "danger" },
  canceled: { label: "취소", tone: "neutral" },
  timeout: { label: "시간 초과", tone: "warn" },
  confirm_required: { label: "승인 대기", tone: "info" },
};

// 기록 탭 — 최신순 10건씩 페이지로. refreshKey가 바뀌면(부모 폴링) 현재 페이지를 다시 읽는다.
export function AuditTable({ refreshKey }: { refreshKey: unknown }) {
  const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ records: AuditRecord[]; total: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey는 재조회 트리거로만 쓴다
  useEffect(() => {
    getAudit(page * PAGE_SIZE, PAGE_SIZE)
      .then(setData)
      .catch(() => undefined);
  }, [page, refreshKey]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 기록이 줄어 현재 페이지가 범위를 벗어나면 마지막 페이지로
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 8 }}>
        결제 기록 (감사 로그)
      </div>
      {data && total === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          아직 결제 기록이 없습니다.
        </div>
      ) : (
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
            {(data?.records ?? []).map((r) => {
              const o = OUTCOME[r.outcome];
              return (
                <tr key={r.id}>
                  <td className="mono muted">{r.at.slice(5, 16).replace("T", " ")}</td>
                  <td>{r.merchant.name}</td>
                  <td className="mono">{won(r.amount)}</td>
                  <td>
                    <span className={`badge ${o.tone}`}>
                      <span className="dot" aria-hidden="true" />
                      {o.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {total > PAGE_SIZE && (
        <div className="row between pager">
          <span className="muted mono" style={{ fontSize: 12 }}>
            {from}–{to} / {total}
          </span>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="icon-btn"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              이전
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            >
              다음
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
