// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Phone_call tool: calls via SIP UA (virtual PBX) + voice STT/TTS.
 */
import type { Claw2Config } from "../config/types.js";
import { isPhoneCallToolEnabled } from "../config/sip.js";
import { getSipClient } from "../sip/client.js";

export type PhoneCallAction =
  | "status"
  | "dial"
  | "answer"
  | "hangup"
  | "say"
  | "listen"
  | "dtmf"
  | "transfer";

export async function toolPhoneCall(
  config: Claw2Config,
  args: {
    action?: string;
    to?: string;
    text?: string;
    seconds?: number;
    digits?: string;
    target?: string;
  }
): Promise<{ ok: boolean; content: string }> {
  if (!isPhoneCallToolEnabled(config)) {
    return {
      ok: false,
      content:
        "Error: SIP phone not configured. Enable sip.enabled and set server/user/password in Settings.",
    };
  }

  const client = getSipClient();
  // Ensure UA matches current config (desktop may save without restart)
  await client.sync(config).catch((err) => {
    console.error("[phone_call] sip sync:", err);
  });

  const action = String(args.action ?? "status").trim().toLowerCase() as PhoneCallAction;

  try {
    switch (action) {
      case "status": {
        const st = client.getStatus();
        return { ok: true, content: JSON.stringify(st, null, 2) };
      }
      case "dial": {
        const to = String(args.to ?? "").trim();
        if (!to) return { ok: false, content: "Error: dial requires to (number or sip:uri)" };
        const st = await client.dial(to);
        const connected = st.call?.state === "active";
        return {
          ok: connected,
          content: connected
            ? `Call connected (state=${st.call?.state}).\n${JSON.stringify(st, null, 2)}`
            : `Error: dial finished without active call.\n${JSON.stringify(st, null, 2)}`,
        };
      }
      case "answer": {
        const st = await client.answer();
        return { ok: true, content: `Answered.\n${JSON.stringify(st, null, 2)}` };
      }
      case "hangup": {
        const st = await client.hangup();
        return { ok: true, content: `Hung up.\n${JSON.stringify(st, null, 2)}` };
      }
      case "say": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, content: "Error: say requires text" };
        const result = await client.say(text);
        if (result.ok) return { ok: true, content: "Spoken on the line." };
        const st = client.getStatus();
        return {
          ok: false,
          content: `Error: ${result.error}\n${JSON.stringify(st, null, 2)}`,
        };
      }
      case "listen": {
        const seconds = typeof args.seconds === "number" ? args.seconds : 5;
        const result = await client.listen(seconds);
        if (result.ok) {
          return {
            ok: true,
            content: result.text ? `Heard: ${result.text}` : "Heard: (silence / empty)",
          };
        }
        const st = client.getStatus();
        return {
          ok: false,
          content: `Error: ${result.error}\n${JSON.stringify(st, null, 2)}`,
        };
      }
      case "dtmf": {
        const digits = String(args.digits ?? "").trim();
        if (!digits) return { ok: false, content: "Error: dtmf requires digits" };
        await client.dtmf(digits);
        return { ok: true, content: `DTMF sent: ${digits}` };
      }
      case "transfer": {
        await client.transfer(typeof args.target === "string" ? args.target : undefined);
        return { ok: true, content: "Transfer (REFER) sent." };
      }
      default:
        return {
          ok: false,
          content: `Error: unknown action "${action}". Use status|dial|answer|hangup|say|listen|dtmf|transfer`,
        };
    }
  } catch (err) {
    const st = client.getStatus();
    return {
      ok: false,
      content: `Error: ${err instanceof Error ? err.message : String(err)}\n${JSON.stringify(st, null, 2)}`,
    };
  }
}
