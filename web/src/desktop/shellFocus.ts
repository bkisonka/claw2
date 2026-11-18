/** Reclaim keyboard focus from Electron BrowserView (Windows often keeps keys on a detached view). */
export async function restoreShellFocus(): Promise<void> {
  const browser = window.claw2Desktop?.browser;
  if (!browser?.restoreShellFocus) return;
  try {
    await browser.restoreShellFocus();
  } catch {
    /* ignore */
  }
}
