"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

const THEME_STORAGE_KEY = "priceai-theme";
const THEME_CHANGE_EVENT = "priceai-theme-change";
type ThemeMode = "light" | "dark";
type HeaderActionLabelFrom = "sm" | "2xl" | "never";

function getCompactButtonClassName(labelFrom: HeaderActionLabelFrom) {
  if (labelFrom === "never") return "h-11 w-11 gap-0 px-0";
  return labelFrom === "2xl"
    ? "h-9 w-9 gap-0 px-0 2xl:h-10 2xl:w-auto 2xl:gap-2 2xl:px-3"
    : "h-9 w-9 gap-0 px-0 sm:h-10 sm:w-auto sm:gap-2 sm:px-3";
}

function getLabelClassName(compact: boolean, labelFrom: HeaderActionLabelFrom) {
  if (!compact) return undefined;
  if (labelFrom === "never") return "hidden";
  return labelFrom === "2xl" ? "hidden 2xl:inline" : "hidden sm:inline";
}

function readCurrentTheme(): ThemeMode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function subscribeToTheme(onStoreChange: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY) return;
    const nextTheme: ThemeMode | null =
      event.newValue === "dark" ? "dark" : event.newValue === "light" ? "light" : null;
    if (nextTheme === null) return;
    if (readCurrentTheme() !== nextTheme) {
      applyTheme(nextTheme);
    }
    onStoreChange();
  }
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getServerThemeSnapshot(): ThemeMode {
  return "light";
}

export function ThemeToggle({
  compact = false,
  labelFrom = "sm",
}: {
  compact?: boolean;
  labelFrom?: HeaderActionLabelFrom;
}) {
  const theme = useSyncExternalStore(subscribeToTheme, readCurrentTheme, getServerThemeSnapshot);
  const nextTheme: ThemeMode = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;

  function toggleTheme() {
    applyTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Theme persistence is best-effort; the active page can still switch immediately.
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-[#2d3435] shadow-[0_10px_30px_rgba(45,52,53,0.06)] ring-1 ring-[#adb3b4]/25 transition hover:-translate-y-0.5 hover:bg-[#f5f7f7] hover:text-[#202829] ${
        compact ? getCompactButtonClassName(labelFrom) : "h-10 gap-2 px-3"
      }`}
      aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
      title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
    >
      <Icon size={16} />
      <span className={getLabelClassName(compact, labelFrom)}>明暗</span>
    </button>
  );
}
