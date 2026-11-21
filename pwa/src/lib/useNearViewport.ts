// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * True once the element has come near the viewport — and stays true: scrolling
 * away never unloads, so nothing re-loads on scroll-back. Offscreen media cells
 * and charts skip their data loading and mounting entirely until the user
 * actually scrolls to them (the chat log renders all messages at once, so
 * "mounted" otherwise meant "loaded every binary in the chat").
 */
export function useNearViewport<T extends HTMLElement>(rootMargin = "600px"): [RefObject<T>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, rootMargin]);
  return [ref, near];
}
