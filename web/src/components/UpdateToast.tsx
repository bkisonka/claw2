// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";
import { checkUpdate, type UpdateCheck } from "../api/update";
import { useT } from "../i18n";

const DISMISS_KEY = "claw2_update_dismissed";

/** Periodic new-version check → toast. One toast per released version. */
export function UpdateToast({ onOpenDialog }: { onOpenDialog: () => void }) {
  const t = useT();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let alive = true;
    const dismissed = () => window.localStorage.getItem(DISMISS_KEY);
    const run = async () => {
      const c = await checkUpdate();
      if (!alive) return;
      setCheck(c);
      setHidden(!c?.available || dismissed() === c.latest);
    };
    void run();
    const timer = window.setInterval(() => void run(), 6 * 60 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (hidden || !check?.latest) return null;
  return (
    <div className="update-toast" role="status">
      <span>{t("update.toastAvailable", { version: check.latest })}</span>
      <div className="update-toast-actions">
        <button
          type="button"
          onClick={() => {
            onOpenDialog();
            setHidden(true);
          }}
        >
          {t("update.toastAction")}
        </button>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY, check.latest ?? "");
            setHidden(true);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
