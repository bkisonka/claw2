# Security Policy

claw2 is a self-hosted personal agent that runs with broad access to your
files, your model provider account and — through skills — the network.
Security reports are taken seriously and are the fastest way to get a fix.

## Supported versions

Only the latest commit on `main` receives security fixes. There are no
maintenance branches; update by pulling and rebuilding the container.

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting**:
open the repository → *Security* tab → *Report a vulnerability*.

Please do not open a public issue for a security problem.

Include what is practical:

- A description of the issue and its impact;
- Steps to reproduce (config snippet, request, or skill source);
- The commit you tested against;
- Whether the issue requires a non-default configuration.

## What to expect

- Acknowledgement within a few days;
- A fix or a mitigation plan for accepted reports;
- Public disclosure after the fix ships — credit to the reporter by default.

## Scope notes

Reports are most useful in these areas:

- The skill sandbox (`src/sandbox/run-agent.ts`): sandbox escapes, path
  traversal, permission bypass;
- Gateway authentication and the cross-site/Host guard (`src/gateway/`);
- SSRF protections on outbound fetch (`src/security/public-fetch.ts`,
  `src/security/url-guard.ts`);
- Prompt-injection containment: external-content boundaries and the lethal
  trifecta check (`src/security/content-boundary.ts`,
  `src/security/lethal-trifecta.ts`);
- The skill allowlist and `/allow` confirmation flow.

Known limitations that are **not** vulnerabilities (documented behavior):

- Skills executed on the host (sandbox.useDocker: false) are restricted by
  Node's permission model (filesystem, child processes), and their standard
  HTTP stacks are routed through the egress guard proxy. This soft tier is
  best-effort: the guard patches live in the same process as the skill, so
  a deliberately hostile skill can bypass them (raw TLS over `node:net`,
  reassigning patched globals). Kernel-level isolation — a sandbox network
  with no external route — is the Docker sandbox tier, which the compose
  delivery enables by default. Keep gateway authentication on.
- Threats that require the operator to run attacker-chosen configuration are
  out of scope: the operator owns the config file.
