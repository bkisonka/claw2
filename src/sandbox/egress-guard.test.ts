/**
 * Run: npx tsx src/sandbox/egress-guard.test.ts
 *
 * Live checks of the skill egress guard: the proxy passes targets through in
 * allowPrivateHosts mode, blocks loopback/private targets under the strict
 * guard (both the preload fetch path and the raw HTTP-proxy path), and the
 * bundled preload really routes a skill's fetch through the guard.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createEgressGuardProxy, resetEgressGuardProxyForTest } from "./egress-proxy.js";
import { ensureEgressPreload } from "./egress-preload-build.js";
import type { Claw2Config } from "../config/types.js";

const config = {} as Claw2Config;

async function listenTarget(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello-from-target");
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

/** Same async-spawn rule, for curl (absolute-URI proxy path). */
async function curlAsync(args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const proc = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c));
    proc.stderr?.on("data", (c: Buffer) => (err += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.once("close", () => {
      clearTimeout(timer);
      resolvePromise({ stdout: out, stderr: err });
    });
  });
}

/**
 * Run a script with the preload installed, pointed at the given guard.
 * ASYNC spawn on purpose: the guard and the target live in this process, and
 * a sync spawn would block the event loop they need to serve the child.
 */
async function skillFetch(
  preloadPath: string,
  guardPort: number,
  code: string,
  timeoutMs = 20_000
): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  return await new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, ["--require", preloadPath, "-e", code], {
      env: { ...process.env, CLAW2_EGRESS_PROXY: `http://127.0.0.1:${guardPort}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c));
    proc.stderr?.on("data", (c: Buffer) => (err += c));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.once("close", (code_, signal_) => {
      clearTimeout(timer);
      resolvePromise({ stdout: out, stderr: err, code: code_, signal: signal_ });
    });
  });
}

async function main() {
  const preload = ensureEgressPreload();
  assert.equal(preload.ok, true, `preload must build: ${!preload.ok ? preload.error : ""}`);
  const preloadPath = preload.ok ? preload.path : "";

  const target = await listenTarget();
  const fetchBody = `fetch(${JSON.stringify(target.url)}).then(r=>r.text()).then(t=>console.log("OK:"+t)).catch(e=>console.log("ERR:"+e.message))`;

  try {
    // 1. allowPrivateHosts guard: pass-through — the skill fetch succeeds.
    const open = createEgressGuardProxy({ config, allowPrivateHosts: true });
    const openPort = await open.listenOn("127.0.0.1");
    {
      const r = await skillFetch(preloadPath, openPort, fetchBody);
      assert.match(
        r.stdout,
        /OK:hello-from-target/,
        `allowPrivate pass-through failed: ${r.stdout} ${r.stderr}`
      );
    }
    await open.close();

    // 2. Strict guard: the same skill fetch is blocked, no target content.
    const strict = createEgressGuardProxy({ config, allowPrivateHosts: false });
    const strictPort = await strict.listenOn("127.0.0.1");
    {
      const r = await skillFetch(preloadPath, strictPort, fetchBody);
      const out = r.stdout + r.stderr;
      assert.doesNotMatch(
        out,
        /hello-from-target/,
        "blocked target content leaked through the strict guard"
      );
      assert.match(out, /ERR:/, `expected a fetch failure, got: ${out}`);
    }

    // 3. Raw HTTP-proxy path (curl -x, absolute-URI form): 403 with reason.
    {
      const r = await curlAsync([
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-x",
        `http://127.0.0.1:${strictPort}`,
        target.url,
      ]);
      assert.equal(r.stdout.trim(), "403", `curl through strict guard: ${r.stdout} ${r.stderr}`);
    }
    await strict.close();
  } finally {
    resetEgressGuardProxyForTest();
    target.server.close();
  }

  console.log("egress-guard.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
