/** Append-only chat transcript (not affected by summarize).*/

export interface TranscriptSearchHit {
  messageId: number;
  role: "user" | "assistant";
  excerpt: string;
  createdAt: number;
  matchIndex?: number;
}

export interface TranscriptMessage {
  messageId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface TranscriptListItem {
  messageId: number;
  role: "user" | "assistant";
  preview: string;
  createdAt: number;
}

export interface TranscriptListResult {
  items: TranscriptListItem[];
  totalCount: number;
  /** For pagination: pass in the afterId of the next transcript_list.*/
  nextAfterId?: number;
}

export interface TranscriptListOptions {
  /** Return messages with id > afterId (0 or omit - from the beginning).*/
  afterId?: number;
  limit?: number;
}

export interface TranscriptReadResult {
  messages: TranscriptMessage[];
  truncated?: boolean;
  anchorMessageId?: number;
  fromId?: number;
  toId?: number;
}

export interface TranscriptReadOptions {
  /** Transcript line ID (from transcript_list / transcript_search).*/
  messageId?: number;
  /** If there is no messageId, take the first match in the substring.*/
  query?: string;
  /** How many messages up to and including anchor (default 0).*/
  before?: number;
  /** How many after anchor (default 1).*/
  after?: number;
  /** Range: initial id (inclusive).*/
  fromId?: number;
  /** Range: ending id (inclusive).*/
  toId?: number;
  /** With fromId without toId - how many messages ahead (default 5).*/
  limit?: number;
}

export interface TranscriptSessionAccess {
  search(query: string, limit?: number): TranscriptSearchHit[];
  list(options?: TranscriptListOptions): TranscriptListResult;
  read(options: TranscriptReadOptions): TranscriptReadResult;
}

export const TRANSCRIPT_SEARCH_DEFAULT_LIMIT = 5;
export const TRANSCRIPT_SEARCH_MAX_LIMIT = 8;
export const TRANSCRIPT_SEARCH_EXCERPT_CHARS = 400;
export const TRANSCRIPT_LIST_DEFAULT_LIMIT = 20;
export const TRANSCRIPT_LIST_MAX_LIMIT = 50;
export const TRANSCRIPT_LIST_PREVIEW_CHARS = 120;
export const TRANSCRIPT_READ_MAX_MESSAGES = 5;
export const TRANSCRIPT_READ_RANGE_MAX_MESSAGES = 10;
export const TRANSCRIPT_READ_MAX_TOTAL_CHARS = 12_000;
export const TRANSCRIPT_MAX_TOOL_CALLS_PER_TURN = 30;
export const TRANSCRIPT_TOC_MAX_ENTRIES = 60;
export const TRANSCRIPT_TOC_PREVIEW_CHARS = 100;
export const TRANSCRIPT_TOC_MAX_CHARS = 4500;
