// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { Link } from "react-router-dom";
import { GalleryTab } from "../components/GalleryTab";
import { useT } from "../i18n";

/** Standalone chat gallery page (not cabinet / settings). */
export function GalleryPage() {
  const t = useT();
  return (
    <div className="gallery-page">
      <header className="gallery-page-header">
        <Link to="/chat" className="gallery-page-back">
          {t("gallery.backToChat")}
        </Link>
        <h2 className="gallery-page-title">{t("gallery.title")}</h2>
      </header>
      <div className="gallery-page-body">
        <GalleryTab />
      </div>
    </div>
  );
}
