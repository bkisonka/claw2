// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useState } from "react";
import {
  listAgents,
  setAgentEnabled,
  deleteAgent,
  createAgent,
  putSkillsAllowlist,
  type AgentItem,
} from "../api/agents";
import { useT } from "../i18n";
import { isSingleUserClient } from "../lib/singleUser";

export function SkillsTab() {
  const t = useT();
  const isDesktop = isSingleUserClient();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentDesc, setNewAgentDesc] = useState("");
  const [newSkillId, setNewSkillId] = useState("");
  const [configOpen, setConfigOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listAgents();
      setAgents(Array.isArray(data.agents) ? data.agents : []);
      setSkills(Array.isArray(data.skillsAllowlist) ? data.skillsAllowlist : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleToggleAgent = (agent: AgentItem) =>
    withBusy(`agent:${agent.name}`, async () => {
      await setAgentEnabled(agent.name, !agent.enabled);
      setAgents((prev) =>
        prev.map((a) => (a.name === agent.name ? { ...a, enabled: !agent.enabled } : a))
      );
    });

  const handleDeleteAgent = (agent: AgentItem) => {
    if (!window.confirm(t("skills.deleteAgentConfirm", { name: agent.name }))) return;
    void withBusy(`del:${agent.name}`, async () => {
      await deleteAgent(agent.name);
      setAgents((prev) => prev.filter((a) => a.name !== agent.name));
      if (configOpen === agent.name) setConfigOpen(null);
    });
  };

  const handleCreateAgent = () => {
    const name = newAgentName.trim();
    if (!name) return;
    void withBusy("create-agent", async () => {
      const created = await createAgent({
        name,
        description: newAgentDesc.trim() || undefined,
      });
      setNewAgentName("");
      setNewAgentDesc("");
      await load();
      setConfigOpen(created.name.endsWith(".js") ? created.name : `${created.name}.js`);
    });
  };

  const handleAddSkill = () => {
    const id = newSkillId.trim();
    if (!id) return;
    if (skills.includes(id)) {
      setNewSkillId("");
      return;
    }
    const next = [...skills, id];
    void withBusy("add-skill", async () => {
      const saved = await putSkillsAllowlist(next);
      setSkills(saved);
      setNewSkillId("");
    });
  };

  const handleToggleSkill = (id: string, active: boolean) => {
    const next = active ? [...skills, id] : skills.filter((s) => s !== id);
    void withBusy(`skill:${id}`, async () => {
      const saved = await putSkillsAllowlist(next);
      setSkills(saved);
    });
  };

  const handleRemoveSkill = (id: string) => {
    if (!window.confirm(t("skills.removeSkillConfirm", { id }))) return;
    void withBusy(`rm-skill:${id}`, async () => {
      const saved = await putSkillsAllowlist(skills.filter((s) => s !== id));
      setSkills(saved);
    });
  };

  if (loading) {
    return <div className="cabinet-section">{t("skills.loading")}</div>;
  }

  return (
    <div className="skills-panel">
      {error && <p className="cabinet-error">{error}</p>}
      <p className="cabinet-section-desc skills-intro">{t("skills.intro")}</p>

      <section className="cabinet-section skills-section">
        <h3 className="cabinet-section-title">{t("skills.agentsTitle")}</h3>
        <p className="cabinet-section-desc">
          {t("skills.agentsDescBefore")} <code>agents/</code>{t("skills.agentsDescAfter")}
        </p>

        <div className="skills-add-row">
          <input
            type="text"
            placeholder={t("skills.agentNamePlaceholder")}
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            aria-label={t("skills.agentNameAria")}
          />
          <input
            type="text"
            placeholder={t("skills.agentDescPlaceholder")}
            value={newAgentDesc}
            onChange={(e) => setNewAgentDesc(e.target.value)}
            aria-label={t("skills.agentDescAria")}
          />
          <button
            type="button"
            onClick={handleCreateAgent}
            disabled={!!busy || !newAgentName.trim()}
          >
            {t("common.add")}
          </button>
        </div>

        <ul className="skills-list" aria-label={t("skills.agentsListAria")}>
          {agents.length === 0 ? (
            <li className="skills-empty">{t("skills.noAgents")}</li>
          ) : (
            agents.map((agent) => (
              <li
                key={agent.name}
                className={`skills-item${agent.enabled ? "" : " skills-item-off"}`}
              >
                <div className="skills-item-main">
                  <label className="skills-toggle chat-voice-toggle">
                    <input
                      type="checkbox"
                      checked={agent.enabled}
                      disabled={!!busy}
                      onChange={() => void handleToggleAgent(agent)}
                    />
                    <span className="chat-voice-toggle-track" aria-hidden />
                    <span className="skills-item-name">{agent.name}</span>
                  </label>
                  <span className="skills-item-status">
                    {agent.enabled ? t("skills.active") : t("skills.off")}
                  </span>
                  <div className="skills-item-actions">
                    <button
                      type="button"
                      className="skills-btn"
                      onClick={() =>
                        setConfigOpen((v) => (v === agent.name ? null : agent.name))
                      }
                    >
                      {t("skills.configure")}
                    </button>
                    <button
                      type="button"
                      className="skills-btn skills-btn-danger"
                      disabled={!!busy}
                      onClick={() => handleDeleteAgent(agent)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </div>
                {configOpen === agent.name && (
                  <div className="skills-item-config">
                    <div className="skills-item-desc">{agent.description}</div>
                    {agent.help ? (
                      <pre className="skills-item-help">{agent.help}</pre>
                    ) : null}
                    {!agent.usageComplete ? (
                      <p className="skills-hint skills-hint-warn">
                        {t("skills.usageIncomplete")}
                      </p>
                    ) : null}
                    <p className="skills-hint">
                      {t("skills.editHintBefore")} <code>agents/{agent.name}</code>{t("skills.editHintAfter")}
                    </p>
                    <button
                      type="button"
                      className="skills-btn"
                      disabled={!!busy}
                      onClick={() => void handleToggleAgent(agent)}
                    >
                      {agent.enabled ? t("skills.deactivate") : t("skills.activate")}
                    </button>
                  </div>
                )}
              </li>
            ))
          )}
        </ul>
      </section>

      {!isDesktop && (
      <section className="cabinet-section skills-section">
        <h3 className="cabinet-section-title">{t("skills.skillsTitle")}</h3>
        <p className="cabinet-section-desc">
          {t("skills.skillsDesc")}
        </p>

        <div className="skills-add-row">
          <input
            type="text"
            placeholder="skill-id"
            value={newSkillId}
            onChange={(e) => setNewSkillId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddSkill();
            }}
            aria-label={t("skills.skillIdAria")}
          />
          <button type="button" onClick={handleAddSkill} disabled={!!busy || !newSkillId.trim()}>
            {t("common.add")}
          </button>
        </div>

        <ul className="skills-list" aria-label={t("skills.skillsListAria")}>
          {skills.length === 0 ? (
            <li className="skills-empty">{t("skills.allowlistEmpty")}</li>
          ) : (
            skills.map((id) => (
              <li key={id} className="skills-item">
                <div className="skills-item-main">
                  <label className="skills-toggle chat-voice-toggle">
                    <input
                      type="checkbox"
                      checked
                      disabled={!!busy}
                      onChange={() => void handleToggleSkill(id, false)}
                    />
                    <span className="chat-voice-toggle-track" aria-hidden />
                    <span className="skills-item-name">{id}</span>
                  </label>
                  <span className="skills-item-status">{t("skills.active")}</span>
                  <div className="skills-item-actions">
                    <button
                      type="button"
                      className="skills-btn skills-btn-danger"
                      disabled={!!busy}
                      onClick={() => handleRemoveSkill(id)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      </section>
      )}
    </div>
  );
}
