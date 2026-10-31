# dsh-memory-hub

**[简体中文](README.md) | [English](README.en.md)**

![version](https://img.shields.io/badge/version-1.5.1-2f6feb)
![license](https://img.shields.io/badge/license-MIT-31c48d)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![tests](https://img.shields.io/badge/tests-682-0ea5e9)
![coverage](https://img.shields.io/badge/coverage-lines%E2%89%A598%25-16a34a)
![local-first](https://img.shields.io/badge/local--first-zero--cloud-orange)
![event-driven](https://img.shields.io/badge/event--driven-pure--incremental-7c3aed)

> **DeepSeek Harness Intelligent Session Memory Hub** — Make Harness understand you better over time.

`dsh-memory-hub` is a **local-first, event-driven** cross-session memory plugin for DeepSeek Harness (dsh). It automatically captures user preferences and tool-execution conclusions from conversations, and exposes 4 explicitly callable tools to agents. New sessions no longer start "from scratch".

- **Zero external services**: memories are stored only in local JSONL files — pure TypeScript, no third-party storage, no cloud dependency;
- **Event-driven automatic capture**: distills memories from the dsh event-sourcing layer (`session/event` pipeline) and the tool-execution pipeline (`tools/result`), with four configurable capture intensities;
- **Explicit agent tools**: `memory_store` / `memory_recall` / `memory_forget` / `memory_status` — the model reads and writes memory as needed;
- **Privacy & security by default**: API keys, passwords, JWTs, private keys, database connection strings and other sensitive patterns are always intercepted and never stored; capture only targets real user input, skipping plugin injections and subagent contexts.

> Why "an unclaimed niche": the official v0.2 release notes list "adding personalized long-term memory" as a future direction; existing community memory plugins are early-stage / unvalidated / dependent on external ecosystems. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full differentiation argument.

---

## System Overview

<div align="center">
  <img src="assets/architecture-overview.png" alt="dsh-memory-hub overall architecture: event capture layer → local memory layer (JSONL + index cache) → agent context and four tools" width="88%">
  <br/>
  <sub><b>Fig. 1</b> Overall architecture: dsh events & tool results → capture & filtration → append-only local memory store → four tools feed the agent context</sub>
</div>

## Table of Contents

- [Features at a glance](#features-at-a-glance)
- [Capture pipeline](#capture-pipeline)
- [Installation](#installation)
- [Configuration](#configuration)
- [Tool usage guide](#tool-usage-guide)
- [Recall quality design](#recall-quality-design)
- [Architecture highlights](#architecture-highlights)
- [Storage & consistency model](#storage--consistency-model)
- [Cognitive memory system](#cognitive-memory-system)
- [Development](#development)
- [Directory structure](#directory-structure)
- [Privacy & security](#privacy--security)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features at a glance

| Capability                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit memory                                   | `memory_store` persists decisions / facts / preferences / instructions with auto-tagging and idempotent ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Intelligent recall                                | `memory_recall`: Okapi BM25 + **edit-distance ≤1 fallback (A1)** + **stemming-like semantic fallback (A2)** + **value-aware weighting (A3)** + **heat half-life decay (A4)** + token-budget trimming + `kind` filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Automatic event capture                           | User messages → preferences/instructions; successful tool results → facts; four modes (`off` / `conservative` / `balanced` / `aggressive`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Real-data ingestion**                           | **Batch-imports Markdown memory files (AGENTS.md / MEMORY.md / USER.md…) and session JSONL logs at startup (0.6.0)**: content-level idempotent dedup, kind inference, sensitive filtering — "memory out of the box"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Forgetting & governance                           | `memory_forget` deletes by id; `memory_status` shows stats overview + runtime metrics + storage diagnostics; TTL batch expiry cleanup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Reliable local storage                            | append-only JSONL + tombstone logical deletes + atomic compact rebuild; **disk-before-memory writes**, zero residue on crash/write failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Observable operations                             | `HubMetrics` with 10 runtime counters (captured/rejected/recalled/forgotten/errors/dropped); bounded backpressure queue; graceful-shutdown summary logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Memory lifecycle (1.0.0)**                      | **supersede protocol (Module A1)**: detects "switch to / upgrade to" opposing signals, down-weights superseded memories + co-occurrence dedup; **topic clustering view (A2)**: `status` outputs aggregated topics; **value-aware eviction (A3)**: evicts by value when over the cap, instructions are never auto-evicted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Dual-engine hybrid retrieval (1.0.0)**          | **Lexical (BM25) + fuzzy (edit distance) + semantic (MinHash coverage) three-line scoring**, fused via `interpolate` linear blending or `rrf` Reciprocal Rank Fusion (k=60) (semantic line stacks when `semanticBoost` is enabled; default off = zero behavior change)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Memory cognition layer (1.1.0)**                | **Hierarchical distillation (Module A)**: recurring behavior/preference clusters → abstract principles, instruction clusters → procedural rules; `recall(expand)` unfolds the evidence chain on hit; **consolidation & forgetting curve (Module B)**: Ebbinghaus spaced-repetition strength model + idle consolidation scheduling; **temporal knowledge graph (Module C)**: zero-dependency triple extraction + a 4th recall line that rescues entries unreachable lexically but reachable via graph; **conflict coexistence (Module D)**: plausibly reversed facts coexist with explicit labels, newest-first, replayable correction timeline                                                                                                                                                                                                                                                         |
| **Inference uplift (1.2.0)**                      | **Spreading-activation inference line (Module E, `inferEnabled`)**: query entities diffuse along the temporal graph's _active_ out-edges (per-hop ×0.5 decay × relation confidence × oldest-edge conservative freshness), keeping the best-path chain per terminal entity (replayable `A—uses→B—depends→C`), asOf timeline hard constraints (inference never traverses invalidated relations, incl. revival semantics), beam/chain double bounds; **recall provenance (Module F, `explain`)**: every hit carries `why` — participating recall lines, per-line contributions and the common weight factor; under rrf, `Σ contributions × lineBase` equals the final score bit-exactly                                                                                                                                                                                                                   |
| **Spacetime completeness (1.3.0)**                | **Episodic replay (Module G, `asOf`)**: recall at any past moment — the append-only JSONL log is replayed in file order by the pure `replayAsOf` function into that moment's exact knowledge state (existence / content versions / supersede & conflict markers / access heat), with the graph rebuilt from the replayed corpus into a T-instant view (future entries' edges absent); read-only, heat untouched; **inference evidence chains (Module H, `why.chains`)**: provenance upgraded from “the infer line contributed score” to “on what reasoning” — hits fused via infer carry up to 3 replayable path chains                                                                                                                                                                                                                                                                                |
| **Defense-in-depth & temporal analytics (1.4.0)** | **Session-level encrypted storage (Module I, `passphrase` / `DSH_MEMORY_PASSPHRASE`)**: per-line AES-256-GCM authenticated encryption at rest (scrypt-derived key + key-record header storing the salt, AAD binding the format version) — at-rest confidentiality (zero plaintext beyond the header) + per-line tamper evidence (auth failures flow into the existing corrupt-line quarantine); wrong/missing passphrase fails fast at load (never masquerades as an empty store); plain-text stores migrate in place line-by-line, preserving full append-only replay history; compact coexists with encryption; **temporal analytics (Module J)**: `memory_status asOf` historical snapshot + `diffSince` T1↔T2 diff view (added/removed/content-changed/supersede/conflict/heat-only, deterministic pure function)                                                                                  |
| **Boundary breakthrough (1.5.0)**                 | **Passphrase rotation & decrypt-back (Module K, `DSH_MEMORY_NEW_PASSPHRASE`)**: line-order-preserving rewrite keeps deep-replay history, failure never poisons the write chain, multi-process lock guard; **graph-dimension diff (Module L, `graphDiff`)**: entity/relation-level edge set-diff between T1/T2 graph views; **local vector 6th recall line (Module M, `vectorEnabled`)**: zero-dependency deterministic HNSW (fnv1a level assignment + paper Algorithm-4 diversity neighbor selection + layer-0 2M cap), TF·IDF cosine over the A2-shared feature space, RRF 6th rank / interpolate boost / why provenance `vector` line; **bilingual entity extraction (Module N)**: EN technical relation lexicon + conjunct splitting + dotted-identifier (node.js) preservation; **memory timeline (Module O, `timeline`)**: per-day added/removed/updated/heat event stream + live-total bar trend |
| Offline evaluation                                | **Golden-corpus evaluation (A5) + real-data gates (0.10.0 G6 / 1.0.0 G7-G8) + cognition gates (1.1.0 G9-G12) + inference gates (1.2.0 G17-G18) + spacetime gates (1.3.0 G19-G20) + defense-in-depth gates (1.4.0 G21-G22) + boundary-breakthrough gates (1.5.0 G23-G25 / 1.5.1 G26)**: recall@k / MRR / NDCG + 4-dim × 81-combo parameter grid + 26 gates (G1-G26, incl. distillation/graph/consolidation/conflict/multi-hop inference/recall provenance/episodic replay/encryption zero-plaintext and replay diff/HNSW-vs-bruteforce and self-retrieval/bilingual extraction/boundary ops/visual page self-containment & injection safety, zero-behavior regression and real-scale cognitive grounding), one-command reproducible via `npm run eval`                                                                                                                                                  |

## Capture pipeline

<div align="center">
  <img src="assets/capture-pipeline.png" alt="Capture pipeline: user message / tool result → capture mode gate → NFKC normalize → sensitive pattern check (REJECT) → short-text discard → kind inference → content-hash dedup → append to JSONL" width="88%">
  <br/>
  <sub><b>Fig. 2</b> Event-driven capture pipeline: seven gates from input to storage; sensitive content and short text are blocked at the entry</sub>
</div>

- **Four capture intensities** (`captureMode`): `off` (disable automatic capture entirely) / `conservative` / `balanced` (default) / `aggressive`; only real user input is captured — plugin injections and subagent contexts are skipped;
- **Zero-exemption sensitive filtering**: patterns such as API keys / JWTs / private keys / connection strings are matched after **NFKC normalization + lowercase folding** — full-width/variant characters (`ｐａｓｓｗｏｒｄ`) cannot bypass; short text (<8 chars) is discarded;
- **Content-level idempotent ingestion**: `contentHash` dedup (near-duplicate content within the 24h window is not stored again), kind inferred from signal words (`preference` / `instruction` / `fact`), then appended to the append-only JSONL — all three write paths share the same entry factory (1.0.0).

## Installation

Put the packaged plugin (`dsh-memory-hub-1.3.0.tgz`) somewhere selectable from the plugin page, then:

```bash
# Option 1: CLI (replace "profile" with your own profile name, e.g. web)
dsh plugin --profile web add ./dsh-memory-hub-1.3.0.tgz

# Option 2: Desktop — click "Install plugin package" on the Settings → Plugins page and choose the tgz
```

After installation the plugin is merged into the profile config tree under the `memory-hub` id (declared in `cordis.patch.yml`); a reload activates it. Uninstalling restores the previous state, and memory files remain on disk.

## Configuration

| Key                   | Default             | Description                                                                                                                                                                                    |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageDir`          | `~/.dsh/memory-hub` | Memory store directory (leave empty for default)                                                                                                                                               |
| `maxEntryChars`       | `1000`              | Max characters per memory entry (imports are subject to the same cap)                                                                                                                          |
| `defaultRecallTokens` | `800`               | Default recall token budget                                                                                                                                                                    |
| `defaultRecallLimit`  | `8`                 | Default max entries per recall                                                                                                                                                                 |
| `captureMode`         | `balanced`          | Automatic capture intensity: `off` / `conservative` / `balanced` / `aggressive`                                                                                                                |
| `autoTags`            | `true`              | Auto-tag memories                                                                                                                                                                              |
| `dedupWindowMs`       | 24h                 | Near-duplicate content within the dedup window is not stored again                                                                                                                             |
| `ttlDays`             | `0`                 | Memory expiry in days; `0` = never expires; when enabled, cleaned every 6h + at startup                                                                                                        |
| `importSources`       | `{}`                | **0.6.0** real-data import sources (optional, see below)                                                                                                                                       |
| `supersedeMode`       | `off`               | **1.0.0** superseded-memory detection: `off` (zero change) / `auto` (detect opposing signals, down-weight recall)                                                                              |
| `semanticBoost`       | `false`             | **1.0.0** stack the semantic line on the lexical line (`true` improves recall on real questions; default off)                                                                                  |
| `fusionMode`          | `interpolate`       | **1.0.0** semantic fusion mode: `interpolate` linear blending / `rrf` reciprocal-rank fusion                                                                                                   |
| `maxEntries`          | `0`                 | **1.0.0** store entry cap (`0` = unlimited; when exceeded, works with `autoEvict` to evict by value)                                                                                           |
| `autoEvict`           | `false`             | **1.0.0** value-aware auto eviction (only when `maxEntries>0` and over the cap; instructions are never evicted)                                                                                |
| `themes`              | `false`             | **1.0.0** topic-clustering view in `status` output (default off to avoid extra compute)                                                                                                        |
| `distillMode`         | `off`               | **1.1.0** memory hierarchy distillation: `off` (zero change) / `auto` (idle batch distillation of recurring behavior/preferences into abstract principles, instructions into procedural rules) |
| `consolidationMode`   | `off`               | **1.1.0** cognition consolidation scheduling: `off` (zero change) / `auto` (spaced-repetition review of due high-value memories)                                                               |
| `graphEnabled`        | `false`             | **1.1.0** temporal knowledge graph as the 4th recall line (rescues entries lexically unreachable but graph-reachable; default off = zero behavior change)                                      |
| `conflictMode`        | `off`               | **1.1.0** conflict-coexistence detection: `off` (zero change) / `auto` (plausibly reversed facts coexist, bidirectionally labeled)                                                             |
| `conflictWindowMs`    | `30d`               | **1.1.1** standalone conflict-detection window (decoupled from `dedupWindowMs` — belief reversals often span weeks, a 24h window could never see them)                                         |
| `graphMaxEntities`    | `2000`              | **1.1.0** graph entity cap (prevents unbounded graph growth from arbitrary text)                                                                                                               |
| `inferEnabled`        | `false`             | **1.2.0** spreading-activation inference as the 5th recall line (multi-hop reasoning along active graph edges, best-path chains replayable; default off = zero behavior change)                |
| `inferMaxHops`        | `2`                 | **1.2.0** max inference-chain hops (`1` direct relations / `2` one-intermediary reasoning; clamped to 1..3)                                                                                    |
| `distillMinCluster`   | `3`                 | **1.1.0** minimum cluster size for distillation (below this, no distillation — avoids abstracting isolated cases into pseudo-principles)                                                       |
| `recallThreshold`     | `0.4`               | **1.1.0** consolidation recall-rate threshold (predicted recall < threshold AND high value → enters the consolidation queue)                                                                   |

### Real-data ingestion (0.6.0)

Want the plugin to come **pre-loaded with memory**? Point existing data assets to the plugin in the profile config; it batch-imports at startup (content-level idempotent — repeated imports auto-merge):

```yaml
# profile patch example (cordis config tree)
memory-hub:
  importSources:
    documents: # Markdown / plain-text memory files (relative/absolute paths both OK)
      - ~/workspace/AGENTS.md
      - ~/workspace/.agents/notes/MEMORY.md
      - ~/notes/my-harness-notes.md
    sessionLogs: # Harness session event JSONL logs
      - ~/.dsh/sessions/archive/2026-09.jsonl
```

- **Markdown documents**: headings/lists become their own blocks, contiguous paragraphs are aggregated; kinds inferred from signal words (`instruction` / `preference`, otherwise `generic`), stored with `explicit` source;
- **Session JSONL**: `user/message` / `assistant/message` events are extracted as text and stored with `auto` source; corrupt lines are skipped and counted, never blocking the rest;
- **No privacy/quality exemptions**: imported content goes through the same sensitive-pattern interceptor (NFKC-normalized) and short-block (<8 chars) discard; missing/unreadable file paths only warn, and the plugin starts normally;
- **Without `importSources` configured, behavior is identical to 0.5.0** (zero imports); paths can be added/removed any time and reloaded.

## Tool usage guide

These 4 tools are automatically exposed to the model, which should call them in the following agent-trigger scenarios:

- **`memory_store`**: the user says "remember…" / "from now on always…"; or when a decision / fact / preference will affect future sessions.
- **`memory_recall`**: at the start of a new session (call once, search past conventions with the current task's keywords); when the user mentions an old topic they may have discussed before; especially effective when spelling/wording is uncertain (fuzzy + semantic fallback); `kind` can restrict recall to one type; **1.1.0 optional params**: `expand` (unfold the source-memory evidence chain on distilled-entry hits), `graphEnabled` (graph-line explicit toggle), `reinforce` (consolidation-review semantics — a hit simulates one successful recall), `asOf` (episodic-replay timestamp — recall exactly what the hub knew at that moment: only then-existing entries, then-current content versions and supersede/conflict state; read-only, heat untouched); **1.4.0**: `memory_status` gains `asOf` (historical snapshot statistics at that instant) and `diffSince` (paired with `asOf` into a T1↔T2 diff view: added/removed/content-changed/supersede-conflict/heat-only); **1.2.0 optional params**: `infer` (enable the spreading-activation inference line, overriding the config default per call), `explain` (emit per-hit recall provenance `why`: participating lines / per-line contributions / weight factor; **as of 1.3.0, infer-fused hits also carry `why.chains` — replayable per-edge reasoning evidence chains**).
- **`memory_forget`**: when the user explicitly asks to delete a memory (id from `memory_recall` / `memory_status`).
- **`memory_status`**: when you need the store size, distribution, disk usage, or to debug whether capture/recall behaves as expected (includes `metrics` and storage `diagnostics`); **1.4.0**: `asOf` views the hub at a historical instant, `diffSince` (paired with `asOf`) shows what changed between two moments.

Tool outputs are **structured JSON + a rendered text snippet**, directly usable in context, with token cost bounded by the budget.

## Recall quality design

<div align="center">
  <img src="assets/recall-scoring.png" alt="Recall scoring: NFKC normalize → four parallel lines (lexical BM25 / fuzzy edit distance / semantic MinHash coverage / temporal KG) → interpolate or RRF fusion → time-decay × heat × value weighting → rank + token budget trim" width="88%">
  <br/>
  <sub><b>Fig. 3</b> Four-line parallel scoring & fusion chain (three lines since 0.5.0, temporal KG as the 4th since 1.1.0)</sub>
</div>

```
score = BM25(query, memory) × time_decay(half-life 7d) × heat(usage cooling) × value(type/source)
BM25  = Σ tf·(k1+1)/(tf + k1·(1 − b + b·len/avgdl)) × log(1 + (N − df + 0.5)/(df + 0.5))   (k1=1.2, b=0.75)
heat  = 1 + 0.1·log1p(accessCount) · exp(−Δ(lastAccessAt)/half-life)   (default half-life 7d, injectable via `heatHalfLifeMs`)
value = type coefficient (instruction 1.25 > decision 1.15 > preference 1.05 > fact 1.0 > generic 0.95) × source coefficient (explicit 1.1 > auto 1.0)
```

- **Chinese 2-gram + English word** dual-path tokenization (query and index both go through **NFKC normalization**; English stop words filtered); term-frequency saturation + document-length normalization so long-tail documents no longer naturally outweigh concise memories;
- **A1 fuzzy retrieval**: English query tokens (≥4 chars) generate edit-distance ≤1 variants (delete/transpose/replace/insert), applied at 0.5 discount only when exact BM25 yields zero hits — `delpoy` still finds `deploy`;
- **A2 semantic fallback**: English tokens expand into character 3-gram features (k=16 MinHash signatures cached with the index for LSH pruning); on zero lexical hits, fall back by exact query coverage (≥0.45) at 0.3 weight — stem/morphological variants (`deploy` ↔ `deployment`) no longer slip through;
- **A3 value awareness**: instructions/decisions/explicit memories naturally weigh more, so important things aren't drowned by logbook facts (`significance` can be disabled);
- **A4 heat lifecycle**: rarely-accessed high-frequency old memories cool exponentially along the Ebbinghaus forgetting curve; recently-validated memories stay hot, and new relevant information gets a chance to be recalled;
- Results are ranked by score then **token-budget trimmed** (default 800 tokens / 8 entries) to keep memory from blowing up the context;
- A hit increments heat +1 and updates last-access time (only contract fields are persisted; runtime `score` is never written to storage);
- Scoring-base time and all parameters (k1/b/half-life/switches) are injectable (reproducible results under the same base), enabling tests and batch evaluation (`npm run eval`).

## Architecture highlights

- **Real-data ingestion (0.6.0)**: `src/memory/importer.ts` pure-function import layer — Markdown memory docs chunked (heading/list aggregation, index lines skipped), session JSONL parsed leniently (user/assistant events, corrupt-line counting without blocking), content-hash idempotent ids (`imp-${contentHash}` auto-merge across sources/time), kind inference from signal words, sensitive filtering + maxChars truncation with zero exemptions; optional `importSources` startup import; failures only warn, and behavior without config is identical to 0.5.0;
- **Unified error infrastructure (0.7.0)**: `errorMessage` is the single global error-message entry (`MemoryHubError` → `CODE: message` with stable error codes, `Error` → message, others → String fallback); 9 entry-point warning logs unified; error-code contract (`ErrorCodes`) and `toMemoryHubError` both have 100%-coverage dedicated tests;
- **Zero duplicate implementations (0.7.0)**: content-block text extraction consolidated into the **single implementation** `src/memory/text.ts` (reused by index.ts and importer.ts; re-exports keep import compatibility); the capture-ingest pipeline (sensitive filter/dedup/truncation/workspace/metrics) extracted from the entry point into `src/memory/ingest.ts`, directly unit-testable, with index.ts focused on "wiring";
- **Per-module refinement & observability (0.7.0)**: non-null assertions in src cut from 69 to 4 (−94%; the rest carry algorithm-invariant proofs for rolling-array convergence); eval report version auto-read from `package.json` (no hardcoded drift); bench quality comparisons actually printed to stdout (`[bench]` prefix); coverage thresholds aligned with measured values and frozen into CI (lines ≥94.71 / branches ≥89.71 / functions ≥95.14);
- **Fully testable plugin lifecycle & error paths (0.8.0)**: `mountPlugin()` explicitly assembles the plugin object to drive cordis's real disposer chain (vitest ESM transform environment adaptation); normal/abnormal unload, tool-registration failure without blocking, store-open failure without crashing, three prune paths, capture-queue backpressure 256 boundary, full ttlDays timer branch coverage (index.ts branches 70.21 → 85.07);
- **Tool output contract white-boxed (0.8.0)**: all four tools' `render(args, value)` directly unit-tested across every output shape (status empty/full, recall zero/multiple hits, forget removed/not found, store workspace/tags/truncation); tool function coverage 71.42 → 100, output assertable and regression-safe;
- **Defensive-branch closure & zero assertions (0.8.0)**: 18 guard branches in engine + 3 kinds of unreachable dead code removed via invariant proofs (branches 100%); store's four failure-injection fault classes directly tested; `status` double assertion purified into a type guard; `recall` output contract extracted into a reused interface; `index` registration types tightened — src assertion count does not increase, thresholds synced to lines ≥96.5 / branches ≥95 / functions ≥97;
- **Deep closure of weak spots (0.9.0)**: all 16 weak spots (P0×3 / P1×6 / P2×7) proven by the DEEP-AUDIT seven-dimension audit closed — drift-immune lexicon (strength words compiled from a single source of truth, fixing undercapture of bare "务必/一定" in conservative mode), shared-default isolation (unlabeled workspace = globally shared, tools/result capture traced by agent-session cwd), dual-scale time semantics (default ttlDays=0 disables score decay; decay can be disabled, half-life injectable), write-path engineering (in-batch instantaneous dedup + dispose capture barrier + recall heat merge-writeback that resists gaming and surfaces errors to metrics), signature-candidate preselection (MinHash landing as real pruning from reserved status, scoring semantics unchanged), contract explicitness (autoTags effective / importer isUser consumed / three capture modes / strict forget throws NOT_FOUND / idempotent .corrupt evidence / zero-copy snapshot / unified illegal-kind error shape) — 324 tests green, branches 96.1 → 97.87, all six eval gates and bench pass;
- **Real-data grounding (0.10.0, new G6)**: offline evaluation upgraded from "synthetic-corpus self-proof" to **real-data validation + synthetic-corpus regression** dual track — real official docs (Node.js v26.10.0 path/os fixed-tag snapshot, SHA-256 pinned, shipped with the repo, offline evaluation) ingested via `planImport` through the **production path** (329 real memories); 24 real API questions annotated to semantic anchors; gates frozen at recall@1 ≥ 0.75 / recall@3 ≥ 0.85 / recall@5 ≥ 0.95 — recall quality remains validated against real data; see [`docs/GROUND-0.10.md`](docs/GROUND-0.10.md);
- **Memory lifecycle & conflict awareness (1.0.0 Module A, absent in market)**: supersede protocol (single-source-of-truth signal lexicon; `auto` mode detects "switch to / upgrade to" opposing signals → new memory tagged `supersede:`, old memory tagged `superseded-by:` → superseded memories are **down-weighted + co-occurrence deduped** on recall; `supersededPenalty` tunable), runtime topic-clustering view (computed in `status` only when `themes` is enabled, not persisted), value-aware auto eviction (`maxEntries` + `autoEvict`, evicts by heat + significance, instructions never evicted) — full design in [`docs/DESIGN-1.0.md`](docs/DESIGN-1.0.md);
- **Dual-engine hybrid retrieval (1.0.0 Module B, RRF fusion)**: lexical (BM25) / fuzzy (edit distance ≤1) / semantic (MinHash coverage, two-level guard) three-line scoring; with `semanticBoost` enabled, lines stack or fuse via `rrf` (k=60) — further recall improvement on real questions (all 49 G6 question gates green);
- **Memory cognition layer (1.1.0 Modules A-D, "memory cognition" absent in market)**: elevates memory from a flat store to a cognitive memory system — **hierarchical distillation** (Module A: recurring behavior/preference clusters → abstract principles, instruction clusters → procedural rules, `distilled-from` evidence chain + recall expand unfolding; conflict-cluster guard distills 0 to prevent pseudo-principles), **consolidation & forgetting curve** (Module B: Ebbinghaus spaced-repetition strength model `R(t)=strength·e^(−Δt/τ)`, idle batch review of due high-value memories, protocol-internal access-history updates, zero new fields), **temporal knowledge graph** (Module C: zero-dependency rule engine extracts CN/EN subjective triples, `TemporalGraph` incrementally maintained + supersede timeline-invalidated edges, becoming the **4th recall line** alongside lexical/fuzzy/semantic — entries lexically unreachable but graph-reachable can be rescued), **belief revision & conflict coexistence** (Module D: plausibly reversed facts coexist with bidirectional labels, both retained on recall with newest-first explicit `conflicts` output, mutually exclusive with the supersede strong-opposition lexicon, correction timeline replayable by timestamp); benchmarked against MemGPT / GraphRAG / HippoRAG / Zep Graphiti / Generative Agents, all implemented as **pure functions with zero new runtime dependencies**; full design in [`docs/DESIGN-1.1.md`](docs/DESIGN-1.1.md);
- **Inference uplift (1.2.0 Modules E/F, retrieval → reasoning)**: upgrades recall from "which memories are similar" to "what can be inferred from memory" — **spreading-activation inference line** (Module E: query entities diffuse along active graph edges over multiple hops with per-hop decay and relation confidence, best-path chains kept per terminal entity and replayable; asOf-correct — inference cannot traverse superseded/invalidated relations; beam + chain-count double bounds keep hub fan-out contained; interpolates linearly or joins RRF as the 5th rank line) and **recall provenance** (Module F: `explain=true` annotates every hit with why — participating lines (bm25/fuzzy/semantic/graph/infer), per-line contributions and lineBase; under rrf the contributions reconstruct the final score bit-exactly; pure read-side annotation, scoring arithmetic untouched byte-for-byte); full design in [`docs/DESIGN-1.2.md`](docs/DESIGN-1.2.md);
- **Spacetime completeness (1.3.0 Modules G/H, now → any moment)**: completes recall's time dimension — **episodic replay** (Module G: the append-only JSONL log replayed in file order by the pure `replayAsOf` function, per-line write time anchored by the existing write protocol `max(updatedAt, lastAccessAt)`, yielding any past moment's exact knowledge state — existence, content versions, supersede/conflict markers, access heat; the graph is rebuilt from the replayed corpus into a T-instant view; read-only, heat untouched, cache unpolluted) and **inference evidence chains** (Module H: `why.chains` surfaces the chains 1.2.0 computed but kept inside the engine — infer-fused hits carry up to 3 per-edge replayable path chains); full design in [`docs/DESIGN-1.3.md`](docs/DESIGN-1.3.md);
- **Defense-in-depth & temporal analytics (1.4.0 Modules I/J, plaintext → ciphertext / snapshot → change audit)**: **session-level encrypted storage** (Module I: per-line AES-256-GCM + scrypt key derivation + in-place migration preserving deep-replay history — closing the final roadmap box) and **temporal analytics** (Module J: status asOf snapshots + T1↔T2 diff views with six-way attribution); full design in [`docs/DESIGN-1.4.md`](docs/DESIGN-1.4.md);
- **Boundary breakthrough (1.5.0 Modules K/L/M/N/O — every remaining boundary explicitly deferred across the 1.2-1.4 design docs is closed)**: **passphrase rotation** (Module K: encrypted→new / encrypted→plaintext / plaintext→encrypted, line-order-preserving rewrite, failure keeps file intact and the write chain unpoisoned), **graph-dimension diff** (Module L: diffGraphs rebuilds both graph views and set-diffs active edges, complementing the entry-level diffReplay), **local HNSW vector 6th line** (Module M: deterministic level assignment + paper diversity neighbor selection — plain closest-M pruning degenerates clustered corpora into unreachable subgraphs, the key engineering finding of this release; real-scale calibration: 3333 docs, HNSW vs bruteforce top-10 fully identical), **bilingual extraction** (Module N: returns/throws/emits/based-on… + CN counterparts, conjunct splitting, identifier-dot preservation), **memory timeline** (Module O: per-day event stream + live-total bars), **visual retrieval page** (Module P (1.5.1): `exportHtml` — self-contained HTML with timeline bar chart + browser-local scored search, deterministic rendering + injection safety + zero external refs); full design in [`docs/DESIGN-1.5.md`](docs/DESIGN-1.5.md);
- **Event sourcing**: no polling, no Agent Loop intrusion — subscribes to the `session/event` pipeline for user messages and `tools/result` for tool results, purely incremental learning;
- **Bounded backpressure capture queue**: serial FIFO promise chain with a cap of 256; event floods drop the oldest tasks and count them (`dropped`) — process memory is always bounded and a single failure never blocks the rest;
- **Read consistency (disk-before-memory)**: every write path appends to file first, then mutates the in-memory map — concurrent readers only ever see confirmed-persisted state, and write failures leave zero residue by construction;
- **Inverted-index cache (`IndexCache`)**: recall invalidates on store `revision` + **content fingerprint** (sha256 of id/content/tags): same-revision heat updates reuse the old index, only content changes trigger rebuild — when the corpus is unchanged, recall completes at O(query) without full rebuild;
- **Okapi BM25 ranked retrieval**: term-frequency saturation + document-length normalization (long docs no longer dominate), plus query NFKC normalization and English stop-word filtering — concise memories rank ahead of long tails (measured top@1 hit-rate up to 100%; see `docs/CENTURY-0.4.md` Appendix A);
- **Fuzzy retrieval (A1)**: edit-distance ≤1 query expansion (Damerau-Levenshtein four single edits, stop words and out-of-vocabulary words filtered) applied at 50% only on exact zero hits — precision and recall both preserved;
- **Approximate semantic recall (A2)**: character 3-gram feature space + MinHash signature cache (LSH pruning asset), scored by zero-error exact coverage to avoid MinHash variance on small feature sets — a local semantic layer with no external embedding service;
- **Memory value awareness (A3)**: instructions/decisions/explicit memories weighted by significance — pure-function constant weights, reproducible and disabled-able;
- **Heat lifecycle (A4)**: exponential forgetting-curve cooling (default half-life 7 days) — "use it or lose it" cooling/revival loop: a hit calls `bumped()` to update `lastAccessAt`, giving rarely-accessed high-frequency memories a chance to resurface;
- **Offline evaluation suite (A5 + 0.10.0 G6 + 1.0.0 G5/G7/G8 + 1.1.0 G9-G12)**: fixed-seed golden corpus (precise/fuzzy/semantic/heat four scenarios) + recall@k/MRR/NDCG metrics + 4-dim × 81-combo parameter-grid sensitivity (G5: k1×b×heatHalfLifeMs×semanticWeight) + **real official-doc corpus (Node.js v26.10.0 snapshot) ingested via the production path as the G6 real-data gate** (G7 five perturbation robustness classes / G8 lifecycle clustering / G9-G12 distillation·graph·consolidation·conflict cognition gates), one-command reproducible with Markdown report via `npm run eval`;
- **Zero-copy snapshot (0.9.0)**: `list()` returns a direct reference to the sorted shared cache; writes mark it dirty and rebuild a new array on next access (copy-on-write) — O(1) zero-copy reads, external mutation never pollutes new state, zero waste on hot recall/status queries;
- **Runtime metrics (`HubMetrics`)**: ten counters for captured / explicit stored / recall counts & hits / forgotten / sensitive-rejected / dedup-rejected / TTL-cleaned / backpressure-dropped / errors; `memory_status` takes live snapshots and unload prints a summary — health at a glance;
- **Unicode normalization safety**: sensitive detection normalizes with NFKC + lowercase folding first — full-width/variant characters (`ｐａｓｓｗｏｒｄ`) cannot bypass filtering;
- **Contract purity**: `MemoryEntry` runtime type guards (`isMemoryEntry` / `parseMemoryEntry`); recall heat updates explicitly pick contract fields, runtime `score` never persists;
- **Append-only storage**: O(1) append writes, tombstone batch logical deletes (`removeMany`), threshold-triggered atomic compact rebuild (tmp + rename) with post-rebuild row-count self-check; compact failure only warns, never swallows writes; privacy files chmod 0600;
- **Storage self-healing & migration loop (0.4.0)**: corrupt JSONL lines are skipped and auto-quarantined with evidence to `<file>.corrupt` (failure only warns); `exportAll()` full export + `importAll()` import form the cross-device migration loop — lossless round-trip;
- **First-class cordis lifecycle**: all listeners, tool registrations, timers and storage handles are returned as effects; async disposer waits for store shutdown; plugin unload auto-cleans, safe for hot reload;
- **Type safety & engineering guardrails**: `TypeScript strict` + frontier flags such as `exactOptionalPropertyTypes` / `verbatimModuleSyntax` + eslint 9 (typescript-eslint) + prettier + vitest coverage-threshold guard (lines ≥96.5 / branches ≥95 / functions ≥97 / statements ≥96.5, frozen against 0.8.0 measurements) + GitHub Actions CI (with a standalone `npm run eval` quality-gate job) + `npm run check` one-command full check, real dsh ecosystem types, zero `any` leaking into business logic;
- **Extensible storage**: the storage layer implements the `MemoryStore` interface; new capabilities (`removeMany`/`revision`/`diagnostics`/`exportAll`) are all optional members — a SQLite / vector DB / MCP backend can be swapped in non-invasively in the future;
- **Graded errors**: unified `MemoryHubError` (stable codes EMPTY_CONTENT / SENSITIVE_CONTENT / STORE_CLOSED / STORE_WRITE_FAILED / STORE_READ_FAILED / …), programmatically handleable on the tool side;
- **Defensive runtime**: store-open failure does not block plugin load; event payload parse failures only warn; corrupt JSONL lines are auto-skipped and counted.

## Storage & consistency model

<div align="center">
  <img src="assets/storage-model.png" alt="Storage model: write path append-only JSONL (disk-first) → tombstone logical delete → compact atomic rebuild; MemoryEntry nine-field contract + IndexCache content-fingerprint invalidation; read path zero-copy snapshot + inverted-index recall" width="88%">
  <br/>
  <sub><b>Fig. 4</b> Storage model: disk-before-memory writes, logical deletes, atomic rebuild and the zero-copy read path</sub>
</div>

- **Write path (disk-before-memory)**: every write appends to file successfully _first_, then mutates the in-memory map — crash/write failures leave zero residue; deletes are tombstone logical marks (`removeMany` batch), and compact triggers tmp + rename atomic rebuild with a post-rebuild row-count self-check;
- **Read path (zero-copy)**: `list()` returns a direct reference to the sorted shared cache (copy-on-write) so external mutation never pollutes new state; recall invalidates `IndexCache` by store `revision` + content fingerprint (sha256) and completes at O(query) when the corpus is unchanged;
- **Contract & migration**: `MemoryEntry` nine-field runtime type guards with runtime `score` never persisted; corrupt lines auto-quarantined with evidence (`.corrupt`) + lossless `exportAll` / `importAll` migration loop; privacy files chmod 0600, directories 0700.

## Cognitive memory system

<div align="center">
  <img src="assets/cognitive-memory.png" alt="Cognitive memory system: MemoryStore contract unchanged with four surrounding modules — Distillation, Consolidation (Ebbinghaus), Temporal Knowledge Graph, Conflict Coexistence — all default off = zero behavior change; memory_status exposes distilled/dueCount/graph stats/conflictPairs" width="88%">
  <br/>
  <sub><b>Fig. 5</b> 1.1.0 cognitive memory system: four modules radiating from MemoryStore, all default-off = zero behavior change</sub>
</div>

- **Hierarchical distillation (Module A)**: recurring behavior/preference clusters are inducted into abstract principles, instruction clusters into procedural rules (`distillMinCluster=3` prevents pseudo-principles), with a `distilled-from` evidence chain; `recall(expand)` unfolds the source memories on hit;
- **Consolidation & forgetting curve (Module B)**: Ebbinghaus spaced-repetition strength model `R(t)=strength·e^(−Δt/τ)`; idle batch review of due high-value memories, protocol-internal access-history updates, zero new fields (`recallThreshold=0.4` controls enqueueing);
- **Temporal knowledge graph (Module C)**: zero-dependency triple extraction + incremental `TemporalGraph` maintenance, becoming the 4th recall line — entries lexically unreachable but graph-reachable can be rescued (`graphMaxEntities=2000` bounds growth);
- **Belief revision & conflict coexistence (Module D)**: plausibly reversed facts coexist with bidirectional labels, both retained on recall with newest-first explicit `conflicts` output — mutually exclusive with the supersede strong-opposition lexicon, correction timeline replayable by timestamp;
- **Zero behavior change guarantee**: all four modules default off (`distillMode` / `consolidationMode` / `graphEnabled` / `conflictMode`), while `memory_status` extends observability with `distilled` / `dueCount` / `graph stats` / `conflictPairs`.

### Inference uplift (1.2.0, Modules E/F)

- **Spreading-activation inference line (Module E, `inferEnabled` + `inferMaxHops`, default off)**: an engineering take on the classic cognitive-science retrieval model (Collins & Loftus 1975) — query entities diffuse along the temporal graph's _active_ out-edges (per-hop ×0.5 decay × relation confidence × oldest-edge conservative freshness), keeping the best-path chain per terminal entity (`A—uses→B—depends→C` replayable); asOf timeline hard constraint (inference never traverses invalidated relations, incl. `reassertedAt` revival); beam 16 + chain-count 16 double bounds; interpolates linearly (weight 0.25) or joins RRF as the 5th rank line;
- **Recall provenance (Module F, `memory_recall explain`)**: every hit carries `why` — participating recall lines (bm25/fuzzy/semantic/graph/infer in fixed order), per-line contributions and the common weight factor; under rrf, `Σ contributions × lineBase` equals the final score **bit-exactly**; rendering appends provenance notes per hit;
- Full design in [`docs/DESIGN-1.2.md`](docs/DESIGN-1.2.md); real-scale gates G17-G18 lock chain determinism/bounds/cross-validation and the provenance contract.

### Spacetime completeness (1.3.0, Modules G/H)

- **Episodic replay (Module G, `memory_recall asOf`)**: recall at any past moment — `replayAsOf` replays the append-only JSONL log in file order (pure, single-pass, deterministic); per-line write time is anchored by the existing write protocol (content/marker writes → `updatedAt`, heat writebacks → `lastAccessAt`), yielding that moment's **exact knowledge state** (existence / content versions / supersede & conflict markers / access heat); tombstone lines carry the deletion instant (legacy lines conservatively treated as always-deleted); the graph is rebuilt from the replayed corpus into a T-instant view (future entries' edges absent, supersede state = the then-snapshot); read-only replay (no heat writes, bypasses the index cache); stores without `listAsOf` degrade to a `createdAt` filter;
- **Inference evidence chains (Module H, `explain` emits `why.chains`)**: provenance upgraded from “the infer line contributed score” to “on what reasoning” — infer-fused hits carry up to 3 chains (each edge `from/relation/to/confidence/occurredAt`, directly replaying `A—uses→B—depends→C`); collection is a pure out-param (`chainsOut`), scoring path untouched;
- Rendering example: `[memory recall @2026-10-20T00:00:00.000Z] 3 hit(s) … - (fact) …（溯源: interpolate ← infer=0.0164）（推理: 事务机制 —~属于→ mvcc —~依赖→ postgresql (0.42)）`;
- Full design in [`docs/DESIGN-1.3.md`](docs/DESIGN-1.3.md); real-scale gates G19-G20 lock it (3333 real doc entries restaged into a production-format write log: per-instant snapshots match hand computation + future entries never leak through lexically or via graph edges).

### Defense-in-depth & temporal analytics (1.4.0, modules I/J)

- **Session-level encrypted storage (Module I, config `passphrase` or env `DSH_MEMORY_PASSPHRASE`)**: when enabled, memory files are written as per-line AES-256-GCM authenticated ciphertext (scrypt N=16384 key derivation; a first-line key record stores the salt and KDF params; AAD binds the format version) — **at-rest confidentiality** (zero plaintext beyond the header; backups/images/accidental commits no longer leak content) + **per-line tamper evidence** (auth failures flow into the existing corrupt-line quarantine with evidence); wrong or missing passphrase fails fast and explicitly at load (never masquerades as an empty store); **plain-text stores migrate in place**, rewritten line-by-line in original order (the append-only deep-replay history — old content versions and deletion instants — is preserved verbatim, only the “clothing” changes to ciphertext); compact coexists with encryption; mixed files tolerated (mid-migration state reads fine, compact converges to full ciphertext); a lost passphrase means unrecoverable data (no backdoor by design); in-process memory stays plaintext (necessary at runtime — the promise is at-rest);
- **Temporal analytics (Module J, new `memory_status` params)**: `asOf` historical snapshot — statistics of the hub as of that instant (only then-existing entries, then-current content versions and supersede/conflict state; corpus-layer fields only, runtime observables never mixed in; hot/cold layering anchored at asOf); `diffSince` (paired with `asOf` into a T1↔T2 diff view) — what happened to the hub in between: added/removed/content-changed/supersede/conflict/heat-only six-way attribution (`diffReplay`, a deterministic pure function), samples capped at 20 with full counts; degraded stores approximate via a createdAt filter (removed always empty, documented);
- Render examples: `[memory status diff 2026-10-24T… → 2026-10-29T…] +2 -1 ~0 (heat 1)`; `[memory status @2026-10-24T…] 401 entries`;
- Full design in [`docs/DESIGN-1.4.md`](docs/DESIGN-1.4.md); real-scale gates G21-G22 lock it (400 real-corpus entries with multi-probe zero-plaintext at rest + migration preserving deep replay; G19-identical staged timeline with three-interval diffs matching hand computation).

## Development

```bash
npm install          # install dependencies
npm run typecheck    # tsc --noEmit type check
npm run lint         # eslint static analysis
npm run format:check # prettier format check
npm test             # vitest run (612 unit/integration/load-smoke tests + 70 eval gates, 682 in total)
npm run eval         # A5 offline quality evaluation (golden corpus + parameter grid + G1-G20 gates, one-command reproducible)
npm run test:coverage # vitest coverage (with threshold guard: lines/statements ≥98 / functions ≥98 / branches ≥93, re-frozen to measured values in 1.3.0, held by new 1.4.0 source files)
npm run check        # one-command full check: verify:realdata + typecheck + lint + format + test
npm run build        # tsup produces ESM + d.ts into lib/
npm run bench        # vitest bench performance benchmarks (recall/search index 0.4.0, knowledge-graph 10K build/P95, distillation batches)
npm pack             # produces dsh-memory-hub-1.3.0.tgz
```

## Directory structure

```
dsh-memory-hub/
├── src/
│   ├── index.ts              # plugin entry: service wiring, bounded capture queue, metrics, lifecycle, startup import (0.6.0)
│   ├── config.ts             # schemastery config Schema (auto-generated config panel, incl. optional importSources)
│   ├── errors.ts             # MemoryHubError + stable error codes + errorMessage/toMemoryHubError (unified error infra, 0.7.0)
│   ├── memory/
│   │   ├── types.ts          # MemoryEntry contract + runtime guards (isMemoryEntry/parse/to) + RecallOptions
│   │   ├── entry-factory.ts  # 1.0.0 unified memory-entry factory (id assembly/tags cleaning/truncation/workspace injection/timestamps, one semantics for all three write paths)
│   │   ├── store.ts          # append-only JSONL + tombstone (1.3.0: deletion instant) + replayAsOf episodic replay + removeMany + compact self-check + exportAll + corrupt-line quarantine evidence
│   │   ├── engine.ts         # inverted index + BM25 + A1 fuzzy variants + A2 semantic features/MinHash + A3 value weighting + A4 heat lifecycle + IndexCache (pure functions)
│   │   ├── importer.ts       # 0.6.0 real-data ingestion (Markdown chunking / session JSONL extraction / kind inference / idempotent planning, pure functions)
│   │   ├── text.ts           # 0.7.0 single content-block text-extraction implementation (shared by index/importer, eliminates duplication)
│   │   ├── ingest.ts         # 0.7.0 capture-ingest pipeline (sensitive/dedup/truncation/workspace/metrics, independently testable)
│   │   ├── metrics.ts        # HubMetrics runtime metric aggregator (zero-dependency, snapshotable)
│   │   ├── capture.ts        # event-capture heuristics + NFKC-normalized sensitive filtering
│   │   ├── distill.ts        # 1.1.0 memory hierarchy distillation (clustering/induction/layering/evidence-chain refs, pure functions)
│   │   ├── consolidation.ts  # 1.1.0 cognition consolidation & forgetting curve (strength model/due determination, pure functions)
│   │   ├── graph.ts          # 1.1.0 temporal knowledge graph (triple extraction/TemporalGraph/4th recall line)
│   │   ├── conflict.ts       # 1.1.0 belief revision & conflict coexistence (weak opposing signals/bidirectional labels)
│   │   ├── crypto.ts         # 1.4.0 per-line AEAD codec (scrypt KDF + AES-256-GCM envelopes + key record header)
│   │   └── cognitive.ts      # 1.1.0 entry aggregation for modules A-D + idle consolidation/distillation scheduling
│   └── tools/                # memory_store / recall (incl. kind filter + 1.1.0 expand/graphEnabled/reinforce + 1.3.0 asOf episodic replay + 1.2.0 infer/explain with why.chains evidence) / forget / status (+ 1.1.0 distilled/graph/dueCount/conflictPairs observability + 1.4.0 asOf historical snapshots and diffSince diff views)
├── eval/                     # A5 offline quality evaluation suite (corpus golden corpus / realdata G6 real-data gate / metrics / G1-G26 gate tests; bit-exact zero-behavior regression + G13-G16 real-scale cognition grounding + G17-G18 inference gates + G19-G20 spacetime gates + G21-G22 encryption & temporal-analytics gates + G23-G25 boundary-breakthrough gates + G26 visual-page gate)
├── bench/                    # vitest bench performance benchmarks (recall/search index 0.4.0, knowledge-graph 10K build/P95, distillation 1K/10K batches)
├── test/                     # 612 unit + integration + load-smoke tests (incl. 0.8.0/0.9.0 upgrade specials + 1.1.0 new tool-param assertions + 1.2.0 inference/provenance specials + 1.3.0 episodic-replay/evidence-chain specials + 1.4.0 encryption/temporal-view specials + 1.5.0 rotation/graph-diff/timeline/bilingual/vector specials + 1.5.1 visual-export specials + coverage-1.3 threshold-regression series)
├── docs/ARCHITECTURE.md      # architecture design & market-gap argument (0.1.0→1.0.0 full version evolution + 1.0.0 century upgrade)
├── docs/DESIGN-1.1.md        # 1.1.0 cognitive memory system design (modules A-D: distillation/consolidation/temporal graph/conflict coexistence + G9-G12 gates)
├── docs/DESIGN-1.2.md        # 1.2.0 inference uplift design (modules E/F: spreading-activation inference line / recall provenance + G17-G18 gates)
├── docs/DESIGN-1.3.md        # 1.3.0 spacetime completeness design (modules G/H: episodic replay / inference evidence chains + G19-G20 gates)
├── docs/DESIGN-1.4.md        # 1.4.0 defense-in-depth & temporal analytics design (modules I/J: encrypted storage / temporal analytics + G21-G22 gates)
├── docs/DESIGN-1.5.md        # 1.5.0/1.5.1 boundary-breakthrough design (modules K/L/M/N/O/P: passphrase rotation / graph diff / vector 6th line / bilingual extraction / timeline / visual retrieval page + G23-G26 gates)
├── docs/DEEP-AUDIT.md        # 0.8.0 terminal seven-dimension deep audit of all modules
├── docs/history/             # archived per-version design snapshots (EVOLUTION/CENTURY/QUALITY/LIFT/GROUND/REALDATA/INNOVATION/DESIGN-0.9/DESIGN-1.0, 13 docs + quality reports)
├── .github/workflows/ci.yml  # GitHub Actions CI (node 18/20/22 × full check + coverage + quality-eval gates)
├── CHANGELOG.md              # Keep a Changelog version history
├── eslint.config.js          # eslint 9 flat config (strict typescript-eslint)
├── .prettierrc.json          # prettier formatting conventions
├── vitest.config.ts          # vitest + coverage thresholds (lines/statements ≥98 / functions ≥98 / branches ≥93, re-frozen to measured values in 1.3.0)
└── cordis.patch.yml          # plugin bundle patch declaration
```

Full design derivations: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); 1.1.0 cognitive memory system in [`docs/DESIGN-1.1.md`](docs/DESIGN-1.1.md); 1.2.0 inference uplift in [`docs/DESIGN-1.2.md`](docs/DESIGN-1.2.md); 1.3.0 spacetime completeness in [`docs/DESIGN-1.3.md`](docs/DESIGN-1.3.md); 1.4.0 defense-in-depth & temporal analytics in [`docs/DESIGN-1.4.md`](docs/DESIGN-1.4.md); 1.5.0 boundary breakthrough in [`docs/DESIGN-1.5.md`](docs/DESIGN-1.5.md); historical per-version design snapshots (0.1.0→1.1.1, EVOLUTION/CENTURY/QUALITY/LIFT/GROUND/REALDATA/INNOVATION/DESIGN series) are archived under [`docs/history/`](docs/history/).

## Privacy & security

- **1.4.0 optional encryption**: with `passphrase` configured (or the `DSH_MEMORY_PASSPHRASE` env var), memory files are written as per-line AES-256-GCM ciphertext — zero plaintext at rest, per-line tamper evidence, wrong-passphrase fast-fail at load; plain-text stores migrate in place automatically with full history preserved; a lost passphrase is unrecoverable (no backdoor);
- Memory files default to `~/.dsh/memory-hub/memories.jsonl` in plain-text JSONL: file permissions always chmod 0600 (enforced on first write); directories created by this plugin are tightened to 0700, existing shared directories are left untouched — readable locally only;
- The capture layer has built-in sensitive-pattern interception (OpenAI key / sha1 token / JWT / password key-value / private key / MongoDB connection string / `user:pass@host` / AWS `AKIA` / GitHub `ghp_` / Slack `xox` / GCP `AIza`), all matched after **NFKC normalization** — full-width/variant characters cannot bypass;
- Explicit memory (`memory_store`) likewise rejects sensitive plaintext, throwing the `SENSITIVE_CONTENT` error code on match;
- `captureMode: off` completely disables automatic capture, keeping only explicit tool memory;
- Uninstalling the plugin does not delete memory files (left for the user to dispose of as they see fit).

## Roadmap

- [x] append-only storage + tombstone + compact (0.2.0)
- [x] TF·IDF inverted retrieval for recall quality (0.2.0)
- [x] capture-queue backpressure + NFKC sensitive-filter hardening (0.2.0)
- [x] World-class uplift: write consistency, index/snapshot cache, bounded backpressure, observable metrics, batch delete, CI/CHANGELOG (0.3.0)
- [x] Century-level upgrade: BM25 ranked retrieval + query normalization/stop words, IndexCache content-fingerprint invalidation, corrupt-line quarantine evidence, compact self-check, exportAll migration loop (0.4.0)
- [x] Deep innovation: fuzzy retrieval (A1) + MinHash approximate semantic recall (A2) + value-aware scoring (A3) + heat lifecycle (A4) + offline evaluation suite (A5) (0.5.0)
- [x] Real-data ingestion: batch-import Markdown memory docs / session JSONL at startup, content-level idempotency, kind inference, zero-exemption sensitive filtering (0.6.0)
- [x] World-class code-quality upgrade: gate strength aligned with measurements, zero duplicate implementations, unified error infrastructure, assertion purification −94%, eval in CI, observable bench (0.7.0)
- [x] Full-module weak-spot uplift: fully testable plugin lifecycle/error paths, white-boxed tool output contracts, engine/store/capture defensive-branch closure, zero assertions, thresholds raised to 96.5/95/97 (0.8.0)
- [x] Deep weak-spot closure: drift-immune lexicon, shared-default isolation, dual-scale time semantics, write-path engineering, signature-candidate preselection, contract explicitness — all 16 items closed (0.9.0)
- [x] Real-data grounding: real official-doc corpus ingested via the production path, G6 real-data gates (recall@1≥0.75 / @3≥0.85 / @5≥0.95) in CI (0.10.0)
- [x] Century upgrade 1.0.0: memory lifecycle & conflict awareness (supersede protocol / topic-clustering view / value-aware eviction) + dual-engine hybrid retrieval (three-line scoring + interpolate/RRF fusion) + UF-1.0 unified fingerprint dedup + observability uplift; evaluation gates expanded to G1-G8 (4-dim × 81-combo grid / 49 real questions / five perturbation robustness classes / lifecycle clustering)
- [x] Cognitive memory system 1.1.0: memory hierarchy distillation + consolidation & forgetting curve + temporal knowledge graph as 4th recall line + belief revision & conflict coexistence; evaluation gates expanded to G1-G12 (incl. byte-exact zero-behavior regression assertions) and bench performance baselines
- [x] Full-audit hardening 1.1.1: 2×P0 / 12×P1 fixes (golden corpus committed / graph seeding / multi-process compact safety / frozen heat scoring / near-duplicate passthrough) + engine modularization + CJK tokenization root fix + graph entity normalization layer; gates expanded to G1-G16 (real-scale cognitive grounding)
- [x] Inference uplift 1.2.0: spreading-activation inference as the 5th recall line (replayable best-path chains / asOf timeline never traverses invalidated relations / beam + chain-count bounds) + recall provenance why (every hit explainable, rrf contributions bit-exact); gates expanded to G1-G18
- [x] Spacetime completeness 1.3.0: episodic replay (log-level pure `replayAsOf` — any moment's existence/content-versions/supersede-conflict/heat state + T-instant graph rebuild + read-only) + inference evidence chains `why.chains` (per-edge replayable reasoning); gates expanded to G1-G20
- [x] Defense-in-depth & temporal analytics 1.4.0: session-level encrypted storage (optional passphrase — per-line AES-256-GCM + scrypt derivation + in-place migration preserving deep-replay history) + status asOf historical snapshots and T1↔T2 diff views; gates expanded to G1-G22
- [x] Boundary breakthrough 1.5.0: passphrase rotation & decrypt-back + graph-dimension diff + local HNSW vector 6th recall line (roadmap item: deterministic HNSW into RRF) + bilingual entity extraction + memory timeline (roadmap item); gates expanded to G1-G25
- [x] Visual retrieval page 1.5.1 (roadmap item): `memory_status exportHtml` self-contained HTML export — timeline bar chart + browser-local scored search (zero-dependency / zero external refs / deterministic / injection-safe, G26 real-scale gate); gates expanded to G1-G26
- [x] Cross-platform GUI memory manager 1.6.0 (desktop app: editing/import-export UI/multi-library management): added the `./core` pure-library subpath export (single source of truth, zero implementation copy in the GUI); the application-level deliverable lives in the sibling repo **`dsh-memory-hub-gui`** (Electron · Windows/macOS/Linux: six-line recall + why provenance / editing + supersede protocol / three-source import preview-commit / JSON + visual HTML export / full encryption-passphrase lifecycle / maintenance stats; 37 unit tests + 16-step headless E2E smoke with screenshot gate + tri-OS packaging matrix)
- [ ] Cross-platform GUI memory management (storage migration loop already ready)

## License

MIT
