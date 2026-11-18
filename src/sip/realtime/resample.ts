/**
 * Resample helpers: SIP G.711 path (8 kHz) ↔ Realtime provider rates (e.g. 24 kHz).
 */
import { resamplePcm16, SIP_PCM_RATE } from "../audio.js";
import { DEFAULT_REALTIME_PROVIDER_RATE } from "./types.js";

export { SIP_PCM_RATE, DEFAULT_REALTIME_PROVIDER_RATE };

/** SIP PCM16 mono @ sipRate → provider rate. */
export function sipPcmToProvider(
  pcmSip: Buffer,
  providerRate: number = DEFAULT_REALTIME_PROVIDER_RATE,
  sipRate: number = SIP_PCM_RATE
): Buffer {
  if (!pcmSip.length) return pcmSip;
  return resamplePcm16(pcmSip, sipRate, providerRate);
}

/** Provider PCM16 mono @ providerRate → SIP rate. */
export function providerPcmToSip(
  pcmProvider: Buffer,
  providerRate: number = DEFAULT_REALTIME_PROVIDER_RATE,
  sipRate: number = SIP_PCM_RATE
): Buffer {
  if (!pcmProvider.length) return pcmProvider;
  return resamplePcm16(pcmProvider, providerRate, sipRate);
}
