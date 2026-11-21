// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * The canonical skill header for the run_agent and UI directory.
 *
 * // Agent: short assignment
 * // Call: run_agent({script:"name.js", stdin:"…" | args:[…]})
 * // In: what's in the input data
 * // Out: what's in stdout / FILE_URL=…
 *
 * Synonyms are allowed: Usage/Call, Input, Output.
 */

export interface SkillHeader {
  description: string;
  call: string;
  input: string;
  output: string;
  /** Other // header lines (saved during rewrite).*/
  extra: string[];
}

export interface ParsedSkillHeader extends SkillHeader {
  /** true if there is Agent + Call + In + Out*/
  complete: boolean;
  /** One-line help for tool catalog.*/
  help: string;
}

const AGENT_RE = /^\s*\/\/\s*Agent:\s*(.+)$/i;
const CALL_RE = /^\s*\/\/\s*(?:Call|Usage|Вызов):\s*(.+)$/i;
const IN_RE = /^\s*\/\/\s*(?:In|Input|Вход):\s*(.+)$/i;
const OUT_RE = /^\s*\/\/\s*(?:Out|Output|Выход):\s*(.+)$/i;
const COMMENT_RE = /^\s*\/\/\s?(.*)$/;

export function formatSkillHeader(h: {
  description: string;
  call: string;
  input: string;
  output: string;
  extra?: string[];
}): string {
  const lines = [
    `// Agent: ${h.description.trim()}`,
    `// Call: ${h.call.trim()}`,
    `// In: ${h.input.trim()}`,
    `// Out: ${h.output.trim()}`,
  ];
  for (const e of h.extra ?? []) {
    const t = e.trim();
    if (t) lines.push(`// ${t}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseSkillHeader(source: string): ParsedSkillHeader {
  const lines = source.split(/\r?\n/);
  let description = "";
  let call = "";
  let input = "";
  let output = "";
  const extra: string[] = [];
  let inHeader = false;

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i] ?? "";
    if (!inHeader) {
      if (/^\s*$/.test(line) || /^\s*#\!/.test(line)) continue;
      const ag = line.match(AGENT_RE);
      if (ag) {
        description = ag[1].trim();
        inHeader = true;
        continue;
      }
      if (/^\s*\/\//.test(line)) continue;
      break;
    }
    const callM = line.match(CALL_RE);
    if (callM) {
      call = callM[1].trim();
      continue;
    }
    const inM = line.match(IN_RE);
    if (inM) {
      input = inM[1].trim();
      continue;
    }
    const outM = line.match(OUT_RE);
    if (outM) {
      output = outM[1].trim();
      continue;
    }
    const ag = line.match(AGENT_RE);
    if (ag) {
      description = ag[1].trim();
      continue;
    }
    const c = line.match(COMMENT_RE);
    if (!c) break;
    const body = (c[1] ?? "").trim();
    if (!body) {
      if (call || input || output || extra.length) break;
      continue;
    }
    // Legacy free-form help lines → bucket into missing fields when possible
    if (!call && /run_agent|stdin|args\[|argv/i.test(body)) {
      call = body;
      continue;
    }
    if (!input && /^(вход|in|stdin|argv)/i.test(body)) {
      input = body.replace(/^(вход|in)\s*:\s*/i, "");
      continue;
    }
    if (!output && /^(выход|out|stdout|FILE_URL|CHART_)/i.test(body)) {
      output = body.replace(/^(выход|out)\s*:\s*/i, "");
      continue;
    }
    extra.push(body);
  }

  const complete = Boolean(description && call && input && output);
  const helpParts = [call, input && `In: ${input}`, output && `Out: ${output}`, ...extra].filter(
    Boolean
  ) as string[];
  return {
    description,
    call,
    input,
    output,
    extra,
    complete,
    help: helpParts.join(" | ").replace(/\s+/g, " ").trim(),
  };
}

/** Check before recording skill.*/
export function validateSkillSource(
  scriptName: string,
  source: string
): { ok: true } | { ok: false; error: string } {
  const h = parseSkillHeader(source);
  if (!h.description) {
    return {
      ok: false,
      error: `Skill ${scriptName}: missing "// Agent: …" header line`,
    };
  }
  if (!h.call || !h.input || !h.output) {
    return {
      ok: false,
      error:
        `Skill ${scriptName}: incomplete usage header. Required after Agent:\n` +
        `// Call: run_agent({script:"${scriptName}", …})\n` +
        `// In: …\n` +
        `// Out: …`,
    };
  }
  return { ok: true };
}

/**
 * Removes the old header (comments before the first code) and puts in the canonical one.
 */
export function replaceSkillHeader(source: string, header: SkillHeader): string {
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (/^\s*$/.test(lines[i]!) || /^\s*#\!/.test(lines[i]!))) i++;
  // keep shebang if any
  let shebang = "";
  if (i > 0 && /^\s*#\!/.test(lines[0]!)) {
    shebang = `${lines[0]}\n`;
    // find end of leading blank+shebang already handled; re-scan from 0
  }
  // Find start of header or code
  let start = 0;
  if (/^\s*#\!/.test(lines[0] ?? "")) start = 1;
  while (start < lines.length && /^\s*$/.test(lines[start]!)) start++;
  let end = start;
  if (AGENT_RE.test(lines[start] ?? "") || COMMENT_RE.test(lines[start] ?? "")) {
    end = start;
    while (end < lines.length) {
      const L = lines[end]!;
      if (/^\s*$/.test(L)) {
        end++;
        break;
      }
      if (!COMMENT_RE.test(L)) break;
      end++;
    }
    while (end < lines.length && /^\s*$/.test(lines[end]!)) end++;
  }
  const body = lines.slice(end).join("\n").replace(/^\n+/, "");
  const head = formatSkillHeader(header);
  return `${shebang}${head}\n${body}`.replace(/\n{3,}/g, "\n\n");
}

/** Heuristic Call/In/Out by code if the header is incomplete.*/
export function inferSkillUsage(scriptName: string, source: string): SkillHeader {
  const parsed = parseSkillHeader(source);
  const usesStdin =
    /process\.stdin|readStdin|for await \(const chunk of stdin\)|stdin\.on\(/.test(source);
  const usesArgv = /process\.argv\[2\]|process\.argv\.slice\(2\)/.test(source);
  let call = parsed.call;
  if (!call) {
    if (usesStdin && usesArgv) {
      call = `run_agent({script:"${scriptName}", args:["…"], stdin:"…"})`;
    } else if (usesStdin) {
      call = `run_agent({script:"${scriptName}", stdin:"…"})`;
    } else if (usesArgv) {
      call = `run_agent({script:"${scriptName}", args:["…"]})`;
    } else {
      call = `run_agent({script:"${scriptName}"})`;
    }
  }
  let input = parsed.input;
  if (!input) {
    const parts: string[] = [];
    if (usesArgv) parts.push("argv[2+]=args");
    if (usesStdin) parts.push("stdin=text/JSON");
    input = parts.length ? parts.join("; ") : "no args (runs with defaults)";
  }
  let output = parsed.output;
  if (!output) {
    if (/FILE_URL=/.test(source)) output = "stdout: FILE_URL=/files/output/…";
    else if (/CHART_IMAGE_URL=/.test(source)) output = "stdout: CHART_IMAGE_URL=/files/output/… (+ optional CHART_JSON)";
    else if (/console\.log/.test(source)) output = "stdout: result text/JSON; exit 0/1";
    else output = "stdout/stderr; exit code";
  }
  return {
    description: parsed.description || scriptName.replace(/\.js$/i, ""),
    call,
    input,
    output,
    extra: parsed.extra,
  };
}
