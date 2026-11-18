/**
 * Ratings were a gateway/agent-selection feature; the standalone app has no
 * run registry. Kept as a no-op so the chat UI stays untouched.
 */
export async function rateRun(_runId: number, _rating: 0 | 1): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}
