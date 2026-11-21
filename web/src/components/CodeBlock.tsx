// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  text: "text",
  txt: "text",
  plain: "text",
};

export function normalizeLang(lang: string | undefined | null): string {
  const raw = (lang ?? "").trim().toLowerCase();
  if (!raw) return "text";
  return LANG_ALIASES[raw] ?? raw;
}

/** Heuristic: looks like source code (for composer and user messages). */
export function looksLikeCode(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^```/m.test(t)) return true;
  const lines = t.split("\n");
  if (lines.length < 2) return false;
  const codeLine =
    /[{};]|=>|^\s*(function|const|let|var|import|export|class|def|async|await|return|if|for|while)\b|#include|<\/?[a-zA-Z]|^\s*[\w.-]+\s*[:=]/;
  const hits = lines.filter((l) => codeLine.test(l)).length;
  return hits >= Math.min(3, Math.max(2, Math.ceil(lines.length * 0.35)));
}

export function guessCodeLanguage(text: string): string {
  const fence = text.match(/^```([\w+-]+)/m);
  if (fence?.[1]) return normalizeLang(fence[1]);
  if (/\b(import|export)\s+.+from\s+['"]|:\s*[A-Z]\w*|interface\s+\w+|type\s+\w+\s*=/.test(text)) {
    return "typescript";
  }
  if (/\b(def|elif|None|True|False)\b|^\s*import\s+\w+/m.test(text)) return "python";
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) return "html";
  if (/^\s*\$|^\s*#!/.test(text) || /\b(npm|curl|ssh)\b/.test(text)) return "bash";
  if (/[{};]|=>|\bfunction\b|\bconst\b/.test(text)) return "javascript";
  return "text";
}

type CodeBlockProps = {
  code: string;
  language?: string;
  className?: string;
  /** Compact mode for the composer overlay (no rounded "card"). */
  flat?: boolean;
};

export function CodeBlock({ code, language, className, flat }: CodeBlockProps) {
  const lang = normalizeLang(language);
  const value = code.replace(/\n$/, "");
  return (
    <div className={`chat-code-block${flat ? " chat-code-block--flat" : ""}${className ? ` ${className}` : ""}`}>
      {!flat && lang !== "text" ? <div className="chat-code-lang">{lang}</div> : null}
      <SyntaxHighlighter
        language={lang === "text" ? "text" : lang}
        style={oneDark}
        showLineNumbers
        wrapLongLines={false}
        customStyle={{
          margin: 0,
          padding: flat ? "0" : "0.75rem 0.85rem",
          background: flat ? "transparent" : "var(--bg-input, #1e1e22)",
          fontSize: "0.85rem",
          lineHeight: "1.45",
          borderRadius: flat ? 0 : "8px",
        }}
        lineNumberStyle={{
          minWidth: "2.25em",
          paddingRight: "0.75em",
          color: "var(--text-muted, #6b7280)",
          userSelect: "none",
        }}
        codeTagProps={{
          style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          },
        }}
      >
        {value || " "}
      </SyntaxHighlighter>
    </div>
  );
}
