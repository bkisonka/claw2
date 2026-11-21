// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import { effectiveMime, inferMimeFromName, isImageAttachment, isVisionImage } from "./mime";

describe("inferMimeFromName", () => {
  it("maps common extensions", () => {
    expect(inferMimeFromName("фото.JPG")).toBe("image/jpeg");
    expect(inferMimeFromName("doc.pdf")).toBe("application/pdf");
    expect(inferMimeFromName("таб.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(inferMimeFromName("запись.m4a")).toBe("audio/mp4");
    expect(inferMimeFromName("без-расширения")).toBeUndefined();
  });
});

describe("effectiveMime", () => {
  it("trusts a real declared mime", () => {
    expect(effectiveMime({ name: "x.bin", mimeType: "image/webp" })).toBe("image/webp");
  });

  it("falls back to the extension when the platform reports nothing", () => {
    expect(effectiveMime({ name: "IMG_1234.jpg", mimeType: "" })).toBe("image/jpeg");
    expect(effectiveMime({ name: "IMG_1234.jpg" })).toBe("image/jpeg");
  });

  it("recovers from the generic octet-stream", () => {
    expect(effectiveMime({ name: "screenshot.png", mimeType: "application/octet-stream" })).toBe(
      "image/png"
    );
  });

  it("stays octet-stream when nothing matches", () => {
    expect(effectiveMime({ name: "blob" })).toBe("application/octet-stream");
  });
});

describe("isVisionImage / isImageAttachment", () => {
  it("vision set: png/jpeg/webp/gif — even with an empty mime", () => {
    expect(isVisionImage({ name: "p.jpg" })).toBe(true);
    expect(isVisionImage({ name: "p.png", mimeType: "" })).toBe(true);
    expect(isVisionImage({ name: "p", mimeType: "image/webp" })).toBe(true);
  });

  it("image-ish but not vision-readable formats are excluded", () => {
    expect(isVisionImage({ name: "p.heic" })).toBe(false);
    expect(isVisionImage({ name: "p.bmp" })).toBe(false);
    expect(isVisionImage({ name: "p.svg", mimeType: "image/svg+xml" })).toBe(false);
    expect(isImageAttachment({ name: "p.heic" })).toBe(true);
    expect(isImageAttachment({ name: "p.heic", mimeType: "" })).toBe(true);
  });

  it("non-images are not images", () => {
    expect(isImageAttachment({ name: "док.pdf" })).toBe(false);
    expect(isVisionImage({ name: "док.pdf" })).toBe(false);
    expect(isImageAttachment({ name: "заметка.txt" })).toBe(false);
  });
});
