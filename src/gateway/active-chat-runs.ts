type ActiveChatRun = {
  controller: AbortController;
  token: symbol;
};

const activeRuns = new Map<string, ActiveChatRun>();

/**
 * Ceiling on simultaneously running orchestrations. Each running chat burns
 * model tokens and holds an SSE connection; unbounded parallelism turns a
 * reachable port into a money/DoS faucet. Newest-per-session still wins
 * (see below), and sessions beyond this limit get a 429.
 */
export const MAX_CONCURRENT_CHAT_RUNS = 8;

export function beginActiveChatRun(sessionId: string): {
  controller: AbortController;
  finish: () => void;
} | null {
  // Same-session rerun supersedes the older one and does not add load.
  activeRuns.get(sessionId)?.controller.abort("Superseded by a newer chat request");

  if (!activeRuns.has(sessionId) && activeRuns.size >= MAX_CONCURRENT_CHAT_RUNS) {
    return null;
  }

  const controller = new AbortController();
  const token = Symbol(sessionId);
  activeRuns.set(sessionId, { controller, token });

  return {
    controller,
    finish: () => {
      if (activeRuns.get(sessionId)?.token === token) {
        activeRuns.delete(sessionId);
      }
    },
  };
}

export function abortActiveChatRun(sessionId: string, reason = "Chat cancelled"): boolean {
  const active = activeRuns.get(sessionId);
  if (!active) return false;
  active.controller.abort(reason);
  return true;
}

export function hasActiveChatRun(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}
