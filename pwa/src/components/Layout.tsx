import type { ReactNode } from "react";
import { TabBar, type PwaView } from "./TabBar";
import { IconBack, IconFile, IconImage, IconLogout, IconPlus } from "./icons";

interface LayoutProps {
  view: PwaView;
  title: string;
  /** Fold/tablet: chat list lives in a permanent left pane. */
  wide: boolean;
  onNavigate: (view: PwaView) => void;
  onBack?: () => void;
  onNewChat?: () => void;
  onOpenImages?: () => void;
  onOpenDocuments?: () => void;
  showLogout?: boolean;
  onLogout?: () => void;
  /** Left-pane content (chat list). Always mounted — visibility is CSS-only. */
  listPane: ReactNode;
  /** Right-pane content: chat / images / documents / settings / placeholder. */
  children: ReactNode;
}

const STACK_VIEWS = new Set<PwaView>(["chat", "images", "documents"]);

/**
 * Whether the view behaves as a stack page with a back button.
 * In wide mode the list is always visible, so an open chat is no longer a stack page.
 */
export function isStackView(view: PwaView, wide: boolean): boolean {
  if (wide && view === "chat") return false;
  return STACK_VIEWS.has(view);
}

/**
 * ONE tree for both modes — rotation/fold across the wide threshold only flips
 * CSS classes. Two different trees here remounted Chat mid-stream and killed
 * the reply (the "чат останавливается" bug).
 */
export function Layout({
  view,
  title,
  wide,
  onNavigate,
  onBack,
  onNewChat,
  onOpenImages,
  onOpenDocuments,
  showLogout,
  onLogout,
  listPane,
  children,
}: LayoutProps) {
  const inStack = isStackView(view, wide);
  const showTabs = !inStack;
  // Narrow: list pane only for the chats view; settings lives in the detail pane.
  const narrowOnList = !wide && view === "chats";

  const shellCls = [
    "app-shell",
    wide ? "app-shell--wide" : narrowOnList ? "app-shell--narrow-list" : "app-shell--narrow-detail",
  ].join(" ");

  return (
    <div className={shellCls}>
      <aside className="pane pane-list">
        <header className="layout-header">
          <div className="layout-header-left">
            <h1 className="layout-title">Чаты</h1>
          </div>
          <div className="layout-header-right">
            {onNewChat ? (
              <button type="button" className="nav-btn nav-btn-icon" onClick={onNewChat} aria-label="Новый чат">
                <IconPlus size={24} />
              </button>
            ) : null}
            {showLogout && onLogout ? (
              <button type="button" className="nav-btn nav-btn-icon" onClick={onLogout} aria-label="Выйти">
                <IconLogout size={20} />
              </button>
            ) : null}
          </div>
        </header>
        <main className="pane-body">{listPane}</main>
      </aside>
      <section className="pane pane-detail">
        <header className="layout-header">
          <div className="layout-header-left">
            {inStack && onBack ? (
              <button type="button" className="nav-btn nav-btn-icon" onClick={onBack} aria-label="Назад">
                <IconBack size={24} />
              </button>
            ) : null}
            <h1 className="layout-title">{title}</h1>
          </div>
          <div className="layout-header-right">
            {view === "chat" && onOpenImages ? (
              <button type="button" className="nav-btn nav-btn-icon" onClick={onOpenImages} aria-label="Картинки">
                <IconImage size={22} />
              </button>
            ) : null}
            {view === "chat" && onOpenDocuments ? (
              <button type="button" className="nav-btn nav-btn-icon" onClick={onOpenDocuments} aria-label="Документы">
                <IconFile size={22} />
              </button>
            ) : null}
          </div>
        </header>
        <main className="pane-body pane-body--detail">{children}</main>
      </section>
      {showTabs ? <TabBar view={view} onNavigate={onNavigate} /> : null}
    </div>
  );
}
