import { describe, expect, it } from "vitest";
import {
  extractDocumentText,
  extractableKind,
  type BinaryAttachment,
} from "./docs-extract";

function att(name: string, bytes: Uint8Array, mime?: string): BinaryAttachment {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { name, contentBase64: btoa(bin), mimeType: mime };
}

describe("extractableKind", () => {
  it("detects by extension first", () => {
    expect(extractableKind("отчёт.PDF")).toBe("pdf");
    expect(extractableKind("таб.xlsx")).toBe("xlsx");
    expect(extractableKind("таб.XLS")).toBe("xlsx");
    expect(extractableKind("таб.ods")).toBe("xlsx");
    expect(extractableKind("док.docx")).toBe("docx");
  });

  it("falls back to mime when the extension is missing", () => {
    expect(extractableKind("file", "application/pdf")).toBe("pdf");
    expect(
      extractableKind("file", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    ).toBe("xlsx");
    expect(
      extractableKind("file", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    ).toBe("docx");
  });

  it("returns null for opaque types", () => {
    expect(extractableKind("photo.jpg", "image/jpeg")).toBeNull();
    expect(extractableKind("заметка.txt", "text/plain")).toBeNull();
    expect(extractableKind("legacy.doc", "application/msword")).toBeNull();
  });
});

describe("extractDocumentText: xlsx", () => {
  it("reads all sheets as labelled CSV", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Товар", "Цена"],
        ["Кофе", 350],
      ]),
      "Счёт"
    );
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const res = await extractDocumentText(att("счёт.xlsx", bytes));
    expect(res).not.toBeNull();
    expect(res!.text).toContain("### Лист: Счёт");
    expect(res!.text).toContain("Товар,Цена");
    expect(res!.text).toContain("Кофе,350");
  });
});

describe("extractDocumentText: docx", () => {
  it("extracts raw text from a generated document", async () => {
    const { Document, Packer, Paragraph, TextRun } = await import("docx");
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun("Claw2 docx тестовый текст")] })] }],
    });
    const buf = await Packer.toBuffer(doc);

    const res = await extractDocumentText(att("документ.docx", new Uint8Array(buf)));
    expect(res).not.toBeNull();
    expect(res!.text).toContain("Claw2 docx тестовый текст");
  });
});

describe("extractDocumentText: pdf", () => {
  it("extracts text from a minimal PDF", async () => {
    const stream = "BT /F1 16 Tf 20 100 Td (Claw2 PDF test) Tj ET";
    const bodies = [
      "<</Type/Catalog/Pages 2 0 R>>",
      "<</Type/Pages/Kids[3 0 R]/Count 1>>",
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
      "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ];
    let pdf = "%PDF-1.4\n";
    bodies.forEach((body, i) => {
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    pdf += "trailer<</Size 6/Root 1 0 R>>\n%%EOF";

    const res = await extractDocumentText(att("test.pdf", new TextEncoder().encode(pdf)));
    expect(res).not.toBeNull();
    expect(res!.text).toContain("Claw2 PDF test");
  }, 30_000);

  it("returns a note (not a throw) for a broken PDF", async () => {
    const res = await extractDocumentText(att("битый.pdf", new TextEncoder().encode("%PDF-1.4 garbage")));
    expect(res).not.toBeNull();
    expect(res!.text).toBe("");
    expect(res!.note).toMatch(/не удалось/);
  }, 30_000);

  it("reports a text-less PDF instead of an error", async () => {
    // Valid structure, empty content stream: no text layer (e.g. a scan).
    const stream = "0 0 300 200 re f";
    const bodies = [
      "<</Type/Catalog/Pages 2 0 R>>",
      "<</Type/Pages/Kids[3 0 R]/Count 1>>",
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R>>",
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    bodies.forEach((body, i) => {
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    pdf += "trailer<</Size 5/Root 1 0 R>>\n%%EOF";

    const res = await extractDocumentText(att("скан.pdf", new TextEncoder().encode(pdf)));
    expect(res).not.toBeNull();
    expect(res!.text).toBe("");
    expect(res!.note).toMatch(/текстового слоя/);
  }, 30_000);
});

describe("extractDocumentText: guards", () => {
  it("returns null for non-extractable attachments without importing libraries", async () => {
    expect(await extractDocumentText(att("фото.jpg", new Uint8Array([1, 2, 3]), "image/jpeg"))).toBeNull();
    expect(
      await extractDocumentText({ name: "пусто.pdf", contentBase64: "!!!not-base64!!!" })
    ).toBeNull();
    expect(await extractDocumentText({ name: "пусто.pdf", contentBase64: "" })).toBeNull();
  });
});
