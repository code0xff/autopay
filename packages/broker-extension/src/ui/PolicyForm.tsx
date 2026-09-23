import type { PaymentPolicy } from "@autopay/shared";
import { useEffect, useState } from "react";
import { setPolicy } from "./rpc-client.js";

// 결제 정책 편집 폼 — 사이드패널(기본 화면)과 옵션 페이지가 같은 컴포넌트를 쓴다.
export function PolicyForm({ policy, onSaved }: { policy: PaymentPolicy; onSaved: () => void }) {
  const [p, setP] = useState<PaymentPolicy>(policy);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const num = (v: string) => Number.parseInt(v.replace(/[^\d]/g, ""), 10) || 0;
  const toList = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  // 쉼표 구분 목록 입력은 원문 텍스트를 별도 상태로 들고 있는다 — value를
  // p.merchants.origins.join(", ")처럼 배열에서 매번 재구성하면, 끝에 쉼표를
  // 치는 순간 filter(Boolean)이 빈 마지막 조각을 지워버려서 방금 친 쉼표가
  // 화면에서 바로 사라지는 것처럼 보인다(입력 자체가 막힌 것처럼 느껴짐).
  const [originsText, setOriginsText] = useState(policy.merchants.origins.join(", "));
  const [categoriesText, setCategoriesText] = useState(policy.categories.values.join(", "));

  // 저장된 정책이 갱신되면 폼에 반영(저장 후·재로드 시 최신값 표시).
  // biome-ignore lint/correctness/useExhaustiveDependencies: policy 스냅샷이 바뀔 때만 동기화
  useEffect(() => {
    setP(policy);
    setOriginsText(policy.merchants.origins.join(", "));
    setCategoriesText(policy.categories.values.join(", "));
  }, [JSON.stringify(policy)]);

  return (
    <div className="card">
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
            value={originsText}
            onChange={(e) => {
              setOriginsText(e.target.value);
              setP({ ...p, merchants: { ...p.merchants, origins: toList(e.target.value) } });
            }}
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
          value={categoriesText}
          onChange={(e) => {
            setCategoriesText(e.target.value);
            setP({
              ...p,
              categories: {
                ...p.categories,
                values: toList(e.target.value),
              },
            });
          }}
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
