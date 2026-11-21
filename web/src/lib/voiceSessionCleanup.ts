// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

type ClosableAudioContext = Pick<AudioContext, "state" | "close">;
type StoppableRecorder = Pick<MediaRecorder, "state" | "stop" | "ondataavailable">;
type StoppableMediaStream = Pick<MediaStream, "getTracks">;

export interface VoiceSessionResources {
  ttsRequest?: AbortController | null;
  audioContext?: ClosableAudioContext | null;
  recorder?: StoppableRecorder | null;
  stream?: StoppableMediaStream | null;
}

/** Release native voice resources without touching the chat's HTTP stream. */
export function cleanupVoiceSessionResources(resources: VoiceSessionResources): void {
  resources.ttsRequest?.abort();

  const audioContext = resources.audioContext;
  if (audioContext && audioContext.state !== "closed") {
    try {
      void audioContext.close().catch(() => undefined);
    } catch {
      // The context may already be closing.
    }
  }

  const recorder = resources.recorder;
  if (recorder) {
    recorder.ondataavailable = null;
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The recorder may become inactive between the state check and stop().
      }
    }
  }

  resources.stream?.getTracks().forEach((track) => track.stop());
}
