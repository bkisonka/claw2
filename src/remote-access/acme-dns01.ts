/**
 * Let's Encrypt DNS-01 via DuckDNS (without opening port 80).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import acme from "acme-client";
import { clearDuckDnsTxt, normalizeDuckDnsDomain, setDuckDnsTxt } from "./duckdns.js";
import { certPaths, ensureRemoteAccessDirs } from "./paths.js";
import { writeRemoteAccessStatus } from "./status.js";

export interface IssueCertOptions {
  domain: string;
  token: string;
  email?: string;
  /** Staging LE - for debugging.*/
  staging?: boolean;
  /** Pause after setting TXT before checking LE (ms).*/
  propagationMs?: number;
}

export interface IssueCertResult {
  ok: true;
  fqdn: string;
  fullchainPath: string;
  privkeyPath: string;
  expiresAt?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadOrCreateAccountKey(path: string): Promise<Buffer> {
  if (existsSync(path)) {
    return readFileSync(path);
  }
  const key = await acme.crypto.createPrivateKey();
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

function parseCertExpiry(pem: string): number | undefined {
  try {
    // node-forge not available; use openssl via acme-client info if possible
    const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (!match) return undefined;
    // Fallback: store issuedAt + 90d if parse fails later
    return undefined;
  } catch {
    return undefined;
  }
}

export async function issueLetsEncryptDns01(opts: IssueCertOptions): Promise<IssueCertResult> {
  const { fqdn } = normalizeDuckDnsDomain(opts.domain);
  const token = opts.token.trim();
  if (!token) throw new Error("DuckDNS token is empty");

  ensureRemoteAccessDirs(fqdn);
  const paths = certPaths(fqdn);
  const accountKey = await loadOrCreateAccountKey(paths.accountKey);

  const directoryUrl = opts.staging
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  const client = new acme.Client({
    directoryUrl,
    accountKey,
  });

  const [privKey, csr] = await acme.crypto.createCsr({
    commonName: fqdn,
    altNames: [fqdn],
  });

  const propagationMs = Math.max(30_000, opts.propagationMs ?? 90_000);

  try {
    const cert = await client.auto({
      csr,
      email: opts.email?.trim() || undefined,
      termsOfServiceAgreed: true,
      challengePriority: ["dns-01"],
      skipChallengeVerification: false,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type !== "dns-01") {
          throw new Error(`Unsupported challenge: ${challenge.type}`);
        }
        const set = await setDuckDnsTxt({ domain: fqdn, token, txt: keyAuthorization });
        if (!set.ok) {
          throw new Error(`DuckDNS TXT update failed: ${set.raw}`);
        }
        await sleep(propagationMs);
      },
      challengeRemoveFn: async () => {
        try {
          await clearDuckDnsTxt({ domain: fqdn, token });
        } catch {
          /* ignore cleanup errors */
        }
      },
    });

    writeFileSync(paths.privkey, privKey, { mode: 0o600 });
    writeFileSync(paths.fullchain, cert, { mode: 0o644 });

    const issuedAt = Date.now();
    // LE certs ~90 days; store hint until we parse PEM expiry
    const expiresAt = parseCertExpiry(cert) ?? issuedAt + 90 * 24 * 60 * 60 * 1000;
    writeFileSync(
      paths.meta,
      JSON.stringify(
        {
          fqdn,
          issuedAt,
          expiresAt,
          staging: !!opts.staging,
          email: opts.email?.trim() || null,
        },
        null,
        2
      ),
      "utf-8"
    );

    writeRemoteAccessStatus({
      cert: {
        lastOkAt: issuedAt,
        lastError: undefined,
        lastErrorAt: undefined,
        fqdn,
        expiresAt,
        staging: !!opts.staging,
        issuer: opts.staging ? "letsencrypt-staging" : "letsencrypt",
      },
    });

    return {
      ok: true,
      fqdn,
      fullchainPath: paths.fullchain,
      privkeyPath: paths.privkey,
      expiresAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeRemoteAccessStatus({
      cert: {
        lastErrorAt: Date.now(),
        lastError: message,
        fqdn,
        staging: !!opts.staging,
      },
    });
    try {
      await clearDuckDnsTxt({ domain: fqdn, token });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function readCertMeta(fqdnInput: string): {
  fqdn: string;
  issuedAt?: number;
  expiresAt?: number;
  staging?: boolean;
  fullchainPath: string;
  privkeyPath: string;
  hasCert: boolean;
} | null {
  try {
    const { fqdn } = normalizeDuckDnsDomain(fqdnInput);
    const paths = certPaths(fqdn);
    const hasCert = existsSync(paths.fullchain) && existsSync(paths.privkey);
    let meta: { issuedAt?: number; expiresAt?: number; staging?: boolean } = {};
    if (existsSync(paths.meta)) {
      meta = JSON.parse(readFileSync(paths.meta, "utf-8")) as typeof meta;
    }
    return {
      fqdn,
      issuedAt: meta.issuedAt,
      expiresAt: meta.expiresAt,
      staging: meta.staging,
      fullchainPath: paths.fullchain,
      privkeyPath: paths.privkey,
      hasCert,
    };
  } catch {
    return null;
  }
}
