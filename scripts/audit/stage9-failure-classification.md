# Stage 9 — Failure classification (RAG + LLM baseline)

**Date:** 2026-09-27  
**Repo:** sneak-peek-standalone  
**Harness:** `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test …`  
**ABI note:** `better-sqlite3` rebuilt for Electron ABI 148 (Stage 0).

## Labels

| Label | Meaning |
| --- | --- |
| **A** | Production bug |
| **B** | Compatibility bug |
| **C** | Test environment |
| **D** | Stale historical |
| **E** | Needs migration |
| **F** | Intentional fallback |
| **G** | Performance / test-duration |

## Counts

| Suite | Ran | Fail | A | B | C | D | E | F | G |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RAG (`electron/rag/__tests__/*.test.mjs`) | 565 | **64** | 0 | 0 | 4 | 51 | 9 | 0 | 0 |
| LLM baseline (known 9) | focused | **9** | 0 | 0 | 0 | 2 | 7 | 0 | 0 |
| **Combined** | — | **73** | **0** | **0** | **4** | **53** | **16** | **0** | **0** |

Audit text said “~60 RAG”; live Stage 9 re-run is **64** fails (500 pass). No production **A** bugs were clear *and* tiny/safe to fix in this stage — none committed.

**Suite-duration note (G, not a failure):** during the RAG run, Gemini key-pool logs showed `all keys cooling — waiting ~60000ms`. That is intentional 429/cooldown test behavior (audit §39). Do not “fix” it for speed alone.

**Do-nots honored:** no retired Knowledge API restores; TruncatedAnswer / Pronoun / Credentials not weakened; no quarantine without historical marker.

---

## LLM baseline failures (9)

| # | Test | File | Label | Why (one line) |
| --- | --- | --- | --- | --- |
| L1 | CredentialsManager only auto-replaces ids the app itself auto-assigns | `GroqReviewFixes2026_08_23.test.mjs` | **E** | Expects `AUTO_ASSIGNED_MODEL_IDS = new Set` in `CredentialsManager.ts`; allowlist gone after Natively-backend disable — migrate pin to current preferred-model policy. |
| L2 | candidate-ambiguous probes stay canned with NO profile | `ManualRealSessionFixes2026_06_12.test.mjs` | **D** | Expects `/I'm Natively/`; production canned reply is now `"I'm your AI assistant for this app."` (intentional copy). |
| L3 | assistant-meta probes stay canned even WITH a profile | `ManualRealSessionFixes2026_06_12.test.mjs` | **D** | Same stale “I'm Natively” / Evin-John string expectations after identity-copy change. |
| L4 | flag ON: shadow-divergence/agreement + byte-identical return | `PronounRegexShadowDivergence2026_07_26.test.mjs` | **E** | Flag `pronounRegexShadowObservation` still registered; no production `[PronounRegexShadow]` emitter remains — restore wiring or migrate/retire with historical marker. |
| L5 | flag ON: shadow trace names both gate decisions | `PronounRegexShadowDivergence2026_07_26.test.mjs` | **E** | Same missing shadow emitter as L4; do not delete assertions without root-cause decision. |
| L6 | RAGRetriever default is byte-identical to legacy (0.25) | `SpaceAwareThresholds2026_08_13.test.mjs` | **E** | Stub only mocks `searchSimilar`; hybrid `retrieve()` now calls `searchLexical` first and throws before semantic — migrate harness to hybrid stubs + `retrieve(q, { meetingId })`. |
| L7 | the answer-side region is delimited | `TruncatedAnswerNotStored2026_08_12.test.mjs` | **E** | Production still gates sinks on `!v3Truncated`; test looks for `// ── ANSWER-SIDE SINKS…` but source uses spaced `// ─ ─ ANSWER-SIDE SINKS…`. |
| L8 | answer-side sinks are gated on the outcome | `TruncatedAnswerNotStored2026_08_12.test.mjs` | **E** | Cascades from L7 (`ANSWER_SIDE_REGION.text` is null); production `recordAnswerSummary` / `_manualConversationMemory.record` still inside `if (!v3Truncated)`. |
| L9 | the truncated branch marks the entry synthetic | `TruncatedAnswerNotStored2026_08_12.test.mjs` | **E** | Production still sets `synthetic: true` on truncated `pushUsage`; test’s exact indented `indexOf` string no longer matches reformatted ipcHandlers. |

---

## RAG failures (64)

### CrossFeatureReindexConcurrency.test.mjs (2) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R01 | both jobs run concurrently and converge without corrupting each other | **D** | `SQLITE_ERROR` against retired Knowledge node/table contract (`saveNodes` / profile schema). |
| R02 | knowledge re-embed failing does NOT stall or corrupt the meetings reindex | **D** | Same Knowledge stub / missing tables; meetings half is not the failure mode. |

### IngestConcurrencyStarLoss2026_08_02.test.mjs (2) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R03 | a re-upload during STAR generation does not orphan the first ingest's nodes | **D** | `Cannot read properties of undefined (reading 'bind')` — old Knowledge DB bind API. |
| R04 | a résumé and a JD still ingest concurrently — only same-type writers queue | **D** | Same retired bind/writer contract. |

### IngestInFlightSurvivesPanelClose2026_08_02.test.mjs (3) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R05 | isIngesting(RESUME) is true while indexing and false once it lands | **D** | `orch.isIngesting is not a function` — API retired with Knowledge stub. |
| R06 | stays true across a queued same-type ingest, then clears | **D** | Same missing `isIngesting`. |
| R07 | clears when the ingest fails, so the panel cannot hang on "processing" | **D** | Same missing `isIngesting`. |

### KnowledgeDegradeToLocal.test.mjs (8) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R08 | cloud healthy → converges corpus to cloud space, commits \_indexSpace=cloud | **D** | `SQLITE_ERROR` / `profile_documents` — retired Knowledge persistence. |
| R09 | cloud DOWN + local available → degrades ENTIRE corpus to local | **D** | Same retired Knowledge storage. |
| R10 | degrade moves even already-cloud-converged nodes to local | **D** | Same. |
| R11 | cloud DOWN + NO local → does not commit a space | **D** | Same. |
| R12 | recovery: after a degrade, later pass restores cloud | **D** | Same. |
| R13 | already fully in active space → no-op idempotent | **D** | Same. |
| R14 | debounce: rapid second call skipped | **D** | Same. |
| R15 | debounce does NOT block recovery from degraded corpus | **D** | Same. |

### KnowledgeIngestSpaceMetadata.test.mjs (1) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R16 | cloud→local fallback during ingest stamps saved nodes with local space | **D** | `no such table: profile_documents`; do not restore Knowledge APIs for green. |

### KnowledgeReembedIntegration.test.mjs (18) — **D**×16 + **E**×2

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R17 | stale v1 nodes get re-embedded into the active v2 space | **D** | `SQLITE_ERROR` / retired node APIs. |
| R18 | partial embedFn failure leaves some stale → self-heals next pass | **D** | Same. |
| R19 | embedFn returning empty/non-array does NOT mark node done | **D** | Same. |
| R20 | \_reembedInFlight prevents concurrent second pass | **D** | Same. |
| R21 | no active space → ensureEmbeddingSpace no-op | **D** | Same. |
| R22 | no embedFn → ensureEmbeddingSpace no-op | **D** | Same. |
| R23 | all nodes already in active space → no embed churn | **D** | Same. |
| R24 | keyword-only nodes ALWAYS survive the gate | **D** | Same. |
| R25 | active-space nodes survive; v1 + NULL-space excluded | **D** | Same. |
| R26 | active space unset + mixed corpus → majority space gate | **D** | Same. |
| R27 | active space unset + single-space corpus → all survive | **D** | Same. |
| R28 | activeSpaceFn unset → NO gate | **D** | Same. |
| R29 | refreshCache fires ensureEmbeddingSpace fire-and-forget | **D** | Same. |
| R30 | in-flight guard + loop-until-empty mid-pass converge | **D** | Same. |
| R31 | DURING re-embed v1 excluded; AFTER included | **D** | Same. |
| R32 | uses fast local when its SPACE matches active | **E** | Pins `resolveQueryEmbedder` space-gating; method now treats `fastQueryEmbedFn` as a raw embedder (broken vs factory `{dimensions,space,embed}`) and is **uncalled** from production paths — migrate or restore+wire. |
| R33 | FALLS BACK to embedFn when local space != active despite equal dims | **E** | Same dead/broken `resolveQueryEmbedder` contract as R32. |
| R34 | active space unknown → falls back to legacy DIMENSION check | **D** | Hits SQLITE before assertion via retired node seed APIs. |

### KnowledgeReembedLoopBound.test.mjs (13) — **D**×6 + **E**×7

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R35 | embedFn that ALWAYS throws TERMINATES | **D** | `SQLITE_ERROR` on retired Knowledge node writes. |
| R36 | SELF-HEAL: failing call then later converges | **D** | Same. |
| R37 | embedFn failing first attempt then succeeding converges | **D** | Same. |
| R38 | MULTIPLE passes genuinely occur | **D** | Same. |
| R39 | BOUND CAP at MAX_REEMBED_PASSES | **D** | Same. |
| R40 | fast.dimensions == null → embedFn | **E** | `resolveQueryEmbedder` matrix row; production method no longer implements factory/space/dim guards (and is uncalled). |
| R41 | active unknown + empty corpus + fast dim → legacy allows fast | **E** | Same matrix migration as R40. |
| R42 | active unknown but corpus has committed space → query in THAT space | **D** | SQLITE via retired seed/persist. |
| R43 | cloud-active different dimensions → embedFn | **E** | Same `resolveQueryEmbedder` migration. |
| R44 | committed==local + fast null → [] (no cross-space) | **E** | Same. |
| R45 | committed==local + fast succeeds → fast used | **E** | Same. |
| R46 | fast null AND no embedFn → [] | **E** | Same. |
| R47 | cloud branch falls back to embedFn when no embedQueryFn | **E** | Same. |

### KnowledgeSpaceReembed.test.mjs (7) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R48 | schema has embedding_space; saveNodes persists + reads it | **D** | `kdb.saveNodes is not a function` — intentionally retired. |
| R49 | getNodesNeedingReembed sweeps OLD-space nodes | **D** | `saveNodes` retired. |
| R50 | getNodesNeedingReembed sweeps legacy NULL-space with embedding | **D** | SQLITE / retired APIs. |
| R51 | getNodesNeedingReembed ignores nodes with NO embedding | **D** | Same. |
| R52 | updateNodeEmbedding rewrites embedding + space | **D** | `saveNodes` retired. |
| R53 | all nodes already in active space → nothing to re-embed | **D** | `saveNodes` retired. |
| R54 | idempotent ALTER: initializeSchema twice | **D** | Stub path still trips on retired helpers. |

### LegacySqlSearchGuardCrossFeature.test.mjs (2) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R55 | separate tables: knowledge re-embed never reads/writes RAG meeting tables | **D** | `kdb.saveNodes is not a function`. |
| R56 | local-only 384d user triggers NEITHER reindex NOR re-embed | **D** | Same retired Knowledge API. |

### LocalEmbeddingProviderRealModel.test.mjs (2) — **C**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R57 | embed() delegates to real Worker and produces sane vectors | **C** | `insufficient available memory (<2GB) — skipping local embedder load` in this environment. |
| R58 | embedBatch() batches through the same worker round-trip | **C** | Same memory gate. |

### LocalRerankerPackagedBuildSimulation2026_07_25.test.mjs (2) — **C**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R59 | tokenizer.json, config.json, and quantized onnx exist | **C** | `resources/models/Xenova/bge-reranker-base/onnx/model_quantized.onnx` missing from checkout. |
| R60 | packaged-build simulation isCached()+rerank() runs | **C** | ENOENT copying missing onnx into temp resourcesPath layout. |

### SalaryEstimatePersistence2026_08_02.test.mjs (4) — **D**

| # | Test | Label | Why |
| --- | --- | --- | --- |
| R61 | fresh orchestrator serves persisted estimate cold | **D** | `SQLITE_ERROR` / missing `profile_documents` premium persistence. |
| R62 | persisted estimate for REPLACED résumé is rejected | **D** | Same. |
| R63 | no active résumé ⇒ no estimate (fail closed) | **D** | `saveSalaryEstimate is not a function` — retired API. |
| R64 | corrupt persisted row degrades to null | **D** | Same retired persistence surface. |

---

## A-bug triage (Stage 9)

| Candidate | Verdict | Action |
| --- | --- | --- |
| TruncatedAnswer / synthetic usage | **Not A** — production gating + `synthetic: true` still present | Follow-up **E**: update source-scan markers only after confirming contract. |
| PronounRegexShadow | **Not proven A** — flag remains, emitter absent | Follow-up **E**: restore observation or retire flag+tests with historical marker. |
| Credentials `AUTO_ASSIGNED_MODEL_IDS` | **Not proven A** — allowlist removed with Natively disable | Follow-up **E**: rewrite pin for current model-preference rules. |
| `resolveQueryEmbedder` space-gating | Implementation broken **and** uncalled from KO production paths; `main.ts` still wires `setFastQueryEmbedFn` | Follow-up **E** (or later **A** if a live caller is reattached): restore factory/space/dim logic *and* call site, or delete dead wiring. **Not tiny/safe for Stage 9.** |
| ManualRealSession canned copy | Intentional product string change | **D** — migrate expectations when ready. |
| Local embed/reranker assets | Env/asset | **C** — CI machine memory / model download. |

**A fixes committed this stage:** none.

---

## Follow-ups (do not quarantine here)

1. **E — TruncatedAnswer source-scan** (`TruncatedAnswerNotStored2026_08_12`): align delimiter/`pushUsage` string pins to current `ipcHandlers.ts` without relaxing `!v3Truncated` / `synthetic: true` assertions.
2. **E — PronounRegexShadow**: decide restore vs historical retire for `pronounRegexShadowObservation`.
3. **E — Credentials auto-assign allowlist pin**: replace `AUTO_ASSIGNED_MODEL_IDS` scan with current policy tests.
4. **E — SpaceAwareThresholds RAGRetriever harness**: stub `searchLexical` + pass `{ meetingId }`.
5. **E — Knowledge `resolveQueryEmbedder`**: either restore space-aware factory logic and wire a live caller, or mark tests historical and remove dead `setFastQueryEmbedFn` wiring in `main.ts`.
6. **D cluster — Knowledge/Ingest/Salary/LegacySql**: migrate or historically mark once Stage 10 reachability audit completes; **do not** restore `saveNodes` / `saveSalaryEstimate` / `isIngesting` for green.
7. **C — Local MiniLM / BGE assets**: ensure CI has ≥2GB headroom and reranker onnx present (or skip with explicit env marker).

---

## Commands executed

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/rag/__tests__/*.test.mjs
# → 565 tests, 500 pass, 64 fail (~63s)

ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test \
  electron/llm/__tests__/GroqReviewFixes2026_08_23.test.mjs \
  electron/llm/__tests__/ManualRealSessionFixes2026_06_12.test.mjs \
  electron/llm/__tests__/PronounRegexShadowDivergence2026_07_26.test.mjs \
  electron/llm/__tests__/SpaceAwareThresholds2026_08_13.test.mjs \
  electron/llm/__tests__/TruncatedAnswerNotStored2026_08_12.test.mjs
# → confirmed the known 9 baseline failures
```

Raw capture: `/tmp/rag-suite-stage9.txt`, `/tmp/llm-baseline-stage9.txt` (local; not committed).
