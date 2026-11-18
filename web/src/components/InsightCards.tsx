import type { InsightOfferApi } from "../api/chat";
import { useI18n, useT } from "../i18n";

function formatInsightDate(ts: number, locale: string): string {
  try {
    return new Date(ts).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function relativeAge(ts: number, locale: string): string {
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  const days = Math.floor(sec / 86400);
  if (locale === "ru") {
    if (days <= 1) return "вчера";
    if (days < 7) return `${days} дн. назад`;
    return formatInsightDate(ts, locale);
  }
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return formatInsightDate(ts, locale);
}

export function InsightOfferCard(props: {
  offer: InsightOfferApi;
  busy?: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onOpenPast: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const unresolved = props.offer.reasonCode === "unresolved_thread";
  const dateLabel = unresolved
    ? relativeAge(props.offer.pastChatUpdatedAt, locale)
    : formatInsightDate(props.offer.pastChatUpdatedAt, locale);
  const askText = unresolved
    ? t("insights.offerUnresolved", { title: props.offer.pastChatTitle, date: dateLabel })
    : t("insights.offerSemantic", { title: props.offer.pastChatTitle, date: dateLabel });

  return (
    <div className="insight-offer" role="status">
      <p className="insight-offer-text">{askText}</p>
      <div className="insight-offer-actions">
        <button
          type="button"
          className="insight-offer-btn insight-offer-btn--primary"
          disabled={props.busy}
          onClick={props.onAccept}
        >
          {unresolved ? t("insights.return") : t("insights.show")}
        </button>
        <button type="button" className="insight-offer-btn" disabled={props.busy} onClick={props.onDismiss}>
          {unresolved ? t("insights.notNow") : t("insights.hide")}
        </button>
        {unresolved ? (
          <button type="button" className="insight-offer-btn" disabled={props.busy} onClick={props.onOpenPast}>
            {t("insights.openChat")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function InsightCard(props: {
  offer: InsightOfferApi;
  text: string;
  onOpenPast: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className="insight-card" role="status">
      <p className="insight-card-text">{props.text}</p>
      <div className="insight-offer-actions">
        <button type="button" className="insight-offer-btn insight-offer-btn--primary" onClick={props.onOpenPast}>
          {t("insights.openChat")}
        </button>
        <button type="button" className="insight-offer-btn" onClick={props.onDismiss}>
          {t("insights.hide")}
        </button>
      </div>
    </div>
  );
}
