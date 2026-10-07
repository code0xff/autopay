import type { ReactNode } from "react";

// 어시스턴트 답변용 최소 마크다운 렌더러. 모델 출력은 신뢰하지 않는 입력이라
// (웹페이지 내용이 섞여 들어올 수 있다) HTML을 주입하지 않고 React 노드로만 만든다.
// 링크는 **클릭할 수 없는 글자**로 보여준다 — 답변 속 링크를 눌러 결제·로그인 화면으로
// 가는 습관은 피싱과 구별할 수 없다(docs/spec/executor.md §3.2와 같은 이유).
// 지원: 문단, 제목(#), 목록(-, *, 1.), 코드 블록(```), 굵게, 기울임, 인라인 코드.

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s][^*\n]*\*)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${i}:${part.slice(0, 8)}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return <span key={key}>{`${link[1]} (${link[2]})`}</span>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "pre"; text: string };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```"); i++) {
        body.push(lines[i] ?? "");
      }
      blocks.push({ kind: "pre", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", text: heading[1] ?? "" });
      continue;
    }
    const item = /^\s*(?:([-*])|\d+[.)])\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (last?.kind === kind) last.items.push(item[2] ?? "");
      else blocks.push({ kind, items: [item[2] ?? ""] });
      continue;
    }
    // 빈 줄 없이 이어지는 줄은 같은 문단. 직전 줄이 비었으면 새 문단.
    if (last?.kind === "p" && (lines[i - 1] ?? "").trim() !== "") last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parse(text).map((b, i) => {
        const key = `b${i}`; // 블록은 본문 순서대로 고정된 목록
        if (b.kind === "pre") return <pre key={key}>{b.text}</pre>;
        if (b.kind === "h") return <h4 key={key}>{inline(b.text)}</h4>;
        if (b.kind === "p") {
          // 줄바꿈은 CSS(pre-line)로 살린다 — 줄마다 <br>을 끼워 넣지 않는다.
          return <p key={key}>{inline(b.lines.join("\n"))}</p>;
        }
        const items = b.items.map((it, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 목록 항목도 본문 순서대로 고정
          <li key={j}>{inline(it)}</li>
        ));
        return b.kind === "ul" ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>;
      })}
    </div>
  );
}
