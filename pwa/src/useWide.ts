// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useState } from "react";

/**
 * Fold/tablet two-pane threshold in CSS px (≈ dp inside the Android WebView). Unfolded
 * inner screens qualify (Pixel Fold ≈ 671 dp, Pixel 9 Pro Fold ≈ 740 dp, Mate X ≈ 800 dp,
 * tablets 600–900 dp); folded outer covers and phones in portrait do not. Viewport-driven:
 * folding, rotating and freeform window resizes re-evaluate it immediately.
 */
const WIDE_QUERY = "(min-width: 640px)";

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}
