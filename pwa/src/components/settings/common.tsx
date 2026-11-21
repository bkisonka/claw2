// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import type { ReactNode } from "react";

export function SettingsFold({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="settings-fold" open={defaultOpen || undefined}>
      <summary className="settings-fold-summary">
        <span className="settings-fold-summary-label">{title}</span>
      </summary>
      <div className="settings-fold-body">{children}</div>
    </details>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
      />
      {hint ? <span className="settings-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`settings-toggle${disabled ? " settings-toggle--disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint ? <span className="settings-toggle-hint">{hint}</span> : null}
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  min,
  max,
}: {
  label: string;
  value: unknown;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  hint?: string;
  min?: number;
  max?: number;
}) {
  return (
    <Field
      label={label}
      value={value != null ? String(value) : ""}
      onChange={(raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          onChange(undefined);
          return;
        }
        if (!/^\d+$/.test(trimmed)) return;
        let n = Number(trimmed);
        if (!Number.isFinite(n)) return;
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        onChange(n);
      }}
      placeholder={placeholder}
      hint={hint}
    />
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <select value={options.some((o) => o.value === value) ? value : ""} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="settings-field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <textarea className="settings-textarea" value={value} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="settings-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="settings-hint">{children}</p>;
}

export function BtnRow({ children }: { children: ReactNode }) {
  return <div className="settings-btn-row">{children}</div>;
}

export function ActionBtn({
  children,
  onClick,
  disabled,
  danger,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
}) {
  const cls = danger
    ? "settings-btn settings-btn--danger"
    : primary
      ? "settings-btn settings-btn--primary"
      : "settings-btn";
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
