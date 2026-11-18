/**
 * Task ID for natural selection of agents.
 * taskId = first 16 hex characters from SHA-256(toolName + ":" + JSON.stringify(inputSchema)).
 * Different inputs/pattern (for example “PDF parsing” and “DOCX parsing”) yield different niches.
 */
import { createHash } from "node:crypto";

export function computeTaskId(toolName: string, inputSchema: Record<string, unknown>): string {
  const payload = `${toolName}:${JSON.stringify(inputSchema)}`;
  return createHash("sha256").update(payload).digest("hex").substring(0, 16);
}
