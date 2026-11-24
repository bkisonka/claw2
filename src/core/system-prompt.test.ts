// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import { describe, expect, it } from "vitest";
import type { Claw2Config } from "../config/types.js";
import { CONTENT_BOUNDARY_WARNING } from "../security/content-boundary.js";
import { getSystemPrompt } from "./system-prompt.js";

/**
 * The assembly of the system prompt — which block lands in which mode,
 * switched by which flag, never twice — and not how a block is worded. A
 * block is told by the first words of its first line.
 */

type Mode = "full" | "compact";
type Flags = { image?: boolean; transcript?: boolean; phone?: boolean };

const PERSONA_FULL = "FULL-PERSONA-MARK.";
const PERSONA_COMPACT = "COMPACT-PERSONA-MARK.";
/** A persona of its own: the test must not depend on the assistant.md of the machine that runs it. */
const config = {
  assistant: { personaMarkdown: `## full\n\n${PERSONA_FULL}\n\n## compact\n\n${PERSONA_COMPACT}` },
} as Claw2Config;

const MODES: Mode[] = ["full", "compact"];
const prompt = (mode: Mode, flags: Flags = {}) =>
  getSystemPrompt(mode, undefined, flags.image, flags.transcript, flags.phone, config);

/** How many lines begin with `key`: 1 for the block it names, 0 when the block is absent. */
const blockStarts = (text: string, key: string): number =>
  text.split("\n").filter((line) => line.startsWith(key)).length;

/** Every block of the full prompt, the ones switched by a flag aside. */
const FULL_BLOCKS = [
  "Honesty and dedication:",
  "Current date and time",
  "claw2 project structure:",
  "Skills (scripts in agents/):",
  "run_agent tool:",
  "Writing a new skill (parent/subagent):",
  "write_agent tool:",
  "Tools for working with files",
  "search(query, engines?) tool:",
  "web_fetch(url) tool:",
  "open_browser(url) tool:",
  "read_browser_page() tool:",
  "Reading files to find something",
  "Memory and HSS are three circuits",
  "List of user tasks",
  "Reminders for tasks",
  "Sidebar context menu",
  "Skills Policy:",
  "Final reminder — code vs skills:",
  "Libraries for processing files are already installed",
  "Agent code: one .js in agents/.",
  "Inline cells in chat",
];

/** Every block of the default compact prompt, the phone aside. */
const COMPACT_BLOCKS = [
  "Current date and time",
  "Skills (scripts in agents/):",
  "Tools: run_agent(script, ...) when execution is needed.",
  "Memory: chronicle (session meaning)",
  "Transcript: transcript_list/read/search;",
  "Skills: run_agent when execution is needed.",
  "Online chat: only full block [CELL",
  "Files: after creating in output,",
  "Looking for files: get the listing first",
];

/** The same block in both modes. */
const SHARED_BLOCKS = ["Current date and time", "Skills (scripts in agents/):"];

/** Where a switched feature has its block in each mode. */
const SWITCHED: Record<Mode, { image: string; transcript: string; phone: string }> = {
  full: {
    image: "Generating and editing images:",
    transcript: "Transcript (transcript_*)",
    phone: "Phone (SIP / virtual PBX):",
  },
  compact: {
    image: "Tools: run_agent(script, ...) when execution is needed.",
    transcript: "Transcript: transcript_list/read/search;",
    phone: "Phone: phone_call. Call+number",
  },
};

/** What a caller may pass for a flag: nothing, true or false. */
const STATES = [undefined, true, false] as const;
/** Every combination of the three flags. Features off at the same time can hide each other, so each one is also off alone. */
const COMBINATIONS: Flags[] = STATES.flatMap((image) =>
  STATES.flatMap((transcript) => STATES.map((phone) => ({ image, transcript, phone })))
);

describe("system prompt assembly", () => {
  it("starts the full prompt with the full persona, the rules after it", () => {
    const full = prompt("full");
    expect(full.startsWith(`${PERSONA_FULL}\n\nHonesty and dedication:`)).toBe(true);
    expect(full).not.toContain(PERSONA_COMPACT);
  });

  it("starts the compact prompt with the compact persona, the rules on the same line", () => {
    const compact = prompt("compact");
    expect(compact.startsWith(`${PERSONA_COMPACT} Don't make up facts`)).toBe(true);
    expect(compact).not.toContain(PERSONA_FULL);
  });

  it("is the full prompt when no mode is given", () => {
    // The line with the date carries the time of the call.
    const withoutClock = (text: string) =>
      text.split("\n").filter((line) => !line.startsWith("Current date and time")).join("\n");
    const noMode = getSystemPrompt(undefined, undefined, undefined, undefined, undefined, config);
    expect(withoutClock(noMode)).toBe(withoutClock(prompt("full")));
  });

  it("keeps the two modes apart", () => {
    const full = prompt("full", { phone: true });
    const compact = prompt("compact", { phone: true });
    const fullBlocksInCompact = FULL_BLOCKS.filter(
      (key) => !SHARED_BLOCKS.includes(key) && blockStarts(compact, key) > 0
    );
    const compactBlocksInFull = COMPACT_BLOCKS.filter(
      (key) => !SHARED_BLOCKS.includes(key) && blockStarts(full, key) > 0
    );
    expect(fullBlocksInCompact).toEqual([]);
    expect(compactBlocksInFull).toEqual([]);
    expect(blockStarts(compact, SWITCHED.full.phone)).toBe(0);
    expect(blockStarts(full, SWITCHED.compact.phone)).toBe(0);
  });

  describe.each(MODES)("%s prompt", (mode) => {
    const block = SWITCHED[mode];

    it("carries every one of its blocks exactly once", () => {
      for (const key of mode === "full" ? FULL_BLOCKS : COMPACT_BLOCKS) {
        expect(blockStarts(prompt(mode), key), key).toBe(1);
      }
    });

    it("offers image generation and the transcript by default, and no phone", () => {
      const text = prompt(mode);
      expect(blockStarts(text, block.image)).toBe(1);
      expect(blockStarts(text, block.transcript)).toBe(1);
      expect(blockStarts(text, block.phone)).toBe(0);
    });

    it("offers each feature exactly while its flag is on, whatever the other flags are", () => {
      for (const flags of COMBINATIONS) {
        const text = prompt(mode, flags);
        const features = [
          ["image", "generate_image", flags.image !== false],
          ["transcript", "transcript_", flags.transcript !== false],
          ["phone", "phone_call", !!flags.phone],
        ] as const;
        for (const [feature, tool, on] of features) {
          const where = `${mode} prompt, ${feature}, flags ${JSON.stringify(flags)}`;
          expect(blockStarts(text, block[feature]), `${where}: block`).toBe(on ? 1 : 0);
          // The tool is named nowhere else either: the model cannot call what the schema lacks.
          expect(text.includes(tool), `${where}: tool named`).toBe(on);
        }
      }
    });

    it("repeats no line, whatever the flags", () => {
      for (const flags of COMBINATIONS) {
        const seen = new Set<string>();
        const again: string[] = [];
        for (const line of prompt(mode, flags).split("\n")) {
          const text = line.trim();
          if (!text) continue;
          if (seen.has(text)) again.push(text);
          seen.add(text);
        }
        expect(again, `flags ${JSON.stringify(flags)}`).toEqual([]);
      }
    });

    it("keeps the content boundary and the clock, whatever the flags", () => {
      for (const flags of COMBINATIONS) {
        const text = prompt(mode, flags);
        const where = `flags ${JSON.stringify(flags)}`;
        expect(text.includes(CONTENT_BOUNDARY_WARNING), `${where}: content boundary`).toBe(true);
        expect(blockStarts(text, "Current date and time"), `${where}: clock`).toBe(1);
      }
    });
  });

  it("compact without image generation swaps its one tools line whole", () => {
    expect(blockStarts(prompt("compact", { image: false }), "Tools: run_agent(skills directory);")).toBe(1);
  });

  it("keeps the compact prompt small", () => {
    // About 1 250 tokens; today it is some 3 600 characters. Compact mode is
    // there to spend few tokens on every call: outgrowing this is to be a decision.
    const BUDGET_CHARS = 5_000;
    const everythingOn = { image: true, transcript: true, phone: true };
    const compact = prompt("compact", everythingOn);
    // The persona is the user's text; the budget is for what the assembly adds.
    expect(compact.length - PERSONA_COMPACT.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(compact.length).toBeLessThan(prompt("full", everythingOn).length);
  });
});
