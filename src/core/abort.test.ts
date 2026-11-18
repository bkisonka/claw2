import { describe, expect, it } from "vitest";
import { AbortError, isAbortError, throwIfAborted } from "./abort.js";

describe("abort helpers", () => {
  it("throws the shared AbortError for an aborted signal", () => {
    const controller = new AbortController();
    controller.abort("stopped");

    expect(() => throwIfAborted(controller.signal)).toThrow(AbortError);
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      expect(isAbortError(error)).toBe(true);
      expect((error as Error).message).toBe("stopped");
    }
  });

  it("does nothing for a live or absent signal", () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });
});
