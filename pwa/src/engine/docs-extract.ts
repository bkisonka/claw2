/**
 * Inbound-document text extraction (pdf / xlsx / docx) — mobile counterpart of
 * the desktop readers (pdf-parse/mammoth in the agent sandbox). Libraries are
 * lazy-imported so their chunks load only when such a document is attached.
 *
 * xlsx is parsed with the npm SheetJS line (0.18.x): its published advisories
 * (prototype pollution / ReDoS on hostile sheets) have no npm fix — accepted,
 * because the only parser input is the user's own file on their own device.
 */
const MAX_EXTRACT_CHARS = 120_000;

export type ExtractableKind = "pdf" | "xlsx" | "docx";

export type ExtractResult = {
  text: string;
  /** Appended to the prompt next to the file name (no text → explains why). */
  note?: string;
};

export type BinaryAttachment = {
  name: string;
  contentBase64: string;
  mimeType?: string;
};

/** pdf / xlsx-family / docx by extension first (Android pickers often send no mime). */
export function extractableKind(name: string, mime?: string): ExtractableKind | null {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const m = (mime ?? "").toLowerCase();
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (
    ["xlsx", "xlsm", "xls", "ods"].includes(ext) ||
    /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(m)
  ) {
    return "xlsx";
  }
  if (ext === "docx" || /wordprocessingml\.document/.test(m)) return "docx";
  return null;
}

function attachmentBytes(att: BinaryAttachment): Uint8Array | null {
  try {
    const bin = atob(att.contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  const pdfjs = await import("pdfjs-dist");
  // Browser only: Vite rewrites the URL to the bundled worker asset. In Node
  // (tests, where vite.config aliases pdfjs-dist to its legacy build) the fake
  // worker is resolved relative to the library itself, and a pre-set workerSrc
  // would point at a nonexistent path and break it.
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).href;
  }
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text +=
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim() + "\n\n";
    if (text.length >= MAX_EXTRACT_CHARS) break;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { text: "", note: "в PDF нет текстового слоя (вероятно скан) — текст извлечь нельзя" };
  }
  return { text: trimmed };
}

async function extractSheet(bytes: Uint8Array): Promise<ExtractResult> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array" });
  let text = "";
  for (const sheetName of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]).trim();
    if (csv) text += `### Лист: ${sheetName}\n${csv}\n\n`;
    if (text.length >= MAX_EXTRACT_CHARS) break;
  }
  const trimmed = text.trim();
  if (!trimmed) return { text: "", note: "таблица пуста" };
  return { text: trimmed };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractResult> {
  const mammoth = await import("mammoth");
  // The browser build (what Vite ships) reads `arrayBuffer`, the Node build
  // (tests) reads `buffer`; each build ignores the other key.
  const res = await mammoth.extractRawText({
    arrayBuffer: exactBuffer(bytes),
    buffer: bytes,
  });
  const text = (res.value ?? "").trim();
  if (!text) return { text: "", note: "документ без текста" };
  return { text };
}

/**
 * Extract text for the prompt, or null when the type is not extractable
 * (caller falls back to its opaque-attachment placeholder). Never throws —
 * a broken document yields a note instead of a failed turn.
 */
export async function extractDocumentText(att: BinaryAttachment): Promise<ExtractResult | null> {
  if (!extractableKind(att.name, att.mimeType)) return null;
  const bytes = attachmentBytes(att);
  if (!bytes || bytes.length === 0) return null;
  try {
    const kind = extractableKind(att.name, att.mimeType)!;
    if (kind === "pdf") return await extractPdf(bytes);
    if (kind === "xlsx") return await extractSheet(bytes);
    return await extractDocx(bytes);
  } catch (e) {
    return { text: "", note: `не удалось извлечь текст (${e instanceof Error ? e.message : "ошибка"})` };
  }
}
