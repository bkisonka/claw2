/**
 * Preloaded into every skill process when sandbox.egress.mode is "guard"
 * (NODE_OPTIONS=--require <dist/egress-preload.cjs>): forces the skill's
 * outbound HTTP(S) through the gateway's egress guard proxy, which applies
 * the same SSRF rules as web_fetch. Bundled by esbuild into a single
 * self-contained file (see package.json "build:egress-preload"): the skill
 * container has no node_modules of its own.
 *
 * Covered: global fetch (undici dispatcher), node:http / node:https global
 * agents (axios, got, node-fetch@2), and the well-known undici global
 * dispatcher slot (node-fetch@3 and other bundled-undici copies).
 * Known soft-tier limitation: a skill that speaks TLS over raw sockets
 * (node:net/node:tls) bypasses this preload — kernel-level isolation is
 * provided by the Docker tier (--internal network) instead.
 *
 * Runs before the skill's first line; the skill cannot unset it.
 */
import { ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import { createRequire } from "node:module";
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";

// This module is never executed as source: it is bundled to CJS
// (dist/egress-preload.cjs, the --require target), where __filename exists.
declare const __filename: string;

// node:http / node:https via createRequire: the module objects must stay
// mutable (we patch globalAgent), while undici and the proxy agents are
// statically imported so esbuild bundles them into the single-file preload.
const requireBuiltin = createRequire(__filename);
const http = requireBuiltin("node:http") as unknown as { globalAgent: HttpAgent };
const https = requireBuiltin("node:https") as unknown as { globalAgent: HttpsAgent };

const proxyUrl = process.env.CLAW2_EGRESS_PROXY?.trim();
if (proxyUrl) {
  try {
    const dispatcher = new ProxyAgent(proxyUrl);

    // Global fetch (what a bare `fetch(...)` resolves to in Node 18+) is
    // replaced wholesale: undici's spec fetch with the proxy dispatcher —
    // Node's built-in fetch cannot be pointed at a proxy otherwise.
    globalThis.fetch = ((input: unknown, init?: unknown) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as object),
        dispatcher,
      } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;

    // Bundled undici copies (node-fetch@3, some SDK clients) read the
    // well-known global dispatcher slot; version skew is usually tolerated
    // (duck-typed). Optional path — global fetch above is the primary layer.
    try {
      setGlobalDispatcher(dispatcher);
    } catch {
      /* keep the primary layers */
    }

    // node:http / node:https global agents: axios, got, node-fetch@2 and
    // anything using the default agents.
    http.globalAgent = new HttpProxyAgent(proxyUrl) as unknown as HttpAgent;
    https.globalAgent = new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent;
  } catch (err) {
    // Fail closed: without a working guard connection the skill gets no
    // network at all rather than an unguarded one.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[egress-preload] guard setup failed, disabling fetch (${msg})`);
    globalThis.fetch = (() => {
      throw new Error("egress guard setup failed; network disabled (fail-closed)");
    }) as unknown as typeof fetch;
  }
}
