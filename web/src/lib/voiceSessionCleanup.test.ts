import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanupVoiceSessionResources } from "./voiceSessionCleanup";

describe("cleanupVoiceSessionResources", () => {
  it("aborts TTS and releases audio, recorder, and media tracks", async () => {
    const ttsRequest = new AbortController();
    let audioClosed = 0;
    let recorderStopped = 0;
    let trackStops = 0;
    const recorder = {
      state: "recording",
      ondataavailable: (() => undefined) as MediaRecorder["ondataavailable"],
      stop: () => {
        recorderStopped += 1;
      },
    };

    cleanupVoiceSessionResources({
      ttsRequest,
      audioContext: {
        state: "running",
        close: async () => {
          audioClosed += 1;
        },
      },
      recorder,
      stream: {
        getTracks: () => [{ stop: () => { trackStops += 1; } } as MediaStreamTrack],
      },
    });
    await Promise.resolve();

    assert.equal(ttsRequest.signal.aborted, true);
    assert.equal(audioClosed, 1);
    assert.equal(recorderStopped, 1);
    assert.equal(recorder.ondataavailable, null);
    assert.equal(trackStops, 1);
  });

  it("does not close or stop already inactive resources", async () => {
    let audioClosed = 0;
    let recorderStopped = 0;

    cleanupVoiceSessionResources({
      audioContext: {
        state: "closed",
        close: async () => {
          audioClosed += 1;
        },
      },
      recorder: {
        state: "inactive",
        ondataavailable: null,
        stop: () => {
          recorderStopped += 1;
        },
      },
    });
    await Promise.resolve();

    assert.equal(audioClosed, 0);
    assert.equal(recorderStopped, 0);
  });
});
