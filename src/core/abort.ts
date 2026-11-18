export class AbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortError(
      typeof signal.reason === "string"
        ? signal.reason
        : signal.reason instanceof Error && signal.reason.message
          ? signal.reason.message
          : undefined
    );
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
}
