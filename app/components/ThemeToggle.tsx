import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

export type Theme = "dark" | "light";

const STORAGE_KEY = "vrooms-theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Private browsing or blocked storage falls back to dark.
  }
  return "dark";
}

function applyTheme(next: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore storage write errors in restricted browsing modes.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = readTheme();
    setTheme(current);
    applyTheme(current);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      data-testid="theme-toggle"
      className={cn(
        "tag hover:border-line-3 hover:text-ink min-h-8 cursor-pointer gap-1.5 px-2.5 transition-colors max-[640px]:min-h-9",
        className,
      )}
    >
      {isLight ? (
        <>
          <Moon className="size-3.5 shrink-0" />
          <span className="max-[480px]:sr-only">Dark</span>
        </>
      ) : (
        <>
          <Sun className="text-brand size-3.5 shrink-0" />
          <span className="max-[480px]:sr-only">Light</span>
        </>
      )}
    </button>
  );
}
