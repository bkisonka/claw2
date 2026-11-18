export {
  findPrivacyOcrSidecarBinary,
  listPrivacyOcrSidecarCandidates,
  resolveMultimodalBackend,
  resolveMultimodalBackendMode,
} from "./find-binary.js";
export type { MultimodalBackendMode, ResolvedMultimodalBackend } from "./find-binary.js";
export { PrivacyOcrClient } from "./client.js";
export type { OcrWord, PaintBox } from "./client.js";
export {
  defaultPrivacyOcrIpcPath,
  spawnPrivacyOcrSidecar,
  stopPrivacyOcrProcess,
} from "./spawn.js";
export { PdocIpcType, packPdocFrame, unpackPdocHeader } from "./protocol.js";
