import { describe, expect, it } from "vitest";
import { parseDataUrlToBase64, storedFileIdFromUrl } from "./files";

describe("parseDataUrlToBase64", () => {
  it("splits a base64 data URL into mime and payload", () => {
    expect(parseDataUrlToBase64("data:image/png;base64,AAAA")).toEqual({
      mimeType: "image/png",
      base64: "AAAA",
    });
  });

  it("defaults the mime when omitted", () => {
    expect(parseDataUrlToBase64("data:;base64,QQ==")).toEqual({
      mimeType: "application/octet-stream",
      base64: "QQ==",
    });
  });

  it("strips whitespace from the payload", () => {
    expect(parseDataUrlToBase64("data:text/plain;base64,QQ==\n")?.base64).toBe("QQ==");
  });

  it("rejects non-base64 and malformed payloads", () => {
    // Inline (url-encoded) payloads are left alone by callers, not guessed.
    expect(parseDataUrlToBase64("data:text/plain,hello")).toBeNull();
    expect(parseDataUrlToBase64("data:image/png;base64,")).toBeNull();
    expect(parseDataUrlToBase64("not a data url")).toBeNull();
    expect(parseDataUrlToBase64("")).toBeNull();
  });
});

describe("storedFileIdFromUrl", () => {
  it.each(["/files/raw/file_abc123", "/files/file_abc123", "file_abc123"])("extracts id from %s", (url) => {
    expect(storedFileIdFromUrl(url)).toBe("file_abc123");
  });

  it("drops the query string", () => {
    expect(storedFileIdFromUrl("/files/raw/file_abc?download=1")).toBe("file_abc");
  });

  it.each(["/files/raw/notanid", "local:chat:0:name", "https://example.com/x", ""])("returns null for %s", (url) => {
    expect(storedFileIdFromUrl(url)).toBeNull();
  });
});
