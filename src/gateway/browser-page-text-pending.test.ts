import { describe, expect, it } from "vitest";
import { AbortError } from "../core/abort.js";
import {
  resolveBrowserPageText,
  waitForBrowserPageText,
} from "./browser-page-text-pending.js";

describe("browser page text pending waits", () => {
  it("rejects and removes the pending wait when aborted", async () => {
    const controller = new AbortController();
    const wait = waitForBrowserPageText("abort-wait", 10_000, controller.signal);

    controller.abort();

    await expect(wait).rejects.toBeInstanceOf(AbortError);
    expect(resolveBrowserPageText("abort-wait", { text: "late" })).toBe(false);
  });
});
