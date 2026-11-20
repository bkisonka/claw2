/**
 * Run: npx tsx src/gateway/connections-status.test.ts
 *
 * The Connections panel error contract: checkLlm returns structured codes
 * (conn:llm:<code>[:<arg>]) that the UI renders as localized human text —
 * base case "LLM не подключена", specific ones when the failure is more
 * specific (wrong key, wrong path, server error, nothing listening).
 *
 * Live checks against a real HTTP server (404/500 branches) and a dead
 * port (network branch), plus the parser contract.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { collectConnectionsStatus, parseConnectionErrorCode } from "./connections-status.js";
import type { Claw2Config } from "../config/types.js";

function llmConfig(baseURL: string): Claw2Config {
  return {
    llm: { provider: "openai", model: "test-model", baseURL, apiKey: "k" },
    memory: { enabled: false },
  } as unknown as Claw2Config;
}

async function llmConnection(baseURL: string): Promise<{ status: string; error?: string }> {
  const d = await collectConnectionsStatus(llmConfig(baseURL));
  const c = d.connections.find((x) => x.id === "llm")!;
  return { status: c.status, error: c.error };
}

async function listen(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
      }),
  };
}

async function main() {
  // 1. Parser contract.
  {
    const p = parseConnectionErrorCode("conn:llm:no_listener:127.0.0.1:9");
    assert.ok(p && p.id === "llm" && p.code === "no_listener" && p.arg === "127.0.0.1:9");
    assert.equal(parseConnectionErrorCode("conn:llm:timeout")?.code, "timeout");
    assert.equal(parseConnectionErrorCode("LLM is not connected"), null);
    assert.equal(parseConnectionErrorCode(undefined), null);
  }

  // 2. Server responds 404 → wrong Base URL path.
  {
    const { port, close } = await listen((_req, res) => {
      res.writeHead(404).end("nope");
    });
    const r = await llmConnection(`http://127.0.0.1:${port}/v1`);
    assert.equal(r.status, "error");
    assert.equal(r.error, "conn:llm:bad_path", `got: ${r.error}`);
    assert.equal(parseConnectionErrorCode(r.error)?.code, "bad_path");
    await close();
  }

  // 3. Server responds 401 → wrong API key.
  {
    const server = createServer((_req, res) => {
      res.writeHead(401).end(JSON.stringify({ error: "bad key" }));
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as { port: number }).port;
    const r = await llmConnection(`http://127.0.0.1:${port}/v1`);
    assert.equal(r.error, "conn:llm:bad_key", `got: ${r.error}`);
    server.close();
  }

  // 4. Server responds 500 → server_error with status arg.
  {
    const server = createServer((_req, res) => {
      res.writeHead(500).end("boom");
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as { port: number }).port;
    const r = await llmConnection(`http://127.0.0.1:${port}/v1`);
    assert.equal(r.error, "conn:llm:server_error:500", `got: ${r.error}`);
    server.close();
  }

  // 5. Dead port → nothing is listening on <target>.
  {
    const r = await llmConnection("http://127.0.0.1:9/v1"); // discard port — refused fast
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /^conn:llm:no_listener:127\.0\.0\.1:9$/, `got: ${r.error}`);
  }

  console.log("connections-status.test.ts: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
