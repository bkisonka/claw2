type ActiveChatRun = {
  controller: AbortController;
  token: symbol;
};

const activeRuns = new Map<string, ActiveChatRun>();

export function beginActiveChatRun(sessionId: string): {
  controller: AbortController;
  finish: () => void;
} {
  activeRuns.get(sessionId)?.controller.abort("Superseded by a newer chat request");

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
