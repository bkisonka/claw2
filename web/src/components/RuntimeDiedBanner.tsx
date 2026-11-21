// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { RuntimeDiedInfo } from "../desktop";
import { isSingleUserClient } from "../lib/singleUser";
import { IconClose } from "./icons";

export function RuntimeDiedBanner() {
  const t = useT();
  const [info, setInfo] = useState<RuntimeDiedInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSingleUserClient() || !window.claw2Desktop?.onRuntimeDied) return;
    const offDied = window.claw2Desktop.onRuntimeDied((payload) => {
      setInfo(payload);
      setError(null);
    });
    const offReady = window.claw2Desktop.onRuntimeReady?.(() => {
      setInfo(null);
      setRestarting(false);
      setError(null);
    });
    return () => {
      offDied();
      offReady?.();
    };
  }, []);

  if (!info) return null;

  const detail =
    info.code != null
      ? t("runtimeDied.code", { code: String(info.code) })
      : info.signal
        ? t("runtimeDied.signal", { signal: info.signal })
        : "";

  return (
    <div className="runtime-died-banner" role="alert">
      <div className="runtime-died-banner__text">
        <strong>{t("runtimeDied.title")}</strong>
        <span>{t("runtimeDied.body")}</span>
        {detail ? <span className="runtime-died-banner__meta">{detail}</span> : null}
        {info.runtimeLog ? (
          <code className="runtime-died-banner__log" title={info.runtimeLog}>
            {info.runtimeLog}
          </code>
        ) : null}
        {error ? <span className="runtime-died-banner__err">{error}</span> : null}
      </div>
      <div className="runtime-died-banner__actions">
        {info.runtimeLog && window.claw2Desktop?.openPath ? (
          <button
            type="button"
            className="runtime-died-banner__btn"
            onClick={() => void window.claw2Desktop?.openPath?.(info.runtimeLog!)}
          >
            {t("runtimeDied.openLog")}
          </button>
        ) : null}
        <button
          type="button"
          className="runtime-died-banner__btn runtime-died-banner__btn--primary"
          disabled={restarting || !window.claw2Desktop?.restartRuntime}
          onClick={() => {
            if (!window.claw2Desktop?.restartRuntime) return;
            setRestarting(true);
            setError(null);
            void window.claw2Desktop.restartRuntime().then((res) => {
              if (!res.ok) {
                setRestarting(false);
                setError(res.error || t("runtimeDied.restartFailed"));
                return;
              }
              // ready event clears banner; fallback clear after reload
              setTimeout(() => {
                setInfo(null);
                setRestarting(false);
              }, 2500);
            });
          }}
        >
          {restarting ? t("runtimeDied.restarting") : t("runtimeDied.restart")}
        </button>
        <button
          type="button"
          className="runtime-died-banner__btn"
          onClick={() => setInfo(null)}
          aria-label={t("common.close")}
        >
          <IconClose size={14} />
        </button>
      </div>
    </div>
  );
}
