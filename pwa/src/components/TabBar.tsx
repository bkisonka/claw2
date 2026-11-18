import type { ReactNode } from "react";
import { IconChats, IconSettings } from "./icons";

export type PwaView = "chats" | "chat" | "images" | "documents" | "settings";

export interface TabBarProps {
  view: PwaView;
  onNavigate: (view: PwaView) => void;
}

/** Root tabs only — like Telegram (conversation hides the bar). */
export function TabBar({ view, onNavigate }: TabBarProps) {
  const tabs: { id: PwaView; label: string; icon: ReactNode }[] = [
    { id: "chats", label: "Чаты", icon: <IconChats size={24} /> },
    { id: "settings", label: "Настройки", icon: <IconSettings size={24} /> },
  ];

  const active = view === "settings" ? "settings" : "chats";

  return (
    <nav className="tab-bar" aria-label="Навигация">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={active === tab.id ? "tab-bar-item active" : "tab-bar-item"}
          onClick={() => onNavigate(tab.id)}
          aria-current={active === tab.id ? "page" : undefined}
        >
          <span className="tab-bar-icon">{tab.icon}</span>
          <span className="tab-bar-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
