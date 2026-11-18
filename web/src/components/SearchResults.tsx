import type { ReactNode } from "react";
import type { SearchResultItemApi } from "../api/chat";
import { useT } from "../i18n";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split text into parts and wrap query matches in <mark>. */
function highlightMatches(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = escapeRegex(q);
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="search-results-highlight">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

interface SearchResultsProps {
  query: string;
  results: SearchResultItemApi[];
  loading: boolean;
  error: string | null;
  onOpenChat: (chatId: string) => void;
}

export function SearchResults({ query, results, loading, error, onOpenChat }: SearchResultsProps) {
  const t = useT();
  if (!query.trim()) {
    return (
      <div className="search-results search-results-empty">
        <p className="search-results-hint">{t("search.hint")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="search-results search-results-loading">
        <p>{t("search.searching")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="search-results search-results-error">
        <p>{t("common.error", { error })}</p>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="search-results search-results-empty">
        <p>{t("search.none", { query })}</p>
      </div>
    );
  }

  return (
    <div className="search-results">
      <p className="search-results-heading">{t("search.found", { count: results.length })}</p>
      <div className="search-results-list">
        {results.map((item, i) => (
          <button
            type="button"
            key={`${item.chatId}-${item.messageId}-${i}`}
            className="search-results-item"
            onClick={() => onOpenChat(item.chatId)}
          >
            <span className="search-results-item-chat" title={item.chatTitle}>
              {item.chatTitle || item.chatId}
            </span>
            <span className="search-results-item-role">{item.role === "user" ? t("common.you") : t("common.agent")}</span>
            <div className="search-results-item-content">{highlightMatches(item.content, query)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
