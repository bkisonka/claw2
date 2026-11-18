/**
 * Run: npx tsx src/remote-access/duckdns.test.ts
 */
import assert from "node:assert/strict";
import { normalizeDuckDnsDomain } from "./duckdns.js";

{
  const r = normalizeDuckDnsDomain("MyHome");
  assert.deepEqual(r, { subdomain: "myhome", fqdn: "myhome.duckdns.org" });
}

{
  const r = normalizeDuckDnsDomain("myhome.duckdns.org");
  assert.deepEqual(r, { subdomain: "myhome", fqdn: "myhome.duckdns.org" });
}

assert.throws(() => normalizeDuckDnsDomain("  "), /empty/i);
assert.throws(() => normalizeDuckDnsDomain("bad_name"), /Invalid/);

console.log("duckdns.test.ts: ok");
