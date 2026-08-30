// electron/llm/promptBudget.ts
//
// Final input-budget guard applied just before a request is handed to the LLM
// client. getModelCapabilities (./modelCapabilities.ts) answers "what can this
// model hold"; this module answers "what actually fits THIS request, right
// now" — including provider-specific effective ceilings that sit BELOW the
// model's advertised context window (Problem 17/18: Groq's practical
// per-request input ceiling is far under the 128k context window
// modelCapabilities reports for its large-model tier, which is how a "hi"
// with an unrelated 10k-token context blob still passed the old
// `caps.maxContextTokens >= 100_000` no-op unfiltered).
//
// Pure, no IPC/filesystem — importable from tests without mocking anything.

import { estimateTokens, type ModelCapabilities } from './modelCapabilities';

// Practical effective INPUT ceiling per provider, independent of the model's
// advertised context window. Only providers with a known real-world gap are
// listed; everything else falls back to caps.maxContextTokens.
const PROVIDER_INPUT_CEILINGS: Readonly<Record<string, number>> = {
  groq: 8000,
};

export function resolveProviderCeiling(provider: string | null | undefined): number | undefined {
  return provider ? PROVIDER_INPUT_CEILINGS[provider] : undefined;
}

export interface PromptLayer {
  /** Stable id for logging/telemetry, e.g. "history", "fileChunks", "screen". */
  id: string;
  text: string;
  /** Lower = higher priority (kept longer under budget pressure). Layers are appended in the given order; pass them highest-priority first. */
  priority?: number;
}

export interface FitPromptToBudgetInput {
  system: string;
  user: string;
  /** Optional context layers, highest priority first. Dropped from the tail (lowest priority) first when over budget. */
  layers?: PromptLayer[];
  caps: ModelCapabilities;
  /** Hard provider-specific input ceiling (e.g. Groq ~8000), applied on top of caps.maxContextTokens. */
  providerCeiling?: number;
}

export interface FitPromptToBudgetResult {
  system: string;
  user: string;
  /** ids of layers dropped, plus 'user:truncated' if the base system+user needed trimming, in drop order. */
  dropped: string[];
}

/**
 * Fit system + user (+ optional layers) into the active input budget.
 *
 * System and user are counted TOGETHER against the budget (a huge user
 * message and a huge system prompt are the same problem, per plan spec) and
 * the system prompt is never trimmed — it is the persona/behavior contract;
 * shrinking it changes behavior, not just size. If system+user alone exceed
 * budget, the user text is trimmed (oldest lines first) and every layer is
 * dropped, since there is no room left for any of them.
 */
export function fitPromptToBudget(input: FitPromptToBudgetInput): FitPromptToBudgetResult {
  const { system, user, layers = [], caps, providerCeiling } = input;
  const dropped: string[] = [];

  const effectiveMax = providerCeiling ? Math.min(caps.maxContextTokens, providerCeiling) : caps.maxContextTokens;
  const budget = Math.max(0, effectiveMax - caps.outputBudgetTokens);

  const systemTokens = estimateTokens(system);
  const baseTokens = systemTokens + estimateTokens(user);
  if (baseTokens > budget) {
    const lines = user.split('\n');
    while (lines.length > 1 && systemTokens + estimateTokens(lines.join('\n')) > budget) {
      lines.shift();
    }
    dropped.push(...layers.map((l) => l.id), 'user:truncated');
    return { system, user: lines.join('\n'), dropped };
  }

  let remaining = budget - baseTokens;
  const includedText: string[] = [];
  for (const layer of layers) {
    const text = layer.text?.trim();
    if (!text) continue;
    const cost = estimateTokens(text);
    if (cost > remaining) {
      dropped.push(layer.id);
      continue;
    }
    includedText.push(text);
    remaining -= cost;
  }

  const fittedUser = includedText.length ? `${user}\n\n${includedText.join('\n\n')}` : user;
  return { system, user: fittedUser, dropped };
}
