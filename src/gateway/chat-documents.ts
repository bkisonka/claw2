/**
 * Chat documents: links /files/output|uploads/… from history + files with sessionId prefix.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveAssistantCells } from "../core/cell-blocks.js";
import { isImagePath } from "./gallery.js";
import type { SessionMessage } from "./db/chat-repository.js";

const DOC_EXT_RE =
  /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|json|xml|ya?ml|rtf|odt|ods|odp|zip|html?|tsv|log)$/i;

const FILE_REF_RE = /\/files\/(output|uploads)\/([A-Za-z0-9._-]+)/gi;
const REL_FILE_RE = /(?:^|[\s("'=])(?:agents\/)?(output|uploads)\/([A-Za-z0-9._-]+)/gi;

export function isDocumentPath(nameOrUrl: string): boolean {
  const base = nameOrUrl.split("/").filter(Boolean).pop() ?? nameOrUrl;
  return DOC_EXT_RE.test(base) && !isImagePath(base);
}

export interface ChatDocumentItem {
  url: string;
  name: string;
  path: string;
  ext: string;
}

function pushDoc(
  out: ChatDocumentItem[],
  seen: Set<string>,
  sub: string,
  fileName: string
): void {
  if (!fileName || !isDocumentPath(fileName)) return;
  const path = `${sub}/${fileName}`;
  if (seen.has(path)) return;
  seen.add(path);
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  out.push({
    url: `/files/${path}`,
    name: fileName,
    path,
    ext,
  });
}

function scanTextForDocs(text: string, out: ChatDocumentItem[], seen: Set<string>): void {
  if (!text) return;
  for (const re of [FILE_REF_RE, REL_FILE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const sub = (m[1] ?? "").toLowerCase();
      const name = m[2] ?? "";
      if (sub === "output" || sub === "uploads") pushDoc(out, seen, sub, name);
    }
  }
  const md = text.matchAll(/\[[^\]]*\]\(\s*(\/files\/(?:output|uploads)\/[A-Za-z0-9._-]+)\s*\)/gi);
  for (const hit of md) {
    const raw = hit[1] ?? "";
    const parts = raw.replace(/^\/files\//, "").split("/");
    if (parts.length === 2) pushDoc(out, seen, parts[0].toLowerCase(), parts[1]);
  }
}

/** Unique documents mentioned in chat messages.*/
export function collectChatDocuments(messages: SessionMessage[]): ChatDocumentItem[] {
  const seen = new Set<string>();
  const out: ChatDocumentItem[] = [];
  for (const m of messages) {
    scanTextForDocs(m.content ?? "", out, seen);
    if (m.meta) {
      const { content, cells } = resolveAssistantCells(m.content, m.meta);
      scanTextForDocs(content, out, seen);
      for (const cell of cells) {
        if (cell.type === "image" || cell.type === "image_deleted") continue;
        scanTextForDocs(cell.content ?? "", out, seen);
      }
    }
  }
  return out;
}

/** Files in output/uploads with the prefix sessionId (attachments and saved by the agent).*/
export function collectSessionPrefixedDocuments(
  sessionId: string,
  dirs: { outputDir: string; uploadsDir: string }
): ChatDocumentItem[] {
  const sid = sessionId.trim();
  if (!sid) return [];
  const seen = new Set<string>();
  const out: ChatDocumentItem[] = [];
  const scan = (absDir: string, sub: "output" | "uploads") => {
    if (!existsSync(absDir)) return;
    let names: string[] = [];
    try {
      names = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(sid)) continue;
      if (!isDocumentPath(name)) continue;
      try {
        const st = statSync(join(absDir, name));
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      pushDoc(out, seen, sub, basename(name));
    }
  };
  scan(dirs.outputDir, "output");
  scan(dirs.uploadsDir, "uploads");
  return out;
}

export function mergeChatDocuments(...lists: ChatDocumentItem[][]): ChatDocumentItem[] {
  const seen = new Set<string>();
  const out: ChatDocumentItem[] = [];
  for (const list of lists) {
    for (const d of list) {
      if (seen.has(d.path)) continue;
      seen.add(d.path);
      out.push(d);
    }
  }
  return out;
}
