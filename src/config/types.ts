// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vitaliy Bondar

import type { PrivacyConfig } from "../privacy/types.js";

/**
 * Realtime speech-to-speech on a SIP line (Yandex / OpenAI / xAI).
 * Keys are separate from `llm.apiKey` unless an explicit `useLlmApiKey: true` is set.
 * `off` | `pipeline` — rollback to batch STT→LLM→TTS (listen/say).
 */
export type SipRealtimeProvider = "off" | "pipeline" | "yandex" | "openai" | "xai";

/** RTP media backend: Node stack vs optional native sidecar process. */
export type SipMediaBackendMode = "auto" | "node" | "sidecar";

export interface SipRealtimeConfig {
  /**
   * Realtime provider. Default is `off` (no Realtime).
   * `pipeline` is a synonym for three-link rollback.
   */
  provider?: SipRealtimeProvider;
  /**
   * Realtime API key (Yandex Api-Key / OpenAI / xAI).
   * Does not inherit from llm.apiKey without `useLlmApiKey`.
   */
  apiKey?: string;
  /**
   * Explicitly allow taking the key from `llm.apiKey` (and OPENAI_API_KEY) if your apiKey is empty.
   * Default is false.
   */
  useLlmApiKey?: boolean;
  /** Yandex Cloud folder id (required for provider=yandex).*/
  folderId?: string;
  /** Yandex IAM token as an alternative to apiKey.*/
  iamToken?: string;
  /** Realtime model (provider-specific).*/
  model?: string;
  /** Voice / voice id of the provider.*/
  voice?: string;
  /** Sample rate PCM provider (Hz), e.g. 24000 from Yandex.*/
  sampleRate?: number;
  /** Override WS/base URL of the provider (optional).*/
  baseURL?: string;
}

/**
 * claw2 configuration (steps 1 and 2).
 */
export interface Claw2Config {
  llm?: {
    provider: "openai" | "openrouter";
    model: string;
    apiKey?: string;
    baseURL?: string;
    enableThinking?: boolean;
    systemPromptMode?: "full" | "compact";
    maxTokens?: number;
  };
  /**
   * Persona / character of the assistant (friendly helper by default).
   * mdPath → markdown with ## full / ## compact (see prompts/assistant.md).
   * personaMarkdown → inline override (multi-user DB config).
   * Env override: CLAW2_ASSISTANT_MD.
   */
  assistant?: {
    mdPath?: string;
    /** Full assistant.md contents stored in user config (registration mode). */
    personaMarkdown?: string;
  };
  agentsDir?: string;
  /** Script names agents/*.js, hidden from the prompt and prohibited for run_agent (deactivation without deletion).*/
  disabledAgents?: string[];
  orchestrator?: {
    maxToolIterations?: number;
    codeRouting?: {
      /** Append skill-creation hint when user explicitly asks for a new agent/skill. Default true. */
      hintOnCodeTrigger?: boolean;
      /**
       * Retry when model dumps code instead of creating a skill (skill-create intent only).
       * Default false — enabling used to erase streamed chat examples (e.g. bubble sort).
       */
      retryIfCodeWithoutTool?: boolean;
    };
    /** Forcing generate_image when "draw/add to picture". Enabled by default.*/
    imageRouting?: {
      hintOnImageTrigger?: boolean;
      retryIfImageWithoutTool?: boolean;
      /** tool_choice=generate_image in the first step with intent. Defaults to true.*/
      forceToolChoice?: boolean;
    };
    /** cache_id of the selected activation cache (.claw-cache) or file path. Injected only on the first request in a session.*/
    activationCache?: string | null;
    /** Directory with .claw-cache files; with activationCache as cache_id, the file is searched as {cacheStorePath}/{cache_id}.claw-cache.*/
    cacheStorePath?: string | null;
    /** HSS chronicle in Chroma (persistence between sessions). If not specified, memory.chroma with the claw2_hss_chronicle collection is used. One sessionKey for multiple nodes = shared chronicle (swarm/hivemind).*/
    hssChronicleChroma?: {
      url?: string;
      collectionName?: string;
      /** Dimension of semantic embeddings (BGE-m3 = 1024). When changing, the collection is recreated.*/
      semanticEmbeddingDim?: number;
      /** TTL of records in days; old ones are deleted when loading the session and in the background. 0 = no cleaning.*/
      ttlDays?: number;
      /** Records with importance >= minImportanceToKeep are not deleted by TTL (important ones remain forever). 0..1, default 0.9.*/
      minImportanceToKeep?: number;
      /** Max. Chroma context text length (characters). Default is 2000.*/
      maxContextChars?: number;
    } | null;
    /** Semantic recall of chronicles in system prompt (like vector memory).*/
    hssChronicleRecall?: {
      /** Enable auto-mixing in prompt. Defaults to true when Chroma is configured.*/
      enabled?: boolean;
      /** How many records to mix. Default is 5.*/
      maxEntries?: number;
      /** Min. cosine similarity for inclusion in recall. Default is 0.2.*/
      minSimilarity?: number;
      /** importance >= threshold is always pinned. Default is 0.85.*/
      pinImportanceMin?: number;
      /** Max. pinned records per turn. Default is 3.*/
      maxPinnedEntries?: number;
      /** importance of auto-records evolve. Default is 0.35.*/
      defaultAutoImportance?: number;
      /** importance is the default for chronicle_remember. Default is 0.7.*/
      defaultModelImportance?: number;
      /** Base in score = sim × (base + scale × importance).*/
      importanceScoreBase?: number;
      importanceScoreScale?: number;
    } | null;
    /** HSS log file (evolution, chronicle, prompt hint). Empty - only the console.*/
    hssLogPath?: string | null;
    hssLogFormat?: "text" | "json";
    /**
     * Master switch for the dialog-stability layer (HSS): session-state
     * evolution, chronicle recall and the response-mode addendum.
     * Default true; set false to disable entirely (ablation / opt-out).
     */
    hss?: { enabled?: boolean };
    /** Entropy >= threshold → stabilize mode (legacy, see hssEntropyDeltaStabilizeMin).*/
    hssEntropyStabilizeMin?: number;
    /** Δ entropy >= threshold → stabilize mode. Default is 0.0015.*/
    hssEntropyDeltaStabilizeMin?: number;
    /** Chunk size for long input (symbols). Default is 400.*/
    hssContextChunkSize?: number;
    /** The input length above this threshold is divided into chunks. Default is 600.*/
    hssContextChunkMinLen?: number;
    /** One retry LLM for CRITICAL in middleware. Defaults to true.*/
    hssCriticalRetry?: boolean;
    /** Note at the end of the answer for FRAGMENTED/CRITICAL on ΔS. Default is false (do not show to user).*/
    hssEpistemicHint?: boolean;
    /** Field ontology hss.txt: P=N×E/D, C=ρ^d×Φ, semantic H, topological node.*/
    hssFieldOntology?: {
      /** Include full field model. Defaults to true.*/
      enabled?: boolean;
      /** The share of semantics in the Hamiltonian (0..1). Default is 0.55.*/
      hamiltonianMix?: number;
      /** Min. knotScore for topologicallyStable. Default is 0.55.*/
      knotStableMin?: number;
      /** Min. capacity C for a stable node. Default is 0.12.*/
      capacityMin?: number;
      /** Min. resonance with chronicle (at depth≥2). Default is 0.25.*/
      resonanceMin?: number;
      /** Base dim of matrix ρ. Default is 4.*/
      rhoDimBase?: number;
      /** Average dim for C ≥ capacityThresholdMid. Default is 8.*/
      rhoDimMid?: number;
      /** Full dim for C ≥ capacityThresholdFull. Default is 11.*/
      rhoDimFull?: number;
      /** Threshold C for transition 4→8. Default is 0.18.*/
      capacityThresholdMid?: number;
      /** Threshold C for transition →11. Default is 0.35.*/
      capacityThresholdFull?: number;
    } | null;
  };
  sandbox?: {
    image: string;
    timeoutMs?: number;
    /** Running agents on the host (node ​​with permissions) instead of Docker. Default is false. When deploying claw2 to Docker, set it to true, otherwise run_agent will give spawn docker ENOENT.*/
    useDocker?: boolean;
    elevatedAllowed?: boolean;
    /** Docker-sandbox hardening: memory cap per skill run (default "512m"). */
    dockerMemory?: string;
    /** Docker-sandbox hardening: process count cap per skill run (default 64). */
    dockerPidsLimit?: number;
    /**
     * Outbound network control for skills.
     * guard (default): all skill fetch/http/https goes through the gateway's
     * egress guard proxy with the same SSRF rules as web_fetch; loopback,
     * private, link-local and metadata destinations are blocked and audited.
     * Soft tier (host sandbox / in-container): standard HTTP stacks are
     * covered; raw node:net/node:tls sockets are a documented gap.
     * Hard tier (sandbox.useDocker: true): the skill container additionally
     * runs on a docker --internal network — the guard proxy is the only
     * host-reachable egress point, kernel-enforced.
     * off: no egress control (not recommended).
     */
    egress?: {
      mode?: "guard" | "off";
      allowPrivateHosts?: boolean;
    };
    /**
     * Optional expansion of host FS for agents when useDocker is false.
     * Default (omit / mode default): read agents/ (+ uploads), write agents/output only.
     * allowlist: those defaults plus read[] / write[] paths.
     * full: --allow-fs-read=* and --allow-fs-write=* (still no child_process).
     */
    hostFs?: {
      mode?: "default" | "allowlist" | "full";
      /** Extra read paths (absolute, relative, or ~/…). Ignored when mode is full. */
      read?: string[];
      /** Extra write paths. Ignored when mode is full. */
      write?: string[];
    };
  };
  memory?: {
    enabled?: boolean;
    backend?: "memory" | "chroma" | "sqlite";
    /** local = ONNX CPU; http = OpenAI-compatible / Ollama */
    embeddingProvider?: "local" | "http";
    embeddingModel?: string;
    embeddingBaseURL?: string;
    embeddingApiKey?: string;
    /** Expected embedding dimension (local default 384). Wipe vec tables on change. */
    embeddingDim?: number;
    /** Path to sqlite-vec DB file (default .claw2/data/memory.sqlite). */
    sqlitePath?: string;
    /** Cache dir for local ONNX models (default ~/.claw2/models). */
    embeddingCacheDir?: string;
    maxChunks?: number;
    maxRecallChunks?: number;
    chroma?: { url?: string; collectionName?: string };
  };
  /**
   * Dialogue Insights: offer links to past chats (ask-first by default).
   * See docs/plans/dialogue-insights.md.
   */
  insights?: {
    enabled?: boolean;
    /** off = never; ask = offer card; auto = show via cheap pass */
    mode?: "off" | "ask" | "auto";
    minScore?: number;
    maxCandidates?: number;
    /** Min seconds between offers on the same sessionId */
    cooldownSec?: number;
    /** Min age of last assistant reply for unresolved_thread */
    unresolvedMinAgeSec?: number;
    /** Soft deadline for linker on /chat (ms) */
    budgetMs?: number;
    useMemory?: boolean;
    useProjectDigests?: boolean;
    useUnresolvedThreads?: boolean;
    cheapPass?: {
      enabled?: boolean;
      maxTokens?: number;
    };
  };
  gateway?: {
    port?: number;
    /**
     * Bind address for HTTP gateway.
     * Desktop default: `127.0.0.1`. Omit / `0.0.0.0` for all interfaces (server deploy).
     * Env: `CLAW2_GATEWAY_BIND`.
     */
    bind?: string;
    maxHistoryTurns?: number;
    summarizeWhenMessagesAbove?: number;
    keepRecentMessages?: number;
    auth?: {
      enabled?: boolean;
      apiKey?: string;
      /** Enable logging mode: PostgreSQL accounting, JWT, route protection. Requires databaseUrl.*/
      registrationEnabled?: boolean;
      /** JWT signature secret (minimum 32 characters). When registrationEnabled is required.*/
      sessionSecret?: string;
    };
    /** PostgreSQL URL for accounting (users, user_config). When auth.registrationEnabled is required.*/
    databaseUrl?: string;
    /** Path to the SQLite file for chats (if specified, chats and history are stored in the database).*/
    chatsDbPath?: string;
    /** Tools transcript_search / transcript_read (chat transcript). Defaults to true for chatsDbPath.*/
    transcriptTools?: boolean;
    /**
     * Extra Host header values accepted when gateway.auth is off (the anti
     * cross-site / DNS-rebinding guard: IP literals, localhost and *.local are
     * always trusted). Example: [claw2.example.com].
     */
    trustedHosts?: string[];
  };
  /**
   * SIP client for virtual PBX (REGISTER + calls).
   * The phone_call tool is available when enabled + server + user + password.
   */
  sip?: {
    enabled?: boolean;
    /** SIP server host/proxy PBX (for example sip.domain.ru or IP)*/
    server?: string;
    /** SIP port on the PBX side (usually 5060)*/
    port?: number;
    /** SIP domain / realm (often the same as server)*/
    domain?: string;
    /** PBX subscriber login*/
    user?: string;
    /** SIP password*/
    password?: string;
    /** Display name in From*/
    displayName?: string;
    /** Local UDP port SIP UA (default 5061)*/
    localPort?: number;
    /**
     * Public/external IP or hostname for Contact (NAT).
     * If empty, the first non-loopback IPv4 is taken.
     */
    publicAddress?: string;
    /** REGISTER interval, seconds (default 300)*/
    registerExpires?: number;
    /** Auto answer to incoming messages (otherwise answer via phone_call)*/
    autoAnswer?: boolean;
    /** SIP URI of the operator for transfer (phone_call transfer)*/
    operatorUri?: string;
    /**
     * Speech-to-speech Realtime on the line (separate from batch voice STT/TTS).
     * provider off|pipeline — old path listen/say; keys are not mixed with llm.apiKey
     * without explicit useLlmApiKey.
     */
    realtime?: SipRealtimeConfig;
    /**
     * RTP media path: Node (@vexyl.ai/sip) or optional native sidecar.
     * auto — sidecar if binary found, else node (no error).
     * Default: auto.
     */
    mediaBackend?: SipMediaBackendMode;
    /**
     * Explicit path to sidecar runner binary (so/dll/dylib companion process).
     * Path to native sidecar binary or run-sidecar.sh.
     * Env: CLAW2_SIP_SIDECAR_PATH. Default probe: ~/.claw2/sip-media-sidecar/…
     */
    sidecarPath?: string;
  };
  /** Voice service (STT/TTS): local voice service or OpenAI-compatible audio API*/
  voice?: {
    /** silent | xtts | moss - sent to POST /tts of the local voice service (if ttsLocal)*/
    ttsEngine?: "silero" | "xtts" | "moss";
    /**
     * URL STT: for sttLocal - full endpoint (/stt);
     * otherwise - OpenAI-compatible base (.../v1) for /audio/transcriptions.
     */
    sttUrl?: string;
    sttModel?: string;
    sttApiKey?: string;
    /** true = local voice service; false = OpenAI-compatible.*/
    sttLocal?: boolean;
    /**
     * TTS URL: for ttsLocal - full endpoint (/tts);
     * otherwise - OpenAI-compatible base (.../v1) for /audio/speech.
     */
    ttsUrl?: string;
    ttsModel?: string;
    ttsApiKey?: string;
    /** true = local voice service; false = OpenAI-compatible.*/
    ttsLocal?: boolean;
    /** TTS voice (OpenAI-compatible `voice` or local engine speaker).*/
    ttsVoice?: string;
  };
  /** Recognition by camera (biometric identification): receiving recognizedUser with a request, memory by ID, superuser*/
  vision?: {
    /** Enable mode: client can pass recognizedUser, orchestrator and memory respect ID*/
    enabled?: boolean;
    /** ID with superuser rights (full access, including to the memory of all users)*/
    superuserIds?: string[];
    /** URL of the facial recognition service (POST image → JSON { userId }). If set, the browser sends the frame here instead of the local face-api*/
    recognizeUrl?: string;
    /**
     * Shared HMAC secret with the recognition service. A client-sent
     * recognizedUser is trusted only together with a signature
     * (HMAC-SHA256 of `${userId}:${ts}`, fields recognizedTs/recognizedSig)
     * that verifies against this secret and is fresh (±30 s). Without the
     * secret — or with a bad/stale signature — the claim is rejected
     * outright: no memory binding, no superuser. Telegram/VK identity is
     * server-side and unaffected.
     */
    recognizeSecret?: string;
  };
  /** Input channels (stage 2): Telegram, VK, etc.*/
  channels?: {
    telegram?: {
      enabled?: boolean;
      botToken?: string;
      /**
       * Bot API Telegram only (api.telegram.org). The rest of claw2 traffic is direct.
       * Example: socks5h://127.0.0.1:20170 (v2rayA) or socks5://127.0.0.1:1081 (ssh -D).
       */
      proxyUrl?: string;
      /** Your own Bot API server; default https://api.telegram.org*/
      apiBaseUrl?: string;
      /** Host ID (Telegram user id). If set, allowlist is enabled: only the owner and those approved by invitation.*/
      ownerId?: number;
      /** Path to SQLite for admission list and invitations. Default - ./data/telegram_allowlist.sqlite*/
      allowlistDbPath?: string;
      /**
       * Channel user IDs whose messages count as trusted operator speech:
       * not wrapped in external-content markers, not tainting the session
       * provenance ledger. Default: none — every channel message is
       * untrusted-origin content (hard by default).
       */
      trustedUserIds?: number[];
      /** Voice: STT/TTS via separate voice service*/
      voice?: {
        /** URL STT (POST multipart file → JSON { text }) */
        sttUrl?: string;
        /** URL TTS (POST JSON { text } → audio/wav) */
        ttsUrl?: string;
        /** Reply with voice in addition to text*/
        replyWithVoice?: boolean;
        /** Max. characters of text for one TTS request*/
        ttsMaxChars?: number;
      };
    };
    /** VK: community bot (like Telegram). Users write to the community in PM - the model responds.*/
    vk?: {
      enabled?: boolean;
      /** Community access key (with message rights) or env:VK_ACCESS_TOKEN*/
      accessToken?: string;
      /** Community ID (positive number) or env:VK_GROUP_ID*/
      groupId?: number;
      /**
       * Community member IDs whose DMs count as trusted operator speech
       * (see telegram.trustedUserIds). Default: none — every community
       * message is untrusted-origin content.
       */
      trustedUserIds?: number[];
      /** Voice: STT/TTS via separate voice service (similar to Telegram)*/
      voice?: {
        sttUrl?: string;
        ttsUrl?: string;
        replyWithVoice?: boolean;
        ttsMaxChars?: number;
      };
    };
  };
  scheduler?: { enabled?: boolean };
  /** LLM common room + user (llm-bridge service). One conversationId for all participants.*/
  llmBridge?: {
    enabled?: boolean;
    url?: string;
    /** ID of this LLM participant in the room*/
    agentId?: string;
    /** Common room ID (same for all instances and in the UI)*/
    conversationId?: string;
    /** Signature of this agent in chat*/
    displayName?: string;
    /** Signatures of participants: alpha → “Alpha”*/
    participantLabels?: Record<string, string>;
    token?: string;
    /** Reply to new messages in the room (not from this agentId)*/
    autoReply?: boolean;
    /**
     * all — reply to any other person’s message (default);
     * mention - person: only @agentId/@displayName; other LLM: @ or calling by name (Alpha, beta...).
     */
    autoReplyMode?: "all" | "mention";
    pollIntervalMs?: number;
    /** @deprecated use conversationId + participantLabels*/
    peerId?: string;
    sessionId?: string;
    peerLabel?: string;
  };
  uploads?: { hostPath?: string; sandboxPath?: string };
  workspace?: string;
  allowlist?: { paths?: string[] };
  /**
   * Non-empty allowlist fences run_agent to exactly these files: the model can
   * still draft new skills, but they will not execute until listed here.
   * Empty/unset — self-extension is open (default).
   */
  skills?: { allowlist?: string[] };
  tools?: {
    /**
     * Selecting a backend for tool search (the model sees one search()).
     * auto - tavily (if key), then searxng (if url), then other (if url); otherwise explicit provider.
     */
    search?: {
      provider?: "auto" | "tavily" | "searxng" | "other";
      /**
       * Address-bar search in embedded browser: when true, run a chat turn (LLM + search tool).
       * When false (default), call toolSearch directly and show hits in the browser chat overlay.
       */
      useLlmInWeb?: boolean;
      /**
       * Public SERP engines for desktop headless search (urlTemplate must contain {query}).
       * Defaults: yandex, google, ddg. Custom engines can be added in settings.
       */
      browserEngines?: Array<{
        id: string;
        name: string;
        urlTemplate: string;
        enabled?: boolean;
      }>;
    };
    /** Tavily Search API. */
    tavily?: { apiKey?: string; enabled?: boolean; searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast" };
    /**
     * Self-hosted / remote SearXNG (JSON API).
     * url - base (http://127.0.0.1:8080) or endpoint .../search.
     * apiKey - optional Bearer / X-Api-Key (any SearXNG-compatible endpoint).
     */
    searxng?: { url?: string; apiKey?: string; enabled?: boolean };
    /**
     * Custom SearXNG-compatible search endpoint (same GET /search?q=&format=json protocol).
     * Use when you want a separate URL from tools.searxng (e.g. own instance + public default).
     */
    other?: { url?: string; apiKey?: string; enabled?: boolean };
    /**
     * Base URL of the image generation service.
     * txt2img: claw2 sd/ or A1111 wrapper (POST {base}/txt2img → PNG).
     * openai: Ollama / OpenAI Images (POST {base}/v1/images/generations).
     */
    sdUrl?: string;
    /** Enable image generation tool (generate_image). Defaults to true when sdUrl is specified.*/
    sdEnabled?: boolean;
    /** Model name (Ollama/OpenAI Images), e.g. x/z-image-turbo*/
    sdModel?: string;
    /** API key for OpenAI-compatible image API (Ollama usually accepts any, e.g. ollama)*/
    sdApiKey?: string;
    /**
     * Protocol: txt2img (local SD service) | openai (Ollama/DALL·E-compatible).
     * Defaults to auto: openai if sdModel is given or URL is similar to Ollama/v1.
     */
    sdApi?: "auto" | "txt2img" | "openai";
    /**
     * webFetch: by default destinations that resolve to loopback/private/
     * link-local addresses are refused (SSRF guard). Set allowPrivateHosts
     * to fetch your LAN services (Home Assistant, router UI, and the like).
     */
    webFetch?: {
      timeoutMs?: number;
      maxBodyBytes?: number;
      maxContextChars?: number;
      allowPrivateHosts?: boolean;
    };
    message?: { allowedWebhooks?: string[]; policy?: "allow_one" | "require_confirmation" | "deny_bulk" };
  };
  audit?: { logPath?: string; logFormat?: "text" | "json" };
  security?: { lethalTrifecta?: { enabled?: boolean; action?: "warn" | "block" } };
  secrets?: { allowlist?: string[]; requireConfirmation?: boolean };
  tasks?: { dbPath?: string };
  /**
   * Parent/subagent skill authoring (no nested recursion).
   * maxSubagents = parallel candidates per code_skill call (default 3, min 1).
   */
  coding?: {
    /** How many candidate implementations to generate in parallel (default 3, minimum 1). */
    maxSubagents?: number;
    /** Optional default argv for post-write smoke run_agent. */
    smokeArgs?: string[];
  };
  /** Legacy skill evolution — postponed; kept for older configs / server. Prefer coding.*. */
  agentSelection?: {
    enabled?: boolean;
    dbPath?: string;
    runsPerVersion?: number;
    maxVersionsPerTask?: number;
    codingModel?: { model: string; baseURL?: string; apiKey?: string };
  };
  /**
   * Remote access for PWA (iOS requires HTTPS).
   * DuckDNS + Let's Encrypt DNS-01. Listening to the HTTPS port is separate.
   */
  remoteAccess?: {
    /**
     * The secret for PWA over public HTTPS.
     * Without it, the remote HTTPS API rejects requests (the local Electron is not affected).
     */
    accessToken?: string;
    ddns?: {
      /** Now only duckdns.*/
      provider?: "duckdns";
      enabled?: boolean;
      /** myhome or myhome.duckdns.org*/
      domain?: string;
      /** Token from duckdns.org*/
      token?: string;
      /** IP update interval, minutes (min. 5). Default is 30.*/
      updateIntervalMinutes?: number;
    };
    tls?: {
      /** Prepare/renew LE certificate (DNS-01).*/
      enabled?: boolean;
      /** Email for your Let's Encrypt account (recommended).*/
      email?: string;
      /** Staging LE (test certificates).*/
      staging?: boolean;
      /** Pause after TXT before checking LE, ms (default 90000).*/
      dnsPropagationMs?: number;
      /**
       * Open an HTTPS port (reverse-proxy to the local gateway).
       * By default, when enabled, the port is immediately listened to; You can close/open from the tray.
       */
      listenEnabled?: boolean;
      /** HTTPS port (default 443). On macOS/Linux 443 may require rights - then 8443.*/
      listenPort?: number;
      /**
       * When minimized to tray, automatically open the port (if DDNS is configured).
       * Defaults to false - explicit permission only.
       */
      openOnTrayHide?: boolean;
      /**
       * Port forwarding via UPnP/IGD on the router (true by default).
       * You need to have UPnP enabled on your router. It won't help with CGNAT.
       */
      upnp?: boolean;
    };
  };
  /**
   * XZDR-style PII masking before cloud LLM (in-process).
   * See src/privacy/ — mask outbound messages, unmask responses; custom rules in cabinet.
   */
  privacy?: PrivacyConfig;
}

export const DEFAULT_CONFIG: Partial<Claw2Config> = {
  llm: { provider: "openai", model: "gpt-4o-mini" },
  sandbox: { image: "node:20-alpine", timeoutMs: 60_000 },
};
