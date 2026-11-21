# HSS core — LGPL-3.0-or-later

The file [`hss.cjs`](hss.cjs) — the HSS core, the dialog-stability state
model (density-matrix coherence node, intention vector, chronicle) — is
licensed under the **GNU Lesser General Public License version 3 or
later**.

SPDX-License-Identifier: `LGPL-3.0-or-later`

## License texts

- LGPL-3.0: [`COPYING.LESSER`](COPYING.LESSER) (also
  https://www.gnu.org/licenses/lgpl-3.0.html)
- GPL-3.0, which LGPL-3.0 references:
  [`COPYING`](COPYING) (also https://www.gnu.org/licenses/gpl-3.0.html)

## Scope

LGPL-3.0 applies to **exactly one file**: `hss.cjs`. It may be studied,
modified and redistributed on LGPL-3.0 terms; modified versions of it must
in turn remain under LGPL-3.0-or-later.

Everything else in the repository is free software under
**GNU AGPL-3.0-or-later** ([`LICENSE`](LICENSE)), including the TypeScript
layer that uses the core (`src/claw-cache/hss-*.ts`, `src/core/hss-middleware.ts`
and the rest of `src/`). Those files are not derivatives of the LGPL library:
they exercise it through its public API, which LGPL-3.0 section 4 (Combined
Works) explicitly permits. They carry no LGPL obligations and impose none.

## Interaction with claw2

- `hss.cjs` is loaded through its public API only (`module.exports`);
  nothing in the product reaches into its internals. It stays a
  replaceable component: swapping the file for a compatible LGPL-3.0
  implementation keeps the rest of claw2 working.
- Keep the LGPL notice inside `hss.cjs` and this file with any
  redistribution of the core.
- Modifications to `hss.cjs` must stay under LGPL-3.0-or-later (or GPL-3.0,
  as LGPL-3.0 permits). Contributions to this file are accepted under
  LGPL-3.0 so improvements to the core come back to the project.
- The rest of claw2 — including its own configuration files, build scripts
  and documentation — is licensed under GNU AGPL-3.0-or-later; see
  [`LICENSE`](LICENSE). LGPL-3.0 and AGPL-3.0 are compatible: claw2 as a
  combined work is conveyed under AGPL-3.0-or-later, while `hss.cjs` itself
  remains available on LGPL-3.0-or-later terms.
