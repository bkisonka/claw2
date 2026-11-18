import { useEffect, useMemo, useRef, useState } from "react";

const MAX_RENDERED = 100;

/**
 * Combobox for the model field: one control, manual ids still typeable.
 * Focusing it fetches /models of the configured API (once per mount) and
 * opens a dropdown; typing filters it. No separate "load models" button.
 */
export function ModelPicker({
  value,
  onChange,
  fetchModels,
  label = "Модель",
  placeholder = "gpt-4o-mini",
  variant = "settings",
}: {
  value: string;
  onChange: (model: string) => void;
  fetchModels: () => Promise<string[]>;
  label?: string;
  placeholder?: string;
  variant?: "settings" | "login";
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** null = input mirrors the saved value; string = user is typing a filter. */
  const [query, setQuery] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  const load = async () => {
    if (loading) return;
    setLoading(true);
    setStatus(null);
    try {
      const list = await fetchModels();
      setModels(list);
      setStatus(list.length ? null : "Сервер вернул пустой список моделей");
    } catch (e) {
      setModels([]);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const openDropdown = () => {
    setOpen(true);
    // Refetch after a failed/empty load too — the user may have just fixed
    // the endpoint or the key in the neighboring field.
    if (models === null || status !== null) void load();
  };

  const filtered = useMemo(() => {
    const list = models ?? [];
    const needle = (query ?? "").trim().toLowerCase();
    const hits = needle ? list.filter((m) => m.toLowerCase().includes(needle)) : list;
    return hits.slice(0, MAX_RENDERED);
  }, [models, query]);

  const shown = query ?? value;
  const fieldLabel = <span>{label}</span>;

  return (
    <div className="model-combo" ref={wrapRef}>
      <label className={variant === "login" ? "login-field" : "settings-field"}>
        {fieldLabel}
        <input
          type="text"
          value={shown}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
          }}
          onFocus={openDropdown}
          onClick={openDropdown}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      {open && (
        <div className="model-combo-dropdown" role="listbox" aria-label={`${label}: список сервера`}>
          {loading && <div className="model-picker-empty">Загрузка моделей…</div>}
          {!loading && status && <div className="model-picker-empty">{status}</div>}
          {!loading &&
            !status &&
            filtered.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                className={"model-combo-item" + (m === value ? " model-combo-item--current" : "")}
                onClick={() => {
                  onChange(m);
                  setQuery(null);
                  setOpen(false);
                }}
              >
                {m}
              </button>
            ))}
          {!loading && !status && filtered.length === 0 && (
            <div className="model-picker-empty">Ничего не найдено — оставь как есть или введи id вручную</div>
          )}
          {!loading && !status && !query && models !== null && models.length > MAX_RENDERED && (
            <div className="model-picker-empty">Показаны первые {MAX_RENDERED} — начни вводить запрос</div>
          )}
        </div>
      )}
    </div>
  );
}
