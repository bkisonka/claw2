import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useT } from "../i18n";
import {
  ContextMenu,
  concealBrowserViewForMenu,
  getTextareaSelection,
  readClipboard,
  revealBrowserViewAfterMenu,
  writeClipboard,
  type ContextMenuItem,
  type ContextMenuState,
} from "./ContextMenu";

type Props = {
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  /** Called only when empty/non-empty changes — not on every keystroke. */
  onEmptyChange?: (empty: boolean) => void;
  /** Clear content when switching chats. */
  resetKey?: string;
  /** Slim single-line look that grows vertically as the user types. */
  variant?: "default" | "web";
};

export type ChatComposerInputHandle = {
  getValue: () => string;
  setValue: (value: string) => void;
  clear: () => void;
  focus: () => void;
};

/** Max input height — half the window (default) or a smaller cap in web bar. */
export function maxComposerHeightPx(variant: "default" | "web" = "default"): number {
  if (typeof window === "undefined") return variant === "web" ? 160 : 320;
  if (variant === "web") return Math.max(88, Math.floor(window.innerHeight * 0.28));
  return Math.max(120, Math.floor(window.innerHeight * 0.5));
}

/**
 * Local input state — parent (Chat + message list) does not re-render on every keystroke.
 */
export const ChatComposerInput = forwardRef<ChatComposerInputHandle, Props>(
  function ChatComposerInput(
    {
      onKeyDown,
      placeholder,
      disabled,
      className,
      "aria-label": ariaLabel,
      onEmptyChange,
      resetKey,
      variant = "default",
    },
    ref
  ) {
    const t = useT();
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
    const emptyRef = useRef(true);
    const variantRef = useRef(variant);
    variantRef.current = variant;

    const commitValue = useCallback(
      (next: string, caret?: number) => {
        setValue(next);
        const empty = !next.trim();
        if (empty !== emptyRef.current) {
          emptyRef.current = empty;
          onEmptyChange?.(empty);
        }
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          if (typeof caret === "number") {
            const c = Math.max(0, Math.min(caret, next.length));
            ta.setSelectionRange(c, c);
          }
          ta.focus();
        });
      },
      [onEmptyChange]
    );

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => value,
        setValue: (v: string) => {
          setValue(v);
          const empty = !v.trim();
          if (empty !== emptyRef.current) {
            emptyRef.current = empty;
            onEmptyChange?.(empty);
          }
        },
        clear: () => {
          setValue("");
          if (!emptyRef.current) {
            emptyRef.current = true;
            onEmptyChange?.(true);
          }
        },
        focus: () => taRef.current?.focus(),
      }),
      [value, onEmptyChange]
    );

    useEffect(() => {
      setValue("");
      setCtxMenu((prev) => {
        if (prev && variantRef.current === "web") void revealBrowserViewAfterMenu();
        return null;
      });
      if (!emptyRef.current) {
        emptyRef.current = true;
        onEmptyChange?.(true);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only on chat switch
    }, [resetKey]);

    const adjustHeight = () => {
      const ta = taRef.current;
      if (!ta) return;
      const v = variantRef.current;
      const maxH = maxComposerHeightPx(v);
      const minH = v === "web" ? 30 : 52;
      ta.style.height = "auto";
      const next = Math.min(Math.max(ta.scrollHeight, minH), maxH);
      ta.style.height = `${next}px`;
      ta.style.overflowY = ta.scrollHeight > maxH ? "auto" : "hidden";
    };

    useEffect(() => {
      adjustHeight();
    }, [value]);

    useEffect(() => {
      const onResize = () => adjustHeight();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);

    const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      const empty = !next.trim();
      if (empty !== emptyRef.current) {
        emptyRef.current = empty;
        onEmptyChange?.(empty);
      }
    };

    const closeComposerMenu = useCallback(() => {
      setCtxMenu((prev) => {
        if (prev && variantRef.current === "web") {
          void revealBrowserViewAfterMenu();
        }
        return null;
      });
    }, []);

    const openComposerMenu = (e: ReactMouseEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const ta = taRef.current;
      if (!ta || disabled) return;
      const selected = getTextareaSelection(ta);
      const hasSelection = selected.length > 0;
      const hasText = value.length > 0;
      const isWeb = variant === "web";
      const taRect = ta.getBoundingClientRect();

      // W: original editable roles (cut/copy/paste/selectAll) + new Clear.
      // C: same edit set + Clear.
      const items: ContextMenuItem[] = isWeb
        ? [
            {
              type: "item",
              id: "w-cut",
              label: t("common.cut"),
              disabled: !hasSelection,
              onClick: () => {
                const start = ta.selectionStart ?? 0;
                const end = ta.selectionEnd ?? 0;
                const chunk = value.slice(start, end);
                void writeClipboard(chunk).then((ok) => {
                  if (!ok) return;
                  commitValue(value.slice(0, start) + value.slice(end), start);
                });
              },
            },
            {
              type: "item",
              id: "w-copy",
              label: t("common.copy"),
              disabled: !hasSelection,
              onClick: () => {
                void writeClipboard(selected);
              },
            },
            {
              type: "item",
              id: "w-paste",
              label: t("common.paste"),
              onClick: () => {
                const start = ta.selectionStart ?? 0;
                const end = ta.selectionEnd ?? 0;
                void readClipboard().then((text) => {
                  if (!text) return;
                  commitValue(value.slice(0, start) + text + value.slice(end), start + text.length);
                });
              },
            },
            {
              type: "item",
              id: "w-select-all",
              label: t("common.selectAll"),
              disabled: !hasText,
              onClick: () => {
                ta.focus();
                ta.setSelectionRange(0, value.length);
              },
            },
            { type: "separator", id: "w-sep-new" },
            {
              type: "item",
              id: "w-clear",
              label: t("common.clear"),
              disabled: !hasText,
              onClick: () => commitValue(""),
            },
          ]
        : [
            {
              type: "item",
              id: "c-cut",
              label: t("common.cut"),
              disabled: !hasSelection,
              onClick: () => {
                const start = ta.selectionStart ?? 0;
                const end = ta.selectionEnd ?? 0;
                const chunk = value.slice(start, end);
                void writeClipboard(chunk).then((ok) => {
                  if (!ok) return;
                  commitValue(value.slice(0, start) + value.slice(end), start);
                });
              },
            },
            {
              type: "item",
              id: "c-copy",
              label: t("common.copy"),
              disabled: !hasSelection,
              onClick: () => {
                void writeClipboard(selected);
              },
            },
            {
              type: "item",
              id: "c-paste",
              label: t("common.paste"),
              onClick: () => {
                const start = ta.selectionStart ?? 0;
                const end = ta.selectionEnd ?? 0;
                void readClipboard().then((text) => {
                  if (!text) return;
                  commitValue(value.slice(0, start) + text + value.slice(end), start + text.length);
                });
              },
            },
            { type: "separator", id: "c-sep" },
            {
              type: "item",
              id: "c-select-all",
              label: t("common.selectAll"),
              disabled: !hasText,
              onClick: () => {
                ta.focus();
                ta.setSelectionRange(0, value.length);
              },
            },
            {
              type: "item",
              id: "c-clear",
              label: t("common.clear"),
              disabled: !hasText,
              onClick: () => commitValue(""),
            },
          ];

      const nextMenu: ContextMenuState = {
        x: e.clientX,
        // Anchor to the top edge of the field so the menu opens fully above it.
        y: isWeb ? taRect.top - 4 : e.clientY,
        items,
        preferUp: isWeb,
      };
      if (isWeb) {
        void concealBrowserViewForMenu().finally(() => setCtxMenu(nextMenu));
      } else {
        setCtxMenu(nextMenu);
      }
    };

    return (
      <div className={`chat-composer-input-shell${variant === "web" ? " chat-composer-input-shell--web" : ""}`}>
        <textarea
          ref={taRef}
          className={`chat-input${variant === "web" ? " chat-input--web" : ""}${className ? ` ${className}` : ""}`}
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onContextMenu={openComposerMenu}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          spellCheck
          aria-label={ariaLabel}
        />
        <ContextMenu
          menu={ctxMenu}
          onClose={closeComposerMenu}
          className={
            variant === "web" ? "claw-context-menu--composer-web" : undefined
          }
        />      </div>
    );
  }
);
