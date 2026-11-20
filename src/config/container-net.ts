/**
 * Container-aware loopback mapping.
 *
 * In the containerized delivery (compose), the gateway process runs inside a
 * container: URLs the operator writes as 127.0.0.1 / localhost refer to
 * services on the HOST (a local llama.cpp, Ollama, LM Studio, SearXNG…),
 * which the container cannot reach — they must map to host.docker.internal.
 * On the host (desktop / bare-metal), the same 127.0.0.1 values are correct.
 *
 * Detection is per-process: /.dockerenv (standard container marker) or the
 * explicit CLAW2_IN_CONTAINER=1 escape hatch.
 *
 * The rewrite is applied when the config is loaded (src/config/load.ts), so
 * the stored YAML keeps the operator's portable 127.0.0.1 form while every
 * consumer gets the container-correct address. Only user-facing service URLs
 * are mapped — internal runtime endpoints (e.g. the in-container embed
 * daemon, spawned by the gateway itself) never pass through this path.
 */

import { existsSync } from "node:fs";

let detected: boolean | null = null;

export function isGatewayInContainer(): boolean {
  if (detected === null) {
    detected = existsSync("/.dockerenv") || process.env.CLAW2_IN_CONTAINER === "1";
  }
  return detected;
}

/** Test hook. */
export function __setInContainerForTest(value: boolean | null): void {
  detected = value;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** Rewrite a single URL when its host is loopback. Returns null when unchanged. */
export function mapLoopbackToHostGateway(url: string): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.has(host) && host !== "0.0.0.0") return null;
    u.hostname = "host.docker.internal";
    const out = u.toString();
    // URL.toString() appends "/" to bare origins; keep the operator's form
    // when they wrote it without a trailing slash.
    return trimmed.endsWith("/") || out.endsWith("/") ? out : out.replace(/\/$/, "");
  } catch {
    return null;
  }
}

type UrlTargets = Record<string, string | undefined>;

/**
 * Map loopback URLs of user-facing services to host.docker.internal.
 * Mutates the passed config object in place; returns the number of fields
 * changed (for the one-time startup log).
 */
export function normalizeContainerServiceUrls(config: {
  llm?: { baseURL?: string };
  llmBridge?: { url?: string };
  vision?: { recognizeUrl?: string };
  gateway?: { databaseUrl?: string };
  memory?: { chroma?: { url?: string }; embeddingBaseURL?: string };
  tools?: {
    sdUrl?: string;
    searxng?: { url?: string };
    other?: { url?: string };
  };
  voice?: { sttUrl?: string; ttsUrl?: string };
  channels?: {
    telegram?: { voice?: { sttUrl?: string; ttsUrl?: string } };
    vk?: { voice?: { sttUrl?: string; ttsUrl?: string } };
  };
}): number {
  if (!isGatewayInContainer()) return 0;
  let changed = 0;

  const apply = (obj: UrlTargets | undefined, key: string): void => {
    if (!obj) return;
    const value = obj[key];
    if (typeof value !== "string") return;
    const mapped = mapLoopbackToHostGateway(value);
    if (mapped && mapped !== value) {
      obj[key] = mapped;
      changed++;
    }
  };

  apply(config.llm, "baseURL");
  apply(config.llmBridge, "url");
  apply(config.vision, "recognizeUrl");
  apply(config.gateway, "databaseUrl");
  apply(config.memory?.chroma, "url");
  const memEmbed = config.memory?.embeddingBaseURL;
  if (typeof memEmbed === "string") {
    const mapped = mapLoopbackToHostGateway(memEmbed);
    if (mapped && mapped !== memEmbed && config.memory) {
      config.memory.embeddingBaseURL = mapped;
      changed++;
    }
  }
  const sd = config.tools?.sdUrl;
  if (typeof sd === "string") {
    const mapped = mapLoopbackToHostGateway(sd);
    if (mapped && mapped !== sd && config.tools) {
      config.tools.sdUrl = mapped;
      changed++;
    }
  }
  const searx = config.tools?.searxng?.url;
  if (typeof searx === "string" && config.tools?.searxng) {
    const mapped = mapLoopbackToHostGateway(searx);
    if (mapped && mapped !== searx) {
      config.tools.searxng.url = mapped;
      changed++;
    }
  }
  const otherUrl = config.tools?.other?.url;
  if (typeof otherUrl === "string" && config.tools?.other) {
    const mapped = mapLoopbackToHostGateway(otherUrl);
    if (mapped && mapped !== otherUrl) {
      config.tools.other.url = mapped;
      changed++;
    }
  }
  apply(config.voice, "sttUrl");
  apply(config.voice, "ttsUrl");
  apply(config.channels?.telegram?.voice, "sttUrl");
  apply(config.channels?.telegram?.voice, "ttsUrl");
  apply(config.channels?.vk?.voice, "sttUrl");
  apply(config.channels?.vk?.voice, "ttsUrl");

  return changed;
}
