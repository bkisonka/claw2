// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { Link } from "react-router-dom";
import { CallsTab } from "../components/CallsTab";
import { useT } from "../i18n";

/** SIP call log (read-only + export to .md). */
export function CallsPage() {
  const t = useT();
  return (
    <div className="gallery-page calls-page">
      <header className="gallery-page-header">
        <Link to="/chat" className="gallery-page-back">
          {t("calls.backToChat")}
        </Link>
        <h2 className="gallery-page-title">{t("calls.title")}</h2>
      </header>
      <div className="gallery-page-body">
        <CallsTab />
      </div>
    </div>
  );
}
