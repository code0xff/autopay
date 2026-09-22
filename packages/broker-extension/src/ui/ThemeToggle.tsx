import { useState } from "react";
import { toggleTheme } from "./rpc-client.js";

// 텍스트 "테마" 버튼 대신 아이콘 하나로 — 현재 라이트면 달, 다크면 해 아이콘을
// 눌러서 반대쪽으로 전환(다음에 뭐가 될지 보여주는 아이콘 관례).
function isDark(): boolean {
  try {
    const root = document.documentElement;
    return (
      root.getAttribute("data-theme") === "dark" ||
      (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches)
    );
  } catch {
    return false;
  }
}

export function ThemeToggle() {
  const [dark, setDark] = useState(isDark);
  return (
    <button
      type="button"
      className="icon-btn icon-btn-square"
      aria-label={dark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={dark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      onClick={() => {
        toggleTheme();
        setDark(isDark());
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
