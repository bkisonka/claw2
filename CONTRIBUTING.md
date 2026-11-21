# Contributing to claw2

Thank you for considering a contribution — issues, bug reports, documentation
improvements and pull requests are all welcome.

## License of contributions

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in claw2 by you is licensed under the project
license, **GNU AGPL-3.0-or-later**, without any additional terms or
conditions. **No CLA is required**: by opening a pull request you grant the
project the right to distribute your contribution under AGPL-3.0-or-later;
you keep the copyright to your code.

Contributions to the HSS core (`hss.cjs`) are accepted under
**LGPL-3.0-or-later** — see [LICENSE-HSS.md](LICENSE-HSS.md). Improvements
to the core are expected to come back to the project under the same license.

## Pull requests

- Keep pull requests focused: one logical change per PR.
- New runtime behavior should come with tests (`npm test` in the repository
  root; `npm test` inside `pwa/` for the mobile client).
- Build the project before submitting: `npm run build` (server and web
  client), `npm run build:pwa` if you touched the mobile web client.
- New source files carry an SPDX header
  (`SPDX-License-Identifier: AGPL-3.0-or-later`), matching existing files.

## Reporting issues

Please include: what you did, what you expected, what happened, and your
deployment context (Docker or bare Node.js, OS, model provider). For
security-sensitive reports, see [SECURITY.md](SECURITY.md) — please do not
open public issues for vulnerabilities.

## Communication

Reach the maintainer through the repository — issues and pull requests are
the primary channels.
