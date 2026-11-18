/**
 * Undici fetch with a connect-time SSRF guard: a custom DNS lookup refuses to
 * hand the socket any loopback/private/link-local address. This closes the
 * TOCTOU window of the pre-fetch check — a hostile DNS server that answers a
 * private address at connect time (after passing the pre-check with a public
 * answer) is stopped here, because the socket opens only to a vetted IP.
 */
import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from "undici";
import { isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isPublicAddress } from "./url-guard.js";

function guardedLookup(
  hostname: string,
  options: { family?: number | string; all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
): void {
  const family = typeof options?.family === "number" ? options.family : 0;
  dnsLookup(
    hostname,
    { family: family === 4 || family === 6 ? family : 0, all: true, verbatim: true },
    (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : addresses ? [addresses] : [];
      const public_ = list.filter((a) => isPublicAddress(a.address));
      if (public_.length === 0) {
        return callback(
          Object.assign(
            new Error(`blocked: ${hostname} resolves only to private or internal addresses`),
            { code: "ESSRFBLOCKED" }
          )
        );
      }
      if (options?.all) {
        callback(null, public_ as LookupAddress[]);
      } else {
        callback(null, public_[0].address, public_[0].family);
      }
    }
  );
}

const guardedAgent = new Agent({
  connect: {
    timeout: 15_000,
    // undici passes connect options to net.connect; `lookup` is invoked at
    // socket-open time with the host the client is about to resolve.
    lookup: guardedLookup as never,
  },
});

/** fetch() whose sockets can only open to public addresses. */
export function fetchPublic(url: string, init?: UndiciRequestInit): Promise<UndiciResponse> {
  // IP literals bypass DNS (and therefore the lookup hook): check them here.
  // For hostnames the guarded lookup below is the connect-time gate.
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    /* let undici produce its own error */
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw Object.assign(new Error(`blocked: private or internal address (${host})`), {
      code: "ESSRFBLOCKED",
    });
  }
  return undiciFetch(url, { ...init, dispatcher: guardedAgent } as UndiciRequestInit);
}
