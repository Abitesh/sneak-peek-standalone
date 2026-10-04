# Natively Intelligence — Current Architecture Baseline & Safety Lock

**Change:** 1 — Current Architecture Baseline and Safety Lock  
**Audit date:** 2026-10-05  
**Status:** Baseline/audit only. No production runtime behavior is intentionally changed by this change.

## 1. Purpose

This document records the current answer-producing architecture before the Natively Intelligence rebuild.

The purpose is to establish a factual dependency map so later changes can migrate responsibilities deliberately rather than deleting or bypassing working behavior.

### Safety rules

- Do not reset, revert, stash, or overwrite the current uncommitted chat/RAG repair.
- Do not modify `electron/audio/SystemAudioCapture.ts` or the system-audio path as part of the intelligence rebuild.
- Do not delete `RAGManager`, `WhatToAnswerLLM`, `EvidenceResolver`, `IntelligenceEngine`, `IntelligenceManager`, `LLMHelper`, or any related subsystem merely because it is considered legacy.
- Any later deletion must first identify callers, imports, persistence contracts, IPC contracts, tests, behavior, and the replacement path.
- Provider switching must not occur after a generation has already committed visible output.
- This baseline is descriptive; architectural decisions belong to the rebuild plan, not to this audit document.

---

## 2. High-level current architecture

The current repository is a **hybrid intelligence architecture**, not one universal linear answer pipeline.

A simplified representation is:

```text
Renderer / UI surface
        |
        v
Preload API
        |
        v
Electron IPC
        |
        +-------------------------------+
        |                               |
        v                               v
Manual / Intelligence paths       Legacy/parallel RAG paths
        |                               |
        v                               v
Question / turn understanding      RAGManager / RAGRetriever
        |                               |
        v                               v
Context / source decisions         retrieval + prompt construction
        |                               |
        +---------------+---------------+
                        |
                        v
                 Prompt / context
                        |
                        v
                 LLM provider layer
                        |
                        v
                     stream
                        |
                        v
                   Renderer
```

The important finding is that the repository already contains pieces of the intended Natively Intelligence architecture, but they are not yet one enforced runtime path for every surface.

---

# 3. Primary answer-producing entry points

## 3.1 Manual typed chat

**Renderer → preload → IPC → `LLMHelper` → provider stream**

Current evidence identifies:

- Renderer/preload API: `electron/preload.ts`
  - `1796-1822`
  - `1890-2051`
- IPC registration:
  - `electron/ipcHandlers.ts:5834-5844`
  - channel: `gemini-chat-stream`
- Main implementation:
  - `electron/ipcHandlers.ts:5170-5855`
  - `_geminiChatStreamHandler`
- Provider/generation:
  - `electron/LLMHelper.ts:5017-5149`
  - `electron/LLMHelper.ts:8040-8190`
- Assistant persistence after completion:
  - `electron/ipcHandlers.ts:5771-5832`
  - `IntelligenceManager.addAssistantMessage(...)`

### Current runtime shape

```text
Chat UI
  -> preload electron API
  -> gemini-chat-stream IPC
  -> _geminiChatStreamHandler
  -> mode/question/source/routing setup
  -> LLMHelper.streamChat(...)
  -> routeWithScopeFallback(...)
  -> provider streaming
  -> gemini-stream-done
  -> assistant message persistence
```

**Important finding:** manual chat is not simply `RAGManager.query...`. It has a substantial intelligence/routing setup in the IPC handler before provider generation.

---

## 3.2 Manual fallback answer path

A second manual-answer entry exists:

```text
submit-manual-question
  -> IntelligenceManager.runManualAnswer()
  -> IntelligenceEngine.runManualAnswer()
```

Evidence:

- `electron/ipcHandlers.ts:10456-10471`
- `electron/IntelligenceManager.ts:330-335`
- `electron/IntelligenceEngine.ts:5856-5985`

This is a distinct answer-producing route and therefore must not be assumed to be dead code until its callers and surface usage are migrated.

---

## 3.3 What-to-Answer / live answer

Current evidence identifies:

```text
What-to-Answer trigger
  -> IntelligenceManager.runWhatShouldISay()
  -> IntelligenceEngine.runWhatShouldISay()
  -> WhatToAnswerLLM.generateStream()
  -> provider generation
```

Evidence:

- `electron/IntelligenceManager.ts:299-334`
- `electron/IntelligenceEngine.ts:1107-1175`
- `electron/llm/WhatToAnswerLLM.ts:1-260`

`WhatToAnswerLLM` is therefore a separate generation surface from ordinary manual chat.

---

## 3.4 Other intelligence answer generators

The current intelligence layer also exposes:

- `runFollowUp()`
- `runRecap()`
- `runClarify()`
- `runFollowUpQuestions()`

These are distributed across:

- `electron/IntelligenceManager.ts:299-350`
- `electron/IntelligenceEngine.ts:5476-5856`

They must be treated as separate answer-producing capabilities until their callers and final generation path are unified.

---

# 4. Question / turn understanding

The repository already has a dedicated question-understanding subsystem.

## Question resolution

`electron/context-intelligence/question/question-resolver.ts`

Responsibility observed:

- resolve the canonical question from manual input, selection, transcript, or follow-up
- apply explicit source/priority rules

## Turn classification

`electron/context-intelligence/question/turn-classifier.ts`

Responsibility observed:

- classify the turn
- determine relevant turn properties
- participate in the decision of whether retrieval/context is needed

## Conversation state

The current tree contains:

- `conversation-state.ts`
- `conversation-state-store.ts`

These are part of the context-intelligence question layer.

### Baseline conclusion

Question identity is already a distinct concern in the repository. It should not be recreated blindly in a new engine if the existing contracts can be migrated or consolidated.

---

# 5. Context and source routing

Current intelligence components include:

- `electron/intelligence/ContextRouter.ts`
- `electron/intelligence/ContextFusionEngine.ts`
- `electron/intelligence/ConversationMemoryService.ts`
- `electron/intelligence/MeetingMemoryService.ts`
- `electron/intelligence/LiveTranscriptBrain.ts`
- `electron/intelligence/LiveMomentRouter.ts`
- `electron/intelligence/SearchOrchestrator.ts`
- `electron/intelligence/PromptAssemblerV2.ts`

The `context-intelligence` subsystem also contains:

```text
context-intelligence/
  contracts/
  question/
  retrieval/
  policies/
  generation/
  orchestration/
  observability/
```

The important architectural observation is that the repository already contains many of the conceptual responsibilities required by the future Natively Intelligence Engine.

---

# 6. Current orchestration layer

The current tree contains:

```text
electron/context-intelligence/orchestration/engine-bridge.ts
electron/context-intelligence/orchestration/orchestrator.ts
```

`orchestrator.ts` is explicitly structured as a central decision pipeline and contains an `AnswerRequest` contract with information such as:

- request id / request sequence
- surface
- mode id
- scope
- session id
- user answer policy
- manual question
- transcript question
- question confidence
- follow-up state
- screen context
- attached documents
- attached file names

It also coordinates policy decisions such as answer policy, mode policy, source authority, turn classification, and follow-up handling.

### Architectural implication

The new Natively Intelligence Engine should **evolve/consolidate this existing orchestration work**, not create an unrelated second brain beside it.

---

# 7. Retrieval architecture

## 7.1 RAGManager

The current repository contains:

`electron/rag/RAGManager.ts`

The inspected codebase identifies it as a broad/universal retrieval engine. It coordinates retrieval planning, source adapters, deduplication/reranking, and relevance gating.

Related retrieval components include:

- `RAGRetriever.ts`
- `RagQueryPlanner.ts`
- `RagRelevanceGate.ts`
- `RagContextBuilder.ts`
- `resolveRagSearchSources.ts`
- `ModeRagAdapter.ts`
- `MeetingRagAdapter.ts`
- `PersonalRagAdapter.ts`
- `KnowledgeRagAdapter.ts`
- `VectorStore.ts`
- canonical RAG storage/services

## 7.2 Canonical RAG storage

The repository contains a canonical RAG schema/storage layer with document, revision, chunk, embedding-space, embedding, FTS/index-status, and indexing-job concepts.

This storage is infrastructure and must not be deleted as part of an intelligence-layer cleanup unless its consumers and replacement are proven.

## 7.3 Retrieval ports

The context-intelligence layer includes typed retrieval ports such as:

- `legacy-retrieval-port.ts`
- `meeting-retrieval-port.ts`
- `mode-retrieval-port.ts`
- `personal-file-retrieval-port.ts`
- `profile-retrieval-port.ts`

This is significant because retrieval can already be injected behind a typed boundary rather than hard-wired into orchestration.

---

# 8. Evidence / Context OS

The current repository contains a separate evidence-governance stack under:

`electron/intelligence/context-os/`

Important components include:

- `EvidenceResolver.ts`
- `EvidenceOrchestrator.ts`
- `evidencePack.ts`
- `evidencePackValidation.ts`
- `evidenceSufficiency.ts`
- `generationContext.ts`
- `promptRenderer.ts`
- `finalPromptValidation.ts`
- `ProfileEvidenceService.ts`
- `SourceAuthorityKernel.ts`
- `TurnEvidenceCoordinator.ts`
- `types.ts`

`EvidenceResolver` is a factual/evidence retrieval entry point for Context OS-governed paths.

### Baseline conclusion

Evidence governance is already a substantial subsystem. A new intelligence engine should consume a normalized evidence contract rather than bypassing evidence controls.

---

# 9. Prompt construction

The current repository has more than one prompt-construction surface.

Observed examples:

- `electron/llm/prompts.ts`
  - `buildRAGPrompt(...)`
- `electron/llm/WhatToAnswerLLM.ts`
- `electron/context-intelligence/generation/prompt-composer.ts`
- `electron/intelligence/PromptAssemblerV2.ts`
- Context OS `promptRenderer.ts`

This is one of the main reasons the current architecture is hybrid.

### Important invariant for future work

The target architecture should eventually have one governed answer-composition contract, even if individual context sources remain modular.

Do not delete the existing composers until the replacement has equivalent behavioral coverage.

---

# 10. Provider / generation layer

The main provider-facing generation abstraction is:

`electron/LLMHelper.ts`

The inspected call sites show:

- `streamChat(...)`
- provider routing/fallback logic
- Gemini streaming
- provider-specific generation paths

The repository also contains:

`electron/llm/ProviderRouter.ts`

and provider-related infrastructure such as:

- `providerRegistry.ts`
- `providerErrorClassifier.ts`
- `modelCapabilities.ts`
- `textStreamFallback.ts`
- `visionStreamFallback.ts`

### Architectural conclusion

The provider layer should remain a **generation service**, not become the intelligence brain.

The intelligence layer decides what context and answer shape are required; the provider layer executes generation.

---

# 11. Surface-by-surface baseline

| Surface | Current entry / path | Current status |
|---|---|---|
| Manual typed chat | preload → `gemini-chat-stream` → `_geminiChatStreamHandler` → `LLMHelper.streamChat` | **Verified live** |
| Manual fallback | `submit-manual-question` → `IntelligenceManager` → `IntelligenceEngine` | **Verified entry** |
| What-to-Answer | `runWhatShouldISay` → `WhatToAnswerLLM.generateStream` | **Verified live** |
| Follow-up | `IntelligenceManager.runFollowUp` / engine | **Verified entry** |
| Recap | `IntelligenceManager.runRecap` / engine | **Verified entry** |
| Clarify | `IntelligenceManager.runClarify` / engine | **Verified entry** |
| Follow-up questions | `runFollowUpQuestions` / engine | **Verified entry** |
| Meeting chat | Meeting/RAG surface using meeting retrieval/RAG infrastructure | **Existing parallel path; exact current IPC-to-renderer chain should be re-audited before migration** |
| Global chat | Global/RAG surface using global retrieval infrastructure | **Existing parallel path; exact current IPC-to-renderer chain should be re-audited before migration** |
| Mode/reference files | Mode reference ingestion + mode retrieval/evidence path | **Existing capability; exact final generation chain varies by path** |
| Personal / My Files | Personal knowledge/file ingestion + typed retrieval/legacy fallback | **Existing capability; final answer path varies** |
| Project-specific | Manual/context routing plus project-tagged retrieval/source policy | **Routing exists; treat as a scoped capability, not a separate provider** |
| Coding | Coding-specific planning/output policies and answer logic | **Existing specialized capability; final generation is distributed** |
| Screen context | Screen/vision context participates in answer requests and policies | **Existing capability; exact per-surface generation path varies** |
| Auto-answer | Dedicated auto-answer functionality/tests exist | **Existing capability; exact current answer-producing chain should be re-audited before migration** |
| Live transcript | Transcript → live intelligence/RAG indexing and live answer surfaces | **Existing capability; keep audio capture isolated** |

The rows marked “re-audit” are intentionally not presented as a false single chain. Change 1 establishes where the architecture is known and where deeper tracing is required before deletion/migration.

---

# 12. Existing parallel/legacy answer surfaces

The current codebase contains multiple answer-producing approaches:

1. Context Intelligence orchestration
2. Direct manual-chat IPC orchestration
3. `IntelligenceEngine` / `IntelligenceManager` capabilities
4. `WhatToAnswerLLM`
5. `RAGManager`-driven paths
6. Context OS evidence/prompt paths
7. Specialized coding/profile/vision paths

This confirms that the repository is currently in a **partial migration/consolidation state**.

The correct rebuild strategy is therefore:

```text
Existing working capabilities
          |
          v
Natively Intelligence Engine
          |
   +------+------+
   |             |
question     context plan
understanding    |
   |             v
   +--------> retrieval/evidence
                  |
                  v
             prompt/answer plan
                  |
                  v
              LLM router
                  |
                  v
               stream
```

RAG becomes a capability/tool of the engine rather than the definition of intelligence itself.

---

# 13. What is NOT safe to remove yet

The following must remain protected until later migration changes prove replacement behavior:

- `electron/rag/RAGManager.ts`
- `electron/rag/RAGRetriever.ts`
- canonical RAG storage/indexing
- `electron/intelligence/context-os/*`
- `electron/llm/WhatToAnswerLLM.ts`
- `electron/IntelligenceEngine.ts`
- `electron/IntelligenceManager.ts`
- `electron/LLMHelper.ts`
- `electron/context-intelligence/*`
- provider routing
- project/My Files retrieval adapters
- meeting/live retrieval infrastructure
- screen/vision intelligence
- audio/system-audio capture

---

# 14. Current architectural decision

Based on the current code evidence, **do not build a second competing intelligence brain**.

Instead:

### Natively Intelligence Engine should become the governing orchestration layer

It should eventually own:

1. Turn/question understanding
2. Conversation state selection
3. Context planning
4. Retrieval decision
5. Retrieval coordination
6. Evidence normalization
7. Answer-shape planning
8. Prompt assembly
9. Generation lifecycle
10. Provider selection/fallback policy

### Existing systems become capabilities behind it

- RAG → retrieval capability
- Context OS → evidence/governance capability
- personal knowledge → knowledge source
- project files → scoped knowledge source
- meeting memory → conversation/meeting context source
- screen/vision → context source
- provider layer → generation execution
- audio/transcription → input source

This preserves working functionality while moving toward the intended “Natively Intelligence is the brain” architecture.

---

# 15. Dependency/search audit targets

The following symbols are mandatory migration/audit targets:

```text
RAGManager
WhatToAnswerLLM
IntelligenceEngine
IntelligenceManager
orchestrator
engine-bridge
streamChatWithGemini
LLMHelper.streamChat
ProviderRouter
buildRAGPrompt
prompt-composer
PromptAssemblerV2
ContextFusionEngine
ContextRouter
EvidenceResolver
EvidenceOrchestrator
```

Every answer-producing call site must eventually be traceable to:

```text
surface
  -> intelligence entry
  -> turn/question understanding
  -> context/source decision
  -> retrieval/evidence if required
  -> answer/prompt composition
  -> provider generation
  -> stream lifecycle
```

---

# 16. Test coverage baseline

The repository contains extensive intelligence/RAG tests, including tests around:

- question resolution
- turn classification
- routing
- source authority
- prompt composition
- provider scope
- coding behavior
- screen/coding routing
- project/My Files routing
- RAG integration
- canonical hybrid search
- canonical evidence packs
- personal RAG
- meeting backfill
- streaming
- auto-answer
- What-to-Answer behavior

Examples visible in the current project tree include:

```text
context-intelligence/*/...
llm/__tests__/QuestionResolver.test.mjs
llm/__tests__/TurnClassifier.test.mjs
llm/__tests__/ProjectsMyFilesRouting2026_09_27.test.mjs
llm/__tests__/PromptComposition.test.mjs
llm/__tests__/SingleComposerInvariant.test.mjs
llm/__tests__/WiredSurfaceChain.test.mjs
rag/__tests__/CanonicalEvidencePack.test.mjs
rag/__tests__/CanonicalHybridSearch.test.mjs
rag/__tests__/CanonicalPersonalRagIntegration.test.mjs
services/__tests__/AutoAnswer.test.mjs
```

These tests are architectural constraints. Future changes should migrate behavior while preserving or replacing these contracts deliberately.

---

# 17. Safety lock for future changes

Before deleting or bypassing any current subsystem, the implementation change must document:

```text
1. Existing caller(s)
2. Existing imports
3. Existing IPC contract(s)
4. Existing DB/storage contract(s)
5. Existing tests
6. Existing user-visible behavior
7. Replacement implementation
8. Replacement contract compatibility
9. Proof that the replacement is active
10. Proof that no required surface still depends on the old path
```

Only after all ten are satisfied may the old implementation be removed.

---

# 18. Target architecture after the rebuild

This is the target direction, not a claim that it already exists:

```text
USER / TRANSCRIPT / SCREEN / CHAT
              |
              v
      NATIVE INTELLIGENCE ENGINE
              |
              v
       CONVERSATION STATE
              |
              v
       TURN UNDERSTANDING
              |
              v
        CONTEXT PLANNER
              |
       +------+------+
       |      |      |
       v      v      v
   history   RAG   screen/files/
                    profile/memory
       |      |      |
       +------+------+
              |
              v
         EVIDENCE PACK
              |
              v
      RESPONSE SHAPE PLAN
              |
              v
       PROMPT ASSEMBLER
              |
              v
        LLM PROVIDER ROUTER
              |
        +-----+-----+
        |     |     |
     Gemini Qwen  Groq
        |     |     |
        +-----+-----+
              |
              v
      GENERATION CONTROLLER
              |
              v
            STREAM
```

The key rule is:

> **RAG is a capability, not the brain. The provider is not the brain. The transcript is not the brain. The renderer is not the brain. Natively Intelligence Engine is the governing brain.**

---

# 19. Change 1 implementation scope

This Change 1 intentionally makes **documentation-only** changes.

### Created

```text
docs/NATIVELY_INTELLIGENCE_ARCHITECTURE_BASELINE.md
```

### Production runtime changes

```text
None.
```

### Audio changes

```text
None.
```

### RAG behavior changes

```text
None.
```

### Provider behavior changes

```text
None.
```

### IPC behavior changes

```text
None.
```

---

# 20. Next migration order

The baseline supports the following implementation order:

1. Define the Natively Intelligence contract.
2. Normalize structured conversation state.
3. Normalize transcript/recent-turn context.
4. Consolidate question/turn understanding.
5. Build the context planner.
6. Put retrieval behind a single intelligence-owned retrieval contract.
7. Normalize all retrieval output into one evidence pack.
8. Build one Natively prompt/answer composer.
9. Separate response-shape planning from provider execution.
10. Centralize generation/stream lifecycle.
11. Make the new engine the primary manual-chat path.
12. Add behavioral evaluation across existing surfaces.
13. Migrate meeting/live intelligence.
14. Migrate project/My Files/personal knowledge.
15. Put canonical RAG fully behind the engine.
16. Migrate legacy meeting/global RAG answer paths.
17. Remove duplicated decision logic only after migration proof.
18. Run full regression/build validation.
19. Delete obsolete architecture only after dependency proof.

---

# 21. Baseline conclusion

The current repository is not missing intelligence components; it has **too many partially overlapping intelligence, retrieval, evidence, prompt, and generation responsibilities**.

The rebuild should therefore be a controlled consolidation:

```text
CURRENT:
many intelligent components
        +
multiple answer surfaces
        +
multiple prompt/generation paths

TARGET:
one governing Natively Intelligence Engine
        +
modular context/retrieval/evidence capabilities
        +
one governed generation lifecycle
```

This baseline is the safety reference for subsequent changes.
