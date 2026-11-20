/**
 * Server-verified vision identity.
 *
 * A vision claim about "who is in front of the camera" is only trusted when
 * the recognition service signed it with the shared secret
 * (vision.recognizeSecret): HMAC-SHA256 over `${userId}:${ts}`. The browser
 * merely relays the claim — it never holds the secret. Claims without a valid
 * signature are rejected outright (hard reject): no memory binding, no
 * superuser, not even display. Telegram/VK channels are exempt: their userId
 * comes from the platform payload the gateway received itself, which is
 * server-side identity by construction.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Freshness window for a claim (recognizer and gateway clock skew). */
export const VISION_CLAIM_MAX_AGE_MS = 30_000;

export interface VisionClaim {
  userId: string;
  ts: number;
  sig: string;
}

export function signVisionClaim(secret: string, userId: string, ts: number): string {
  return createHmac("sha256", secret).update(`${userId}:${ts}`).digest("hex");
}

export type VisionClaimCheck = { ok: true } | { ok: false; reason: string };

/** Constant-time, order-independent signature compare. */
function sigEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyVisionClaim(
  secret: string,
  claim: Partial<VisionClaim> | null | undefined,
  nowMs: number = Date.now(),
  maxAgeMs: number = VISION_CLAIM_MAX_AGE_MS
): VisionClaimCheck {
  if (!claim) return { ok: false, reason: "missing" };
  const { userId, ts, sig } = claim;
  if (typeof userId !== "string" || !userId.trim()) return { ok: false, reason: "missing_userId" };
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "bad_sig_format" };
  if (typeof ts !== "number" || !Number.isFinite(ts)) return { ok: false, reason: "bad_ts" };
  if (Math.abs(nowMs - ts) > maxAgeMs) return { ok: false, reason: "stale" };
  const expected = signVisionClaim(secret, userId.trim(), ts);
  if (!sigEqual(expected, sig)) return { ok: false, reason: "bad_sig" };
  return { ok: true };
}
