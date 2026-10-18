import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

/**
 * The row overflow menu the prototype builds in JS, plus the table controls it
 * styles inline. Neither is in app.css, so both live here — one component owns
 * the look and both tables import it, which is what keeps them identical.
 */

export interface MenuItem {
  kind?: "item" | "label" | "sep";
  text?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Renders the prototype's tick column. Undefined means no tick column. */
  tick?: boolean;
  /** Column toggles stay open so several can be flipped in one pass. */
  keepOpen?: boolean;
  onSelect?: () => void;
}

export const COL_X = "w-[52px]";
export const COL_A = "w-[56px]";

export const CBX =
  "relative h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-line-3 " +
  "bg-transparent align-middle checked:border-brand checked:bg-brand " +
  "checked:after:absolute checked:after:top-px checked:after:left-[4.5px] checked:after:h-2 " +
  "checked:after:w-1 checked:after:rotate-45 checked:after:border-t-0 checked:after:border-r-2 " +
  "checked:after:border-b-2 checked:after:border-l-0 checked:after:border-[#1a0d05] " +
  "checked:after:content-['']";

/** 44px hit area, pulled back with negative margin so rows keep the prototype's height. */
export const CBX_HIT =
  "-my-2 -ml-3 flex h-11 w-11 cursor-pointer items-center justify-center";

export const DOTS =
  "-my-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-[var(--r-ctl)] " +
  "bg-transparent p-0 text-[15px] leading-none text-ink-2 hover:bg-raised hover:text-ink " +
  "disabled:cursor-not-allowed disabled:opacity-40";

/** Every action failure is shown, with its code, next to the control that caused it. */
export const ERROR_NOTE =
  "text-neg rounded-[var(--r-ctl)] border border-[rgba(159,72,72,0.4)] bg-[var(--neg-dim)] " +
  "px-3 py-2 text-[12.5px]";

export const TBL_FOOT =
  "text-ink-2 flex flex-wrap items-center justify-between gap-3 px-[14px] sm:px-[18px] pt-[14px] pb-[18px] text-[13px]";

export const SORTBTN =
  "-mx-[7px] -my-2 inline-flex min-h-11 cursor-pointer items-center gap-[5px] " +
  "rounded-[var(--r-ctl)] bg-transparent px-[7px] text-[13px] font-medium text-ink-2 " +
  "hover:bg-raised hover:text-ink";

const MENU =
  "fixed z-[60] min-w-[200px] rounded-[var(--r-ctl)] border border-line-3 bg-panel p-[5px] " +
  "shadow-[0_12px_34px_rgba(0,0,0,0.62)]";

const ITEM =
  "flex min-h-11 w-full cursor-pointer items-center gap-[9px] rounded-[5px] px-[9px] py-[7px] " +
  "text-left text-[13.5px] text-ink hover:bg-raised disabled:cursor-not-allowed " +
  "disabled:opacity-40";

const ITEM_DANGER = "text-neg hover:bg-[var(--neg-dim)]";

interface RowMenuProps {
  /** Accessible name for the trigger. */
  label: string;
  items: MenuItem[];
  /** Trigger classes: DOTS for a row, "btn" for the Columns button. */
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}

export function RowMenu({
  label,
  items,
  className,
  disabled,
  children,
}: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPos(null);
    // Synchronous so whatever opens next (the reveal dialog) can capture it.
    if (returnFocus) anchorRef.current?.focus();
  }, []);

  // Anchored to the trigger, flipped above it when there is no room below.
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 10) top = rect.top - height - 6;

    setPos({
      left: Math.max(
        10,
        Math.min(rect.right - width, window.innerWidth - width - 10),
      ),
      top: Math.max(10, top),
    });
    menu.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      )
        return;
      close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close(true);
    }
    function onReflow() {
      close(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, close]);

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) ?? [],
    );
    if (nodes.length === 0) return;
    const here = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? nodes.length - 1
          : event.key === "ArrowDown"
            ? (here + 1 + nodes.length) % nodes.length
            : (here - 1 + nodes.length) % nodes.length;
    nodes[next]?.focus();
  }

  const hasTicks = items.some((item) => item.tick !== undefined);

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className={MENU}
      style={{
        left: pos ? pos.left : 0,
        top: pos ? pos.top : 0,
        visibility: pos ? "visible" : "hidden",
      }}
      onKeyDown={onMenuKeyDown}
    >
      {items.map((item, index) => {
        if (item.kind === "sep") {
          return (
            <div
              key={index}
              className="bg-line-2 my-[5px] h-px"
              role="separator"
            />
          );
        }
        if (item.kind === "label") {
          return (
            <div
              key={index}
              className="text-ink-3 px-[9px] pt-[6px] pb-[5px] text-[12px]"
            >
              {item.text}
            </div>
          );
        }
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={item.danger ? `${ITEM} ${ITEM_DANGER}` : ITEM}
            onClick={(event) => {
              event.stopPropagation();
              if (!item.keepOpen) close(true);
              item.onSelect?.();
            }}
          >
            {hasTicks && (
              <span className="text-brand w-[13px]" aria-hidden="true">
                {item.tick && <Check size={13} strokeWidth={2.5} />}
              </span>
            )}
            <span>{item.text}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(menu, document.body)}
    </>
  );
}
