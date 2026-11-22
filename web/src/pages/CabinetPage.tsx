// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { Link, NavLink, useLocation, Navigate } from "react-router-dom";
import { Settings } from "../components/Settings";
import { AccountTab } from "../components/AccountTab";
import { ActivationCacheTab } from "../components/ActivationCacheTab";
import { PrivacyTab } from "../components/PrivacyTab";
import { SkillsTab } from "../components/SkillsTab";
import { PersonaTab } from "../components/PersonaTab";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { UpdateDialog } from "../components/UpdateDialog";
import { UpdateToast } from "../components/UpdateToast";
import { isSingleUserClient } from "../lib/singleUser";
import { useT, useI18n } from "../i18n";

export function CabinetPage() {
  const [updateOpen, setUpdateOpen] = useState(false);
  const location = useLocation();
  const pathname = location.pathname;
  const { authMode } = useAuth();
  const t = useT();
  const { locale } = useI18n();
  const showAccount = !isSingleUserClient() && authMode === "auth";

  if (pathname === "/cabinet" || pathname === "/cabinet/") {
    return <Navigate to="/cabinet/settings" replace />;
  }

  if (pathname === "/cabinet/gallery" || pathname.startsWith("/cabinet/gallery/")) {
    return <Navigate to="/gallery" replace />;
  }

  const isAccount = pathname === "/cabinet/account" || pathname.startsWith("/cabinet/account/");
  const isActivationCache =
    pathname === "/cabinet/activation-cache" || pathname.startsWith("/cabinet/activation-cache/");
  const isPrivacy = pathname === "/cabinet/privacy" || pathname.startsWith("/cabinet/privacy/");
  const isSkills = pathname === "/cabinet/skills" || pathname.startsWith("/cabinet/skills/");
  const isPersona = pathname === "/cabinet/persona" || pathname.startsWith("/cabinet/persona/");

  if (isAccount && !showAccount) {
    return <Navigate to="/cabinet/settings" replace />;
  }

  const tabContent = isAccount ? (
    <AccountTab />
  ) : isActivationCache ? (
    <ActivationCacheTab />
  ) : isPrivacy ? (
    <PrivacyTab />
  ) : isSkills ? (
    <SkillsTab />
  ) : isPersona ? (
    <PersonaTab />
  ) : (
    <Settings />
  );

  return (
    <div className="cabinet-wrap">
      <header className="cabinet-header">
        <Link to="/chat" className="cabinet-back">
          {t("cabinet.backToChat")}
        </Link>
        <h2 className="cabinet-title">{t("cabinet.title")}</h2>
        <a
          className="cabinet-wiki-link"
          href={`/wiki/#/${locale}/Home.md`}
          target="_blank"
          rel="noopener noreferrer"
          title={t("cabinet.wikiTitle")}
        >
          {t("cabinet.wiki")}
        </a>
        <button
          type="button"
          className="cabinet-wiki-link cabinet-update-link"
          title={t("update.linkTitle")}
          onClick={() => setUpdateOpen(true)}
        >
          {t("update.link")}
        </button>
      </header>
      <UpdateToast onOpenDialog={() => setUpdateOpen(true)} />
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
      <nav className="cabinet-tabs" aria-label={t("cabinet.tabsAria")}>
        <NavLink
          to="/cabinet/settings"
          className={({ isActive }) => `cabinet-tab ${isActive ? "cabinet-tab-active" : ""}`}
          end
        >
          {t("cabinet.settings")}
        </NavLink>
        <NavLink
          to="/cabinet/persona"
          className={({ isActive }) => `cabinet-tab ${isActive ? "cabinet-tab-active" : ""}`}
        >
          {t("cabinet.persona")}
        </NavLink>
        <NavLink
          to="/cabinet/skills"
          className={({ isActive }) => `cabinet-tab ${isActive ? "cabinet-tab-active" : ""}`}
        >
          {t("cabinet.skills")}
        </NavLink>
        <NavLink
          to="/cabinet/activation-cache"
          className={({ isActive }) => `cabinet-tab ${isActive ? "cabinet-tab-active" : ""}`}
        >
          {t("cabinet.activationCache")}
        </NavLink>
        <NavLink
          to="/cabinet/privacy"
          className={({ isActive }) => `cabinet-tab ${isActive ? "cabinet-tab-active" : ""}`}
        >
          {t("cabinet.privacy")}
        </NavLink>
        {showAccount && (
          <NavLink
            to="/cabinet/account"
            className={({ isActive }) => `cabinet-tab ${isActive ? "cabinet-tab-active" : ""}`}
          >
            {t("cabinet.account")}
          </NavLink>
        )}
      </nav>
      <div className="cabinet-content">{tabContent}</div>
    </div>
  );
}
