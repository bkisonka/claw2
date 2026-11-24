// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { afterEach, describe, expect, it, vi } from "vitest";
import { attachChatStream, cancelChat, sendMessageStream } from "./chat";

vi.mock("../config", () => ({ apiBase: "", apiKey: undefined }));
vi.mock("../auth/storage", () => ({ getAuthHeaders: () => ({}) }));

const encoder = new TextEncoder();
const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;

function mockStream(chunks: Uint8Array[], keepOpen = false) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!keepOpen) controller.close();
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  })));
  return { cancel, body };
}

afterEach(() => vi.unstubAllGlobals());

describe("sendMessageStream terminal contract", () => {
  it("assembles split events and UTF-8, dispatches controls, and finishes without waiting for EOF", async () => {
    const userCells = [{ type: "image", content: "/files/uploads/example.png" }];
    const terminal = { done: true, sessionId: "s1", content: "Final reply", lastRunId: 42, userCells };
    const wire = ": keepalive\r\n\r\ndata:{\r\ndata: \"content\":\"Привет\"}\r\n\r\n" +
      event({ sidebarUpdated: true, openBrowserUrl: " https://example.test/ " }) +
      event({ readBrowserPage: { requestId: "read" } }) +
      event({ headlessPageText: { requestId: "load", url: "https://example.test/page" } }) +
      event(terminal) + event({ content: "late chunk" }) + event({ done: true, content: "late terminal" });
    // Fragment every byte: this splits UTF-8, data fields, and the CRLF delimiter.
    const { cancel, body } = mockStream(Array.from(encoder.encode(wire), (byte) => Uint8Array.of(byte)), true);
    const onChunk = vi.fn();
    const onSidebar = vi.fn();
    const onOpen = vi.fn();
    const onRead = vi.fn();
    const onHeadless = vi.fn();
    const result = await sendMessageStream("Question", undefined, undefined, onChunk,
      undefined, undefined, undefined, undefined, undefined, onSidebar,
      undefined, onOpen, undefined, undefined, undefined, undefined, onRead, onHeadless);

    expect(onChunk.mock.calls).toEqual([["Привет"]]);
    expect(onSidebar).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("https://example.test/");
    expect(onRead).toHaveBeenCalledWith("read");
    expect(onHeadless).toHaveBeenCalledWith("load", "https://example.test/page");
    expect(result).toMatchObject({ sessionId: "s1", content: "Final reply", lastRunId: 42, userCells });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("surfaces an explicit server error even when it starts before any chunks", async () => {
    mockStream([encoder.encode(event({ done: true, sessionId: "s1", error: "LLM not configured" }))]);
    const onChunk = vi.fn();
    await expect(sendMessageStream("Question", undefined, undefined, onChunk)).resolves.toMatchObject({
      sessionId: "s1", error: "LLM not configured", content: "",
    });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "data: [DONE]\n\n",
    "data: {\"done\":tru\n\n",
    'data: {"done":true}\n',
  ])("rejects EOF after partial text without a complete JSON terminal (%j)", async (trailer) => {
    const { body } = mockStream([encoder.encode(event({ content: "Partial" }) + trailer)]);
    const onChunk = vi.fn();
    await expect(sendMessageStream("Question", undefined, undefined, onChunk)).rejects.toThrow(/interrupted/i);
    expect(onChunk.mock.calls).toEqual([["Partial"]]);
    expect(body.locked).toBe(false);
  });

  it("keeps the abort error and does not rewrite it as an interrupted reply", async () => {
    const error = new DOMException("Aborted", "AbortError");
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(error) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    })));
    await expect(sendMessageStream("Question", undefined, undefined, vi.fn())).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });

  it("keeps the non-streaming JSON fallback and attachment metadata", async () => {
    const reply = { sessionId: "s1", content: "Reply", userCells: [{ type: "image", content: "/files/a.png" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reply)));
    await expect(sendMessageStream("Question", undefined, undefined, vi.fn())).resolves.toMatchObject(reply);
  });
});

describe("live tool steps", () => {
  it("hands tool steps to onToolEvent without treating them as text", async () => {
    const step = { type: "start", seq: 0, iteration: 0, name: "read", args: '{"path":"a.txt"}' };
    const end = { ...step, type: "end", ok: true, durationMs: 4 };
    mockStream([
      encoder.encode(event({ toolEvent: step }) + event({ toolEvent: end }) + event({ done: true, sessionId: "s1", content: "ok", toolLimitReached: true })),
    ]);
    const onChunk = vi.fn();
    const onToolEvent = vi.fn();

    const result = await sendMessageStream(
      "Question", "s1", undefined, onChunk,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, onToolEvent
    );

    expect(onToolEvent.mock.calls).toEqual([[step], [end]]);
    expect(onChunk).not.toHaveBeenCalled();
    expect(result.toolLimitReached).toBe(true);
  });
});

describe("attachChatStream", () => {
  const sse = (wire: string) =>
    new Response(new TextEncoder().encode(wire), { headers: { "Content-Type": "text/event-stream" } });
  const runningStep = { type: "start", seq: 0, iteration: 0, name: "read", args: "{}" };

  it("replays the snapshot, follows the turn and ends with its terminal event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sse(
        ": keepalive\n\n" +
          event({ snapshot: { userMessage: "Q", content: "so far", steps: [runningStep] } }) +
          event({ content: " more" }) +
          event({ toolEvent: { ...runningStep, type: "end", ok: true, durationMs: 3 } }) +
          event({ sidebarUpdated: true }) +
          event({ done: true, sessionId: "s1", content: "so far more" })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSnapshot = vi.fn();
    const onChunk = vi.fn();
    const onToolEvent = vi.fn();
    const onSidebar = vi.fn();

    const result = await attachChatStream("s1", { onSnapshot, onChunk, onToolEvent, onSidebarUpdated: onSidebar });

    expect(fetchMock.mock.calls[0]![0]).toBe("/chat/attach?session_id=s1");
    expect(onSnapshot).toHaveBeenCalledWith({ userMessage: "Q", content: "so far", steps: [runningStep] });
    expect(onChunk.mock.calls).toEqual([[" more"]]);
    expect(onToolEvent).toHaveBeenCalledWith({ ...runningStep, type: "end", ok: true, durationMs: 3 });
    expect(onSidebar).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sessionId: "s1", content: "so far more" });
    expect(result.noRun).toBeUndefined();
  });

  it("answers noRun at once when nothing is running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(event({ done: true, noRun: true, sessionId: "s1" }))));
    const onChunk = vi.fn();
    const result = await attachChatStream("s1", { onChunk, onToolEvent: vi.fn() });
    expect(result.noRun).toBe(true);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("hands the browser requests of the turn to the client that reconnected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse(
          event({ openBrowserUrl: "https://example.test/opened" }) +
            event({ readBrowserPage: { requestId: "read" } }) +
            event({ headlessPageText: { requestId: "load", url: "https://example.test/page" } }) +
            event({ done: true, sessionId: "s1", content: "done" })
        )
      )
    );
    const onOpenBrowserUrl = vi.fn();
    const onReadBrowserPage = vi.fn();
    const onHeadlessPageText = vi.fn();

    await attachChatStream("s1", { onChunk: vi.fn(), onToolEvent: vi.fn(), onOpenBrowserUrl, onReadBrowserPage, onHeadlessPageText });

    expect(onOpenBrowserUrl).toHaveBeenCalledWith("https://example.test/opened");
    expect(onReadBrowserPage).toHaveBeenCalledWith("read");
    expect(onHeadlessPageText).toHaveBeenCalledWith("load", "https://example.test/page");
  });

  it("rejects a stream that ends without a terminal event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(event({ content: "Partial" }))));
    await expect(attachChatStream("s1", { onChunk: vi.fn(), onToolEvent: vi.fn() })).rejects.toThrow(/interrupted/i);
  });
});

describe("cancelChat", () => {
  it("posts the session to /chat/cancel and never throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelChat("s1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/chat/cancel",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ sessionId: "s1" }), keepalive: true })
    );
    // An older gateway without the endpoint, or a dropped network: the caller drops its stream anyway.
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(cancelChat("s1")).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(cancelChat("s1")).resolves.toBeUndefined();
    // Nothing to cancel without a session.
    await cancelChat("");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
