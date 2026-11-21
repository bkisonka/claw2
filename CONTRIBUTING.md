# Contributing to claw2

Thank you for considering a contribution — issues, bug reports, documentation
improvements and pull requests are all welcome.

## License of contributions

All code in this repository is distributed under **AGPL-3.0-only**. The HSS
core (`hss.cjs`) is under **LGPL-3.0-only** — see [LICENSE-HSS.md](LICENSE-HSS.md);
if your PR touches the core's files, they remain under LGPL.

By accepting your pull request, the project copyright holder will distribute
your code under AGPL-3.0 — as part of claw2.

### Why a CLA is required

claw2 is developed under a dual-license model: the open code under AGPL,
plus separate commercial licenses for those to whom AGPL does not fit. For
the commercial versions to be legally clean, the project copyright holder
needs to own the copyright to the entire product — including your changes.

A CLA (Contributor License Agreement) is a one-page agreement in which you
assign the copyright in your contribution to the project. In exchange, you
lose nothing: your code stays open, you may keep using it yourself, and your
name remains in the commit history.

### How to sign

1. Open [cla/CLA-individual.md](cla/CLA-individual.md) and fill in the fields
   (name, e-mail, date).
2. Submit the file as a PR to the `cla-signatures` branch (one signature —
   one commit; it applies to all your future contributions).
3. Link your signature in the description of every pull request. PRs without
   a signed CLA are not accepted — this is not bureaucracy, it is the
   condition that makes the dual license possible.

If you contribute work code on behalf of a company, use
[cla/CLA-corporate.md](cla/CLA-corporate.md) instead (it includes the list of
employees authorized to send PRs).

### Prefer not to assign rights?

That is perfectly fine. Send an idea, a bug report, a test, or a precise
patch in an issue — the maintainer will apply the solution themselves, and
your authorship will be preserved in the commit message. Nothing valuable is
lost.

## Pull requests

- Keep pull requests focused: one logical change per PR.
- New runtime behavior should come with tests (`npm test` in the repository
  root; `npm test` inside `pwa/` for the mobile client).
- Build the project before submitting: `npm run build` (server and web
  client), `npm run build:pwa` if you touched the mobile web client.
- New source files carry an SPDX header
  (`SPDX-License-Identifier: AGPL-3.0-only`), matching existing files.

## Reporting issues

Please include: what you did, what you expected, what happened, and your
deployment context (Docker or bare Node.js, OS, model provider). For
security-sensitive reports, see [SECURITY.md](SECURITY.md) — please do not
open public issues for vulnerabilities.

## Communication

Reach the maintainer through the repository — issues and pull requests are
the primary channels.
