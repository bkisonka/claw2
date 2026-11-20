# HSS core — LGPL-3.0-or-later

The entire **HSS core** (Hyper-Semantic Structure / Гиперсемантическая Структура) is licensed under the **GNU Lesser General Public License version 3 or later**.

SPDX-License-Identifier: `LGPL-3.0-or-later`

Full text: https://www.gnu.org/licenses/lgpl-3.0.html  
(Also references GPL v3: https://www.gnu.org/licenses/gpl-3.0.html)

## Scope

| Path | Role |
|------|------|
| [`hss.cjs`](hss.cjs) | Math core (ρ, evolve, ContextEncoder) |
| [`src/core/hss-middleware.ts`](src/core/hss-middleware.ts) | Orchestrator middleware |
| [`src/claw-cache/hss-*.ts`](src/claw-cache/) | Stabilizer, field ontology, LCP, chaos, prompts, hints, encoder, path, log, tests |

Files under `src/claw-cache/`:

- `hss-stabilizer.ts`
- `hss-field-ontology.ts`
- `hss-context-encoder.ts`
- `hss-path.ts`
- `hss-chaos.ts`
- `hss-lcp.ts`
- `hss-log.ts`
- `hss-rho-dimension.ts`
- `hss-response-strategy.ts`
- `hss-orchestrator-prompt.ts`
- `hss-epistemic-hint.ts`
- `hss-pending-hint.ts`
- `hss-expm.test.ts`
- `hss-response-strategy.test.ts`

Related formula/ontology docs: `docs/hss-*.md`.

## Out of scope

Not HSS core (may use the product license): the rest of `src/`, `web/`, `pwa/`, `desktop/`, `agents/`, pack/cache UI (`CachePacker`, warmup catalog, etc.), except the `hss-*` files listed above.

## Packaging / interaction with claw2

The rest of claw2 is **GPL-2.0** (see [`LICENSE`](LICENSE) and [`LICENSING.md`](LICENSING.md)). HSS remains a **separate LGPL module**: keep `hss.cjs` replaceable under `claw2-runtime/`; do not strip LGPL notices.

- Ship `LICENSE` + `LICENSE-HSS.md` with binaries.
- Do not relicense HSS under GPL-2.0 without a separate grant.
- Modifications to HSS core must stay under LGPL-3.0-or-later (or GPL as allowed by LGPL).
