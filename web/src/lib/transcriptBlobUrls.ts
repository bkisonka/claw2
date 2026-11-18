const blobUrlsByChat = new Map<string, Set<string>>();

function isBlobUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("blob:");
}

/**
 * Register an object URL that is embedded in a cached chat transcript.
 * Composer previews and unrelated object URLs must not be registered here.
 */
export function trackTranscriptBlobPreviewUrl(
  chatId: string,
  url: string | null | undefined
): void {
  if (!chatId || !isBlobUrl(url)) return;
  const urls = blobUrlsByChat.get(chatId) ?? new Set<string>();
  urls.add(url);
  blobUrlsByChat.set(chatId, urls);
}

/** Release selected transcript previews after their server URLs replace them. */
export function releaseTranscriptBlobPreviewUrls(
  chatId: string,
  candidates: Iterable<string | null | undefined>
): void {
  const tracked = blobUrlsByChat.get(chatId);
  if (!tracked) return;
  for (const url of candidates) {
    if (!isBlobUrl(url) || !tracked.delete(url)) continue;
    URL.revokeObjectURL(url);
  }
  if (tracked.size === 0) blobUrlsByChat.delete(chatId);
}

/** Release every transcript preview owned by a chat that is being deleted. */
export function releaseChatTranscriptBlobPreviewUrls(chatId: string): void {
  const tracked = blobUrlsByChat.get(chatId);
  if (!tracked) return;
  blobUrlsByChat.delete(chatId);
  for (const url of tracked) URL.revokeObjectURL(url);
}
