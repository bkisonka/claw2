import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getClaw2StateDir } from "../config/state-dir.js";

export function getRemoteAccessDir(): string {
  return resolve(getClaw2StateDir(), "remote-access");
}

export function getCertDir(fqdn: string): string {
  const safe = fqdn.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return resolve(getRemoteAccessDir(), "certs", safe);
}

export function ensureRemoteAccessDirs(fqdn?: string): void {
  mkdirSync(getRemoteAccessDir(), { recursive: true });
  if (fqdn) mkdirSync(getCertDir(fqdn), { recursive: true });
}

export function certPaths(fqdn: string): {
  dir: string;
  privkey: string;
  fullchain: string;
  accountKey: string;
  meta: string;
} {
  const dir = getCertDir(fqdn);
  return {
    dir,
    privkey: resolve(dir, "privkey.pem"),
    fullchain: resolve(dir, "fullchain.pem"),
    accountKey: resolve(dir, "account.key"),
    meta: resolve(dir, "meta.json"),
  };
}

export function statusPath(): string {
  return resolve(getRemoteAccessDir(), "status.json");
}
