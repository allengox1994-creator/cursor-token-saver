# cursor-token-saver

English | [简体中文](README.zh-CN.md)

**A cognitive layer for Cursor's agent.** On one side, a content-addressed evidence store drives token usage to the floor — losslessly, with exact recovery on demand. On the other, verifiable semantic memory, a project world model and skill runbooks let the agent accumulate real understanding of your project across sessions. LLMs are stateless by nature; this system makes the agent **stateful inside your project**. Fully local, zero telemetry.

Core design principle: **defer transmission, never permanently delete information.** Source snippets and full command logs become local content with stable evidence IDs; the model gets a minimal first screen by default, and anything can be recovered exactly via `context_expand`. All budgets are soft, every block can be retried through, and every hook fails open.

## Concepts & principles

Token waste and cross-session amnesia are two faces of the same problem: LLMs are stateless, every request re-transmits the whole context, and everything resets to zero when the session ends. This tool attacks both sides at once —

**The saving side: a Content-Addressed Evidence Store.**
Everything that gets truncated, compacted or diffed is persisted by content hash with a stable evidence ID. The model receives only a minimal first screen (outline, diff, structural profile) by default; any line range can be recovered exactly by ID. What gets eliminated is the waste of "transmit everything by default" — with zero information loss.

**The remembering side: a three-layer memory structure** (mirroring the declarative/procedural split in cognitive science):

| Layer | What it stores | Where it comes from |
| --- | --- | --- |
| Semantic memory (facts) | Conventions, decisions, gotchas, entry points | Explicit `memory_save` by the agent + mechanical extraction from checkpoint decisions |
| World model (relations) | `entity —relation→ entity` triples: domain → port → service → script | Automatic scans of package.json / docker-compose / nginx / .env / CI |
| Skill memory (procedures) | Reusable runbooks: goal + successful command sequence | Mechanically extracted from the command timeline when a task wraps up; fail→fix journeys mined into gotchas |

**The trust anchor: Verifiable Memory.**
Memories carry evidence hashes — when a file changes, the memory is automatically flagged STALE. Mechanical extraction only produces *candidates*; nothing takes effect until the agent or a human confirms it. Long-unused entries are archived automatically; recurrence raises confidence. This machinery prevents "memory hallucination" from polluting future sessions: a memory system that blindly trusts whatever it stored eventually becomes a liability.

**The loop: perceive → remember → recall → act → feed back → learn.**
Hooks observe every file read and command run (perception), distill them into verifiable memory (learning), code search automatically fuses in relevant memories (recall), and the bootstrap warm-start pack restores full task state in a few hundred tokens (continuity). The result: the agent gets **cheaper and smarter in your repo, session after session**.

### Architecture diagram

![Architecture diagram](https://raw.githubusercontent.com/allengox1994-creator/cursor-token-saver/main/site/architecture-en.svg)

The loop: **perceive → remember → recall → act → feed back → learn**. The thick green line is the lossless reinjection path — the model receives only a minimal first screen plus evidence IDs; everything else is recovered exactly, on demand.

## Quick start

```bash
# run in your project root
npx cursor-token-saver init                 # install (standard profile)
npx cursor-token-saver init --profile extreme   # maximum savings

npx cursor-token-saver dashboard            # global dashboard at http://localhost:4517 (all projects)
npx cursor-token-saver report --all         # global summary in the terminal
npx cursor-token-saver report               # current project stats
npx cursor-token-saver index                # optional: pre-build the neural embedding index
npx cursor-token-saver eval --limit 50      # optional: offline retrieval-quality evaluation
npx cursor-token-saver daemon               # optional: start the global model daemon manually (usually automatic)
npx cursor-token-saver start-all            # after a reboot: start all resident services in one shot
```

Cursor picks the hooks up automatically after install (check Settings → Hooks; restart Cursor if needed). Requires Node >= 18 on PATH.

## What the hooks intercept

| Hook | Event | Behavior |
| --- | --- | --- |
| read-guard | preToolUse (Read) | Full reads beyond the line cap → blocked with the line count and suggested reading strategy; rapid re-reads of unmodified files → blocked with pointers; **re-reads after a file changed transmit only a lossless line diff** (old content + diff = new content; the full snapshot stays recoverable by ID). **Anti-lockout: if the agent immediately retries the same file, it is force-allowed** (reads within 25% of the cap pass straight through to avoid boundary friction) |
| file-blocklist | beforeReadFile | Blocks lockfiles, build output, minified bundles and oversized data files (data files are pointed to the `context_query mode=profile` structural profile). **Files the user explicitly attaches with @ always pass** |
| shell-guard | preToolUse (Shell) | Whitelisted noisy commands are captured in full as local artifacts; Jest/Vitest, Pytest, Cargo, Go test and compiler logs show only failure summaries / relevant stack traces first; **re-running the same command (the classic edit → re-test loop) returns only a lossless diff against the previous output — a single marker line if byte-identical**. **Pure `&&` chains whose every segment is whitelisted (e.g. `npm run build && npm test`) are governed as a whole.** Anything omitted is recoverable by ID. Commands with pipes/redirection are left untouched |
| edit-invalidate | afterFileEdit | Allows re-reads after edits and keeps the read snapshot so the re-read goes through incremental diffing (prevents false blocks; read-guard has an mtime fallback of its own) |
| shell-audit | afterShellExecution | Pure stats: records command output volume to identify noise hogs |
| mcp-audit | afterMCPExecution | Pure stats: records output volume of other MCP tools (repo-map's own calls are recorded server-side) |
| session-track | sessionStart / stop / preCompact | Session stats; on context compaction, nudges that "a fresh session is cheaper" |

`init` also writes:

- `.cursor/mcp.json`: registers the repo-map MCP server (see below)
- `.cursor/rules/token-saver.mdc`: one compact token-efficiency rule (locate via repo map / search first, read compactly, delegate exploration to subagents, prefer a fresh session once a task converges, plan large tasks first)
- `.cursorignore`: a static low-value list (lockfiles, build output, fonts, archives, …) plus scanned oversized files, kept inside a marker block that never touches your own content. After install, sessionStart rescans every 24 hours and folds newly grown data/log files into the block automatically

## MCP repo map (the proactive side: cheaper ways to get information)

Hooks are the "dam"; the unified context MCP is the "channel". `init` registers a zero-dependency local MCP server (`node .cursor/hooks/token-saver/mcp-repo-map.mjs`; enable it once under Settings → MCP). Tool definitions are themselves a fixed per-request cost, so `tools/list` exposes only 4 unified lossless tools by default; 5 legacy tools (`repo_map`/`file_outline`/`smart_search`/`semantic_search`/`read_compact`) stay hidden but still answer `tools/call`, and `contextQuery.legacyTools=true` restores them:

| Tool | What it does | Where it saves |
| --- | --- | --- |
| `context_query` | Unified entry point: `search` runs exact string, BM25 and local neural vectors with RRF fusion; plus `map`, `outline`, `callgraph`, `read` (with `symbol` skeleton reads), `profile` (data-file profiling), `diff`, `lsp`, `bootstrap` modes | First screen returns short previews and stable evidence IDs; on low confidence / recent test failures it widens internal candidates without shipping the noise to the model |
| `context_expand` | Expands an evidence ID through `preview` / `compact` / `exact` / `full`, or reads full logs by regex or line range | Compressed results always have an exact-text fallback; stale IDs after source changes are reported explicitly, preventing use of outdated evidence |
| `context_checkpoint` | Saves/restores goal, status, touched files, decisions and open questions | Compaction or a new session doesn't require replaying the whole conversation |
| `repo_map` | Whole-repo symbol map: class/function signatures + line numbers, ranked by **import-graph PageRank** (★ marks core files, which show more symbols), with subdirectory focus and a character budget | Replaces "read a pile of files to understand the project" — one call turns thousands of tokens into hundreds |
| `file_outline` | Full single-file outline (symbols + line numbers) | Outline first, then read exact ranges — replaces full reads |
| `smart_search` | Exact, compact search returning only `path:line: matching line` (ripgrep preferred, built-in scanner fallback) | Replaces exploratory reads done just to locate code |
| `semantic_search` | Concept-level search: **local neural embeddings + BM25 hybrid** (RRF fusion) for queries like "where is login handled" | Replaces multi-round trial-and-error grep |
| `read_compact` | Compact reads: strips comments/blank lines, folds long literals, keeps **original line numbers** with exact evidence IDs, supports start_line/end_line | Typically another 25–50% off source files; comments/literals recoverable by ID when they matter |

Symbol extraction is a zero-dependency regex approach covering JS/TS/Python/Go/Rust/Java/Kotlin/Swift/C#/Ruby/PHP/C/C++. `callgraph` is an approximate import/reference graph that states its confidence limits — it does not impersonate a compiler-grade call graph. Every query's evidence is recorded in `.cursor/token-saver/context-store/manifest.json`; for source code only path, range, stamp and SHA-256 are stored — only full logs go into `blobs/`.

### Lossless dedup, soft budgets and log artifacts

- Content already transmitted and unchanged within a conversation returns just `already_sent` + ID; changed files get new IDs.
- **Read-only tool result dedup**: when `repo_map`/`file_outline` etc. produce byte-identical results within 10 minutes (`contextQuery.toolDedupeMs`), only a one-line "unchanged" marker + artifact ID is returned; the full result stays recoverable by ID from any session. `context_expand`/`context_checkpoint` are never deduped.
- **Warm-start pack for new sessions**: `context_query {"mode":"bootstrap"}` returns the latest checkpoint, Git-changed files, recent failed commands and recent evidence IDs in a few hundred tokens — a follow-up session doesn't re-explore. sessionStart auto-hints when a checkpoint exists within 48 hours.
- **Symbol-level skeleton reads**: `context_query {"mode":"read","file":"...","symbol":"..."}` returns the target function/class in full while folding the rest of the file into a one-line-per-symbol skeleton — 60–80% cheaper than a full read, any range expandable afterwards.
- **Data-file profiling**: `context_query {"mode":"profile","file":"..."}` returns a structural overview (keys/types/row counts/samples) + evidence ID for JSON/JSONL/CSV/TSV/YAML; exact records recoverable by regex/line range. A large JSON goes from hundreds of thousands of tokens to a few hundred.
- Tool output accrues against a per-session soft budget. Past the warning ratio only subsequent **first screens** shrink — `context_query`'s character budget halves and governed commands' head/tail lines halve — `context_expand exact/full` is never restricted.
- Full stdout/stderr of noisy commands is stored as context-store artifacts; default retention 7 days / 512MB max, with TTL/LRU cleanup at sessionStart.
- `preCompact`, file edits and stop maintain deterministic mechanical checkpoints; the agent adds true semantic decisions via `context_checkpoint` — the tool never fabricates summaries.
- Configuration lives in the `contextQuery`, `artifactStore` and `taskBudget` sections; the dashboard's Context page shows evidence, artifact, budget and checkpoint stats.

### Project semantic memory (stop re-exploring across sessions)

The biggest hidden waste in a new session is relearning the same engineering facts. The memory system persists them:

- **Write**: the agent uses `memory_save` for conventions/decisions/gotchas/entry points (optionally linked to files). Four mechanical extraction channels produce **candidates only**, which take effect after confirmation — `context_checkpoint` decisions; **fail→fix** (when the same command flips from failing to passing with file edits in between, "command X failed, passed after editing A and B" is recorded automatically); **runbooks** (when a checkpoint marks a task complete, the exit-0 command sequence is extracted as a reusable skill, with recurrence raising confidence); **world-model scans** (throttled to 24h, scanning package.json / docker-compose / nginx / .env / CI for `entity —relation→ entity` triples). The machine never fabricates and never self-confirms.
- **Recall**: `context_query {"mode":"memory","query":"..."}` searches by relevance (word-level for English, bigram for Chinese); `{"mode":"world","query":"9501"}` walks the relation subgraph from an entity (1–2 hops — one triple line replaces hundreds of config lines); `bootstrap` includes top entries automatically; `mode=search` code results automatically carry highly relevant memories (retrieval fusion, zero extra calls).
- **Verifiable**: file-linked memories store content hashes; recall flags `STALE` explicitly after the file changes, and `memory_save action=confirm` re-confirms against current content — preventing memory hallucinations from polluting future sessions.
- **Consolidation**: `memory_save action=merge ids=[...] text="..."` lets the agent merge related entries into one refined memory; originals are archived with `mergedInto` provenance.
- **Scope**: project-level by default; `scope=global` stores to `~/.cursor-token-saver/` for cross-project recall (personal preferences). Global memories carry no file links and never go stale.
- **Governance**: similar entries auto-merge; long-unrecalled ones auto-archive (recoverable, not deleted); candidates expire after 14 days unconfirmed; total count is capped. The dashboard's Memory page includes effectiveness metrics (active/candidate counts, total recalls, never-recalled, expiring candidates, relation/skill counts and skill reuse) with view/confirm/edit/archive/restore/delete.
- Configured in the `memory` section (`enabled`/`maxActive`/`decayDays`/`bootstrapMax`).

### Diff, LSP, test selection and offline evaluation

- `context_query {"mode":"diff"}` stores the full Git patch as an artifact; the first screen returns only changed files, hunks and current source evidence IDs. Non-Git projects fall back explicitly to plain map/search.
- `context_query {"mode":"lsp","file":"...","symbol":"..."}` calls your locally installed `typescript-language-server`, `pyright-langserver`, `rust-analyzer` or `gopls` on demand for references/definitions. Default 1.5s timeout with a circuit breaker; missing or failing servers fall back immediately to the existing import/exact-text graph.
- `test_select {"phase":"iterate"}` picks relevant tests from Git changes, direct naming and reverse imports; on low confidence it returns the full-suite command outright, and when selected tests fail it offers the full-suite fallback. Call `phase=final` before handoff — it always returns the complete suite.
- After a real index build or incremental refresh, an offline evaluation is scheduled automatically: 2-minute delay, background low priority, at most once per 24h per project, with a cross-process lock. If the MCP exits mid-way the schedule resumes on next start; failures only write status and never affect retrieval.
- `cursor-token-saver eval --dir . --limit 50` still works for an immediate manual run. It builds a query→expected-file dataset from real symbols and reports Hit@1, Hit@5, MRR to `.cursor/token-saver/eval-report.json`.
- Auto-eval settings live in `embedding.autoEval`, `embedding.autoEvalIntervalHours`, `embedding.autoEvalLimit`, editable from the dashboard with schedule/run/failure status.

### Global index daemon

Neural embeddings connect to a global daemon at `127.0.0.1:4518` by default, so every project shares one model instance while each project keeps its own vector index. It starts automatically on first retrieval; connection, startup or inference failures fall back instantly to in-project transformers → Ollama → BM25, never losing capability. Manual start:

```bash
cursor-token-saver daemon --port 4518
```

Config: `embedding.useGlobalDaemon=false` disables it, `embedding.daemonPort` changes the port. The daemon listens on loopback only; no source code leaves your machine.

### One-shot startup after a reboot

Double-click `start-all.command` in the source directory, or run:

```bash
./start-all.sh
# or, if installed globally:
cursor-token-saver start-all
```

This idempotently starts the global dashboard (which serves the frontend, port 4517) and the global index daemon (port 4518); already-running services are not started twice. Logs live in `~/.cursor-token-saver/logs/`. Project-level MCP servers don't belong in the script — Cursor starts them when the project opens.

### Semantic search (neural embeddings)

`semantic_search` uses fully local neural embeddings (transformers.js + ONNX); code never leaves your machine. The default model is the multilingual `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (~120MB quantized, works for both English and Chinese queries); English-only projects can switch to `Xenova/all-MiniLM-L6-v2` (~23MB):

- **Indexing**: chunks along symbol boundaries (≤60 lines each), Int8-quantized vectors in `.cursor/token-saver/embed-index.json`, incrementally updated by mtime — only changed files are re-embedded
- **Model cache**: `~/.cursor-token-saver/models/`, shared by all projects, downloaded once; behind restrictive networks use `HF_ENDPOINT=https://hf-mirror.com`
- **Fully automatic**: the MCP server (resident while the project is open in Cursor) builds the index ~45s after start, then runs a cheap staleness check every 5 minutes (file stats only), re-embedding incrementally on change — **no manual `index` runs needed**; `semantic_search` calls also refresh in place. `cursor-token-saver index` remains available for pre-building. Disable per-project with `"embedding": { "autoIndex": false }`
- **Fallback chain**: transformers.js → (if unavailable) Ollama (`nomic-embed-text`) → BM25 — never dead
- **Config**: the `embedding` section of `.cursor/token-saver.json`: `{ "backend": "auto|transformers|ollama|off", "model": "...", "ollamaModel": "..." }`

Note: the scripts copied into your project remain zero-dependency; the neural-embedding dependencies live in the installed package (`init` records the package path in `.cursor/token-saver/pkg.json`). If the package is removed or moved, the fallback chain kicks in automatically.

## Three aggressiveness profiles

| Profile | Read cap | Re-read window | Data-file threshold | Command output governance |
| --- | --- | --- | --- | --- |
| conservative | 1500 lines | off | 1 MB | off |
| standard (recommended) | 800 lines | 15 min | 512 KB | head 50 / tail 100 lines |
| extreme | 400 lines | 45 min | 128 KB | head 30 / tail 60 lines |

Config lives in `.cursor/token-saver.json`; dashboard edits take effect immediately (hooks re-read config on every run). Each hook can be toggled and each threshold overridden individually.

## Stats and the global dashboard

Every block/truncation event is appended to each project's own `.cursor/token-saver/stats.jsonl` (data never leaves the project; delete the project, delete the data). Each `init` and session start registers the project in the global registry `~/.cursor-token-saver/projects.json`.

**The dashboard is global**: run `npx cursor-token-saver dashboard` from anywhere for an aggregate view of all registered projects (total savings, project overview table, cross-project trends/distributions/top lists, recent events with a project column); switch to a single project from the top-left for details and configuration. Config stays per-project; deleted projects are cleaned from the registry automatically. Only one dashboard instance is needed.

There's also an **Index page**: pick a project to inspect its embedding index — model, files/chunks indexed, index size and update time, plus per-file status (fresh / pending / unindexed / deleted) with path filtering. Pending files are refreshed incrementally by the MCP server; no manual action needed.

The Index page includes an **auto-index status card**: every automatic check/rebuild writes a heartbeat to `.cursor/token-saver/embed-status.json` (pid, last check/rebuild time, files re-embedded), from which the dashboard shows whether auto-indexing is "running" or "stopped" — "stopped" means that project's MCP server isn't running; restart Cursor or refresh it under MCP settings.

There's also a **Waste Insights page**: it mines the past 7 days of events for "money left on the table" — files repeatedly re-read in full, noisy commands outside the whitelist, files overridden after blocking — with matching calibration advice (adjust windows, caps, use profiling, etc.). This page saves nothing by itself, but keeps every threshold and whitelist calibrated against real usage.

**Script copies auto-upgrade**: after updating the package, the hook scripts copied into each project sync to the latest version at the next session start (`session-track` compares against the package source referenced in `pkg.json` and re-copies on drift, logged as a "script auto-upgrade" event). Note the resident MCP server process needs a restart (restart Cursor or refresh MCP) to run new code.

Note: hooks can't see billing-grade token counts, so savings are estimates: where original text is available, a **CJK-aware estimate** is used (CJK ≈ 1 token per char, otherwise ≈ 3.9 bytes per token); where only byte counts exist, **bytes / 4**; the `context_tokens` in `preCompact` events is the real value reported by Cursor.

## Benchmarks (honest methodology)

`cursor-token-saver bench` replays six typical agent operations on your real codebase (structure browsing, close reading, unchanged re-read, post-edit re-read, repeated commands, data files), compares "raw full transmission" against "tool first screen" token volumes, prints the comparison table and writes `.cursor/token-saver/bench-report.json`. The report carries its own methodology statement: it measures transport-layer tokens, not API billing; scenarios are computed independently; every compression is losslessly recoverable. Marketing quotes must include the methodology.

## Licensing (commercial component)

`cursor-token-saver license` provides offline licensing: Ed25519 signature verification, **no network activation, no telemetry**. `activate <key>` to activate, `status` to inspect, `deactivate` to remove; the vendor side issues with `issue --email ... --plan pro|team --days 365` (private key at `~/.cursor-token-saver/vendor-private.pem` — **never commit it, always back it up**). The free tier is fully functional today; license status is informational until paid features (memory sync, team memory vaults) land, gated by `licenseStatus()`.

Landing page: <https://allengox1994-creator.github.io/cursor-token-saver/> (source in `site/`, auto-deployed on push to main). Repository: <https://github.com/allengox1994-creator/cursor-token-saver>. Contact: <allengox1994@gmail.com>.

## Why this doesn't weaken the agent

- Truncation never loses information: the full content still exists (files on disk / logs persisted) — "push everything" merely becomes "pull on demand"
- Every block carries directions, so the agent knows exactly how to get what it needs next
- Range reads, user-attached files and complex shell commands always pass
- Every hook fails open: crashes and timeouts never block the agent
- A more focused context usually **improves** answer quality (attention dilution in long contexts is a well-documented problem)

## Limitations

- shell-guard command rewriting supports macOS / Linux only (skipped automatically on Windows; other hooks unaffected)
- Savings are estimates, not billing figures
- Dashboard charts use the Chart.js CDN; offline, charts degrade while tables and config keep working

## Uninstall

Delete `.cursor/hooks/token-saver/`, `.cursor/rules/token-saver.mdc` and `.cursor/token-saver*`, then remove entries containing `hooks/token-saver/` from `.cursor/hooks.json`, the `repo-map` entry from `.cursor/mcp.json`, and the marker block from `.cursorignore`. The global registry lives in `~/.cursor-token-saver/`; deleted projects are cleaned up automatically, or remove the whole directory.
