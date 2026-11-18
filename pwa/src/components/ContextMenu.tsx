import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem =
  | { type: "separator"; id: string }
  | {
      type: "item";
      id: string;
      label: string;
      disabled?: boolean;
      onClick?: () => void;
    };

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Prefer opening upward from (x,y) — needed near the composer dock. */
  preferUp?: boolean;
};

type Props = {
  menu: ContextMenuState | null;
  onClose: () => void;
};

const VIEWPORT_PAD = 8;

/** Port of the desktop ContextMenu (web/src/components/ContextMenu.tsx):
 * floating clamped card, closes on outside tap / scroll / Escape. */
export function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu?.x ?? 0, top: menu?.y ?? 0, ready: false });

  useLayoutEffect(() => {
    if (!menu) {
      setPos({ left: 0, top: 0, ready: false });
      return;
    }
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = menu.x;
    let top = menu.preferUp ? menu.y - rect.height : menu.y;

    if (!menu.preferUp && top + rect.height > window.innerHeight - VIEWPORT_PAD) {
      top = menu.y - rect.height;
    }
    if (top < VIEWPORT_PAD) top = VIEWPORT_PAD;
    if (top + rect.height > window.innerHeight - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, window.innerHeight - rect.height - VIEWPORT_PAD);
    }
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - rect.width - VIEWPORT_PAD));
    setPos({ left, top, ready: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening contextmenu/pointerdown doesn't instantly dismiss the menu.
    let removePointer: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      const onPointer = (e: MouseEvent | PointerEvent) => {
        if (ref.current?.contains(e.target as Node)) return;
        onClose();
      };
      window.addEventListener("pointerdown", onPointer, true);
      removePointer = () => window.removeEventListener("pointerdown", onPointer, true);
    }, 0);
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(timer);
      removePointer?.();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, onClose]);

  if (!menu || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      className={`claw-context-menu${pos.ready ? " claw-context-menu--ready" : ""}`}
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item) => {
        if (item.type === "separator") {
          return <div key={item.id} className="claw-context-menu-sep" role="separator" />;
        }
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className="claw-context-menu-item"
            onClick={() => {
              if (item.disabled) return;
              item.onClick?.();
              onClose();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body
  );
}

/** Selection text inside `root` (empty when the window selection is elsewhere). */
export function selectionTextIn(root: ParentNode | null | undefined): string {
  if (!root || typeof window === "undefined") return "";
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return "";
  return sel.toString();
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebView without clipboard permission for this gesture: execCommand fallback.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
