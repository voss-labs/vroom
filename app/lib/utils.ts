import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Eight handle colours held at matched lightness and saturation so no speaker
 * outshouts another. The orange-red band is deliberately absent: brand orange
 * means "you", muted red means "bad" (VRIP-05, after vask's style.go).
 */
const PALETTE = [
  "var(--handle-0, #5cb88a)",
  "var(--handle-1, #4fa9a6)",
  "var(--handle-2, #5f9fd0)",
  "var(--handle-3, #8093dd)",
  "var(--handle-4, #a98ad4)",
  "var(--handle-5, #c98ac0)",
  "var(--handle-6, #cfa04e)",
  "var(--handle-7, #8fb45f)",
] as const;

export const BRAND = "var(--color-brand, #fb7a3c)";

export function handleColour(handle: string, self?: string): string {
  if (self && handle === self) return BRAND;
  let h = 0;
  for (let i = 0; i < handle.length; i++)
    h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The audit trail is read months later, so its rows carry a date. */
export function auditTime(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
