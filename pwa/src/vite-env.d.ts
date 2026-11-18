/// <reference types="vite/client" />

// mammoth ships no types; only the API used by engine/docs-extract.ts.
declare module "mammoth" {
  export function extractRawText(input: {
    arrayBuffer: ArrayBuffer;
    buffer: Uint8Array;
  }): Promise<{ value: string; messages: unknown[] }>;
}
