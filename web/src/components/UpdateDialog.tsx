// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useCallback, useEffect, useRef, useState } from "react";
import { checkUpdate, fetchUpdateStatus, requestUpdate, type UpdateCheck, type UpdateStatus } from "../api/update";
import { useT } from "../i18n";

type Phase = "idle" | "running" | "restarting" | "done" | "failed";

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [manualCopied, setManualCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const [c, s] = await Promise.all([checkUpdate(), fetchUpdateStatus()]);
    if (!mountedRef.current) return;
    setCheck(c);
    setStatus(s);
    if (s?.progress?.error) setPhase("failed");
    else if (s?.progress?.done) setPhase("done");
    return { c, s };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    timerRef.current = timer;
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const start = async () => {
    setPhase("running");
    const ok = await requestUpdate();
    if (!ok && mountedRef.current) setPhase("failed");
  };

  const available = !!check?.available;
  const auto = !!status?.autoUpdate;
  const progress = status?.progress ?? null;
  const percent =
    phase === "done" ? 100 :
    phase === "restarting" ? Math.max(70, progress?.percent ?? 70) :
    progress && !progress.done ? progress.percent :
    phase === "running" ? (progress?.percent ?? 5) : 0;
  // While the gateway restarts (compose recreates it) polls fail — that IS the
  // restart phase of the update, not an error.
  const inFlight = phase === "running" || phase === "restarting";
  const gatewayDown = status === null && inFlight;
  const shownPhase: Phase = gatewayDown ? "restarting" : phase;

  const stepKey = `update.step.${progress?.step ?? "idle"}` as Parameters<typeof t>[0];
  const stepText =
    shownPhase === "restarting" ? t("update.phaseRestarting") :
    progress?.message ? progress.message :
    progress ? (t(stepKey) || progress.step) : "";

  const manualCommand = "cd claw2 && git pull && docker compose up -d --build && docker image prune -f";

  return (
    <div className="update-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("update.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t("update.title")}</h2>
        <button type="button" className="update-dialog-close" onClick={onClose} aria-label={t("common.close")}>
          ×
        </button>

        <p className="update-dialog-versions">
          {t("update.currentVersion")}: <strong>{check?.current ?? "…"}</strong>
          {check?.latest ? (
            <>
              {" · "}
              {t("update.latestVersion")}: <strong>{check.latest}</strong>
            </>
          ) : null}
        </p>

        {!check && <p className="update-dialog-hint">{t("update.checking")}</p>}
        {check?.checksDisabled && <p className="update-dialog-hint">{t("update.checksDisabled")}</p>}
        {check?.error && !check.latest && <p className="update-dialog-hint">{t("update.checkFailed")}</p>}
        {check && !available && !check.checksDisabled && !check.error && (
          <p className="update-dialog-hint">{t("update.upToDate")}</p>
        )}
        {check?.releaseUrl && available && (
          <a href={check.releaseUrl} target="_blank" rel="noopener noreferrer" className="update-dialog-link">
            {t("update.releaseNotes")}
          </a>
        )}

        {available && (phase === "idle" || phase === "done" || phase === "failed") && auto && (
          <div className="update-dialog-actions">
            <button type="button" className="update-dialog-primary" onClick={() => void start()}>
              {t("update.start")}
            </button>
          </div>
        )}
        {available && phase === "idle" && !auto && (
          <div className="update-dialog-manual">
            <p className="update-dialog-hint">{t("update.manualHint")}</p>
            <div className="update-dialog-command">
              <code>{manualCommand}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(manualCommand).then(() => setManualCopied(true));
                }}
              >
                {manualCopied ? t("update.copied") : t("update.copy")}
              </button>
            </div>
            <p className="update-dialog-hint">{t("update.manualWatchHint")}</p>
          </div>
        )}

        {(phase === "running" || phase === "restarting" || phase === "done") && (
          <div className="update-dialog-progress" aria-live="polite">
            <div className="update-dialog-progressbar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${percent}%` }} />
            </div>
            <p className="update-dialog-step">
              {shownPhase === "done" ? t("update.phaseDone") : `${percent}% — ${stepText}`}
            </p>
          </div>
        )}
        {phase === "failed" && (
          <p className="update-dialog-error" role="alert">
            {t("update.failed")}
          </p>
        )}
        {shownPhase === "restarting" && (
          <p className="update-dialog-hint">{t("update.restartingHint")}</p>
        )}
      </div>
    </div>
  );
}
