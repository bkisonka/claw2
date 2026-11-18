import { describe, expect, it } from "vitest";
import { sttEndpoint, parseSttResponse } from "./voice";

describe("sttEndpoint", () => {
  it("appends /audio/transcriptions to a standard base URL", () => {
    expect(sttEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(sttEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("uses a full transcription path as-is", () => {
    expect(sttEndpoint("https://x.ru/v1/audio/transcriptions")).toBe("https://x.ru/v1/audio/transcriptions");
  });

  it("keeps legacy local /stt endpoints working", () => {
    expect(sttEndpoint("http://192.168.1.5:9000/stt")).toBe("http://192.168.1.5:9000/stt");
  });
});

describe("parseSttResponse", () => {
  it("reads OpenAI JSON text", () => {
    expect(parseSttResponse(JSON.stringify({ text: "Привет  " }), 200)).toEqual({ text: "Привет" });
  });

  it("surfaces OpenAI error objects", () => {
    const res = parseSttResponse(JSON.stringify({ error: { message: "bad model" } }), 400);
    expect(res.error).toBe("bad model");
  });

  it("falls back to HTTP code without an error body", () => {
    expect(parseSttResponse("", 502).error).toBe("HTTP 502");
  });

  it("treats plain-text 200 bodies as the transcription", () => {
    expect(parseSttResponse("просто текст", 200)).toEqual({ text: "просто текст" });
  });
});
