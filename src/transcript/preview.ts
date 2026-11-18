/** One-line preview of the transcript message.*/
export function transcriptPreview(content: string, maxChars: number): string {
  const line = content.replace(/\s+/g, " ").trim();
  if (!line) return "(empty)";
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(1, maxChars - 1))}…`;
}
