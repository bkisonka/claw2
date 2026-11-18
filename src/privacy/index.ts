export type { PrivacyConfig, PrivacyCustomRule } from "./types.js";
export { PiiMasker, maskChatMessages, unmaskToolCalls } from "./pii-masker.js";
export { shouldApplyPrivacy, shouldApplyPrivacyForBaseURL } from "./should-apply.js";
export type { PrivacyApplyDecision } from "./should-apply.js";
export {
  compileCustomRule,
  compileCustomRules,
  kindSlugFromName,
  validateRulePattern,
} from "./rules-custom.js";
export { prepareMessagesForPrivacyMultimodal } from "./multimodal.js";
export {
  findPrivacyOcrSidecarBinary,
  resolveMultimodalBackend,
} from "./ocr-sidecar/index.js";
