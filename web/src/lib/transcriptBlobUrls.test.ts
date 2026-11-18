import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  releaseChatTranscriptBlobPreviewUrls,
  releaseTranscriptBlobPreviewUrls,
  trackTranscriptBlobPreviewUrl,
} from "./transcriptBlobUrls";

const revoked: string[] = [];

beforeEach(() => {
  revoked.length = 0;
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    value: {
      revokeObjectURL: (url: string) => revoked.push(url),
    },
  });
});

describe("transcriptBlobUrls", () => {
  it("releases only registered blob transcript previews", () => {
    trackTranscriptBlobPreviewUrl("chat-a", "blob:first");
    trackTranscriptBlobPreviewUrl("chat-a", "https://server/image.png");

    releaseTranscriptBlobPreviewUrls("chat-a", [
      "blob:first",
      "blob:untracked",
      "https://server/image.png",
    ]);

    assert.deepEqual(revoked, ["blob:first"]);
  });

  it("releases a tracked URL idempotently", () => {
    trackTranscriptBlobPreviewUrl("chat-a", "blob:first");
    trackTranscriptBlobPreviewUrl("chat-a", "blob:first");

    releaseTranscriptBlobPreviewUrls("chat-a", ["blob:first", "blob:first"]);
    releaseTranscriptBlobPreviewUrls("chat-a", ["blob:first"]);

    assert.deepEqual(revoked, ["blob:first"]);
  });

  it("releases only previews owned by the deleted chat", () => {
    trackTranscriptBlobPreviewUrl("chat-a", "blob:first");
    trackTranscriptBlobPreviewUrl("chat-b", "blob:second");

    releaseChatTranscriptBlobPreviewUrls("chat-a");
    releaseChatTranscriptBlobPreviewUrls("chat-a");
    assert.deepEqual(revoked, ["blob:first"]);

    releaseChatTranscriptBlobPreviewUrls("chat-b");
    assert.deepEqual(revoked, ["blob:first", "blob:second"]);
  });
});
