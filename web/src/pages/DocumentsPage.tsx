import { Link } from "react-router-dom";
import { DocumentsTab } from "../components/DocumentsTab";
import { useT } from "../i18n";

/** Standalone chat documents page. */
export function DocumentsPage() {
  const t = useT();
  return (
    <div className="gallery-page documents-page">
      <header className="gallery-page-header">
        <Link to="/chat" className="gallery-page-back">
          {t("documents.backToChat")}
        </Link>
        <h2 className="gallery-page-title">{t("documents.title")}</h2>
      </header>
      <div className="gallery-page-body">
        <DocumentsTab />
      </div>
    </div>
  );
}
