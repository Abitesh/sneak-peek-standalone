# Stage 10 — Legacy Mode retrieval reachability audit

**Date:** 2026-09-27  
**Repo:** sneak-peek-standalone  
**Scope:** Direct Mode retrieval / legacy RAG callers only.  
**Do-nots honored:** no ModeHybridRetriever / ModeContextRetriever / ModeRagAdapter / mode-retrieval-port / EvidenceResolver hybrid-dep / Change 45 keep-gate table drops; Mode status writers stay (9D NO-GO); Knowledge APIs not restored.

## Labels

| Label | Meaning |
| --- | --- |
| **LIVE** | On a production answer / indexing / V3 path today |
| **FALLBACK** | Production-reachable only after universal / primary path empty or throws |
| **COMPATIBILITY** | Kept seam / bridge / keep-gate; may be thin or unused as a *caller* but must not be deleted |
| **TEST** | Test, e2e IPC, harness, or source-scan pin only |
| **DEAD** | No production import/call path; safe to remove caller (not kept seams) |

## Counts (unique call sites / seams audited)

| Label | Count |
| ---: | ---: |
| LIVE | 14 |
| FALLBACK | 4 |
| COMPATIBILITY | 8 |
| TEST | 22 |
| DEAD | 2 |
| **Total** | **50** |

Counts are **sites** (a production file with N call sites counts N). Kept seams that are both definitions and callers are listed once under COMPATIBILITY when they are the seam itself, and their production *callers* under LIVE/FALLBACK.

---

## Kept seams (do not delete)

| Seam | Label | Why |
| --- | --- | --- |
| `ModeContextRetriever` | COMPATIBILITY | Shared lexical + hybrid host; ModesManager singleton owns the live instance |
| `ModeHybridRetriever` | COMPATIBILITY | Hybrid FTS+vector engine; also Mode status writers (9D NO-GO) |
| `ModeRagAdapter` | COMPATIBILITY / LIVE | Universal `RAGManager` mode-reference source adapter |
| `mode-retrieval-port` (`createModeRetrievalPort`) | COMPATIBILITY / LIVE | V3 RetrievalPort factory over `retrieveHybridRaw` |
| EvidenceResolver `hybridRetriever` dep | COMPATIBILITY / LIVE | Intentional raw hybrid dependency for governed turns |
| Change 45 keep-gate tables/writers | COMPATIBILITY | Storage + `mode_reference_index_state` writers stay |

---

## LIVE — production callers

| # | Site | Mechanism | Notes |
| --- | --- | --- | --- |
| L1 | `RAGManager` → `ModeRagAdapter.retrieve` | `retrieveHybridRaw` | Universal search `mode-reference` |
| L2 | `IntelligenceEngine.v3ModeRetrievalContext` | `createModeRetrievalPort` → `retrieveHybridRaw` | Shared V3 port for WTA / manual / proactive |
| L3 | `IntelligenceEngine` multi-family / doc-grounded | `new EvidenceResolver({ hybridRetriever: retrieveHybridRaw })` | Governed reference family |
| L4 | `WhatToAnswerLLM` governed path | `EvidenceResolver` + `retrieveHybridRaw` | When no pre-seeded pack |
| L5 | `LLMHelper._streamChatInner` Context-OS govern | `EvidenceResolver` + `retrieveHybridRaw` | Governed doc turns |
| L6 | `ipcHandlers` TurnEvidenceCoordinator | `EvidenceResolver` + `retrieveHybridRaw` | Manual multi-family reference |
| L7 | `LLMHelper.retrieveUniversalModeContext` / `retrieveUniversalChatContext` | `ragManager.search` → ModeRagAdapter | Primary app retrieval |
| L8 | `IntelligenceEngine.retrieveUniversalModeContext` / `retrieveUniversalChatContext` | same | Prefetch + doc-grounded validator path |
| L9 | `ipcHandlers` V3 manual chat | `RAGManager.createRAGRetrievalPort` / mode-reference allowlist | Uses ModeRagAdapter indirectly; imports `detectDocumentStatus` / `attachmentSourceTypeExtensions` from mode-retrieval-port |
| L10 | `ModesManager.retrieveHybridRaw` | `ModeContextRetriever.retrieveHybrid` | Shared choke point |
| L11 | `ModesManager.buildRetrievedActiveModeContextBlock` | `ModeContextRetriever.retrieve` (lexical) | Sync lexical; still used by hybrid fallbacks + validator |
| L12 | `ModesManager.buildRetrievedActiveModeContextBlockHybrid` | hybrid then lexical | Definition; called by FALLBACK + TEST |
| L13 | `mode-retrieval-port` retrieve fn | `retrieveHybridRaw` | Factory body |
| L14 | Mode indexing path (`indexReferenceFile` / prewarm / retry) | `ModeHybridRetriever.indexFile*` | Not answer retrieval; still LIVE for corpus |

---

## FALLBACK — production, secondary only

| # | Site | Mechanism | Notes |
| --- | --- | --- | --- |
| F1 | `LLMHelper` non-streaming 47ZF | `resolveManualDocumentGroundedContextWithLegacyFallback` → `buildRetrievedActiveModeContextBlockHybrid(...)` | Once, when universal empty/throws (Stage 6) |
| F2 | `LLMHelper` streaming 47ZF | same + pinned mode id | Same contract |
| F3 | `ModesManager.buildRetrievedActiveModeContextBlockHybrid` internal | falls through to `buildRetrievedActiveModeContextBlock` | Lexical when hybrid `usedFallback` / throw |
| F4 | `ipcHandlers` doc-grounded validator re-retrieve | `buildRetrievedActiveModeContextBlock` (lexical) | Only when EvidenceResolver pack + `retrievedBlockRaw` both absent |

---

## COMPATIBILITY — keep (not callers to delete)

| # | Item | Notes |
| --- | --- | --- |
| C1 | `ModeContextRetriever` / `ModeHybridRetriever` modules | Keep-gate engines |
| C2 | `ModeRagAdapter` | Keep-gate adapter |
| C3 | `mode-retrieval-port.ts` | Keep-gate V3 factory |
| C4 | `legacy-retrieval-port.ts` | Shared V3 auth filter; Mode/Meeting/Personal/Profile ports + RAGManager |
| C5 | EvidenceResolver hybrid dependency contract | Explicit keep |
| C6 | Change 45 / 9D Mode status writers + tables | NO-GO stop |
| C7 | `EvidenceOrchestrator` class | **No production `new EvidenceOrchestrator` / `buildEvidencePack`**; `parseModeSnippets` still LIVE from this file — keep module |
| C8 | `ModesManager` hybrid/lexical public API surface | Required by FALLBACK + EvidenceResolver + ModeRagAdapter |

---

## TEST — harness / pins / e2e only

| # | Site | Notes |
| --- | --- | --- |
| T1 | `ipcHandlers` `__e2e__:inspect-retrieval` | Calls `buildRetrievedActiveModeContextBlockHybrid` — e2e only |
| T2–T12 | `electron/services/__tests__/Mode*.test.mjs`, `ModeHybrid*.test.mjs`, `HybridDocumentGroundingPath`, etc. | Direct retriever construction |
| T13–T16 | `electron/context-intelligence/__tests__/ModeRetrievalPort*`, Meeting*, Legacy* | Port stubs over `retrieveHybridRaw` |
| T17–T18 | `electron/llm/__tests__/EvidenceResolverWiringIdentity*`, WTA hybrid budget pins | Governed vs legacy identities |
| T19 | `electron/rag/__tests__/Stage647ZF*`, Change45/46 | Universal + keep-gate pins |
| T20 | `scripts/live-custom-mode-source-regression.js`, e2e/smoke/benchmark doc-grounded scripts | Manual harnesses |
| T21 | `scripts/Change48–52_*` apply/test | Historical migration scripts |
| T22 | Stale source-scan pins (still present, expect old wiring) | e.g. `WhatToAnswerSnapshotWiring` still matches `buildRetrievedActiveModeContextBlockHybrid(wtaPrefetchQuery…)` — TEST/stale (Stage 9 **D/E**). DocGroundedRetrievalFix LLMHelper/WTA hybrid pins updated this stage to match Change 50B / Change 48. |

---

## DEAD — no production path

| # | Site | Proof | Action |
| --- | --- | --- | --- |
| D1 | `electron/llm/modeHybridEligibility.ts` (`shouldUseHybridRetrieval` / `runHybridModeRetrieval` / `hybridRetrievalBudgetMs`) | Zero production imports; `Change50B_LLMHelper_UniversalRagBoundary.test.mjs` asserts LLMHelper must **not** call these; only `ModeHybridEligibility2026_08_13.test.mjs` + comments in scripts loaded the module | **Removed** this stage |
| D2 | `ModeHybridRetriever.markIndexed` / `removeFile` | 9D audit + grep: no production callers (`removeFile` tests-only) | **Not deleted** — methods on kept seam; document only |

---

## Explicit non-deletions

- No DROP of legacy RAG / mode_reference tables.
- Mode status writers (`updateIndexState`, `removeIndexState`, `ensureIndexTable`, `DatabaseManager.updateModeReferenceIndexState`) unchanged.
- Knowledge / OKF APIs not restored for green tests.
- FALLBACK 47ZF hybrid once-path kept (Stage 6 contract).
- `EvidenceOrchestrator` module kept for `parseModeSnippets` + COMPATIBILITY export surface.

---

## Deletions this stage

1. `electron/llm/modeHybridEligibility.ts` — DEAD orchestrator after Change 50B / universal boundary.
2. `electron/llm/__tests__/ModeHybridEligibility2026_08_13.test.mjs` — exclusive pin of D1.
3. `electron/services/__tests__/DocGroundedRetrievalFix.test.mjs` — replace three LLMHelper pins that required D1 with Change-50B / Stage-6 FALLBACK pins.

No other production callers removed.

---

## Commands / method

```text
rg buildRetrievedActiveModeContextBlockHybrid|retrieveHybridRaw|createModeRetrievalPort|ModeRagAdapter|runHybridModeRetrieval|EvidenceResolver
  across electron/ + scripts/ (excluding dist, node_modules)
Cross-check imports of modeHybridEligibility → production = 0
Cross-check EvidenceOrchestrator construction → tests only
```

Raw classification is this file; Stage 9 companion: `scripts/audit/stage9-failure-classification.md`.
