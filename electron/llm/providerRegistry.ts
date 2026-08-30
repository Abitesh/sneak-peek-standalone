// electron/llm/providerRegistry.ts
//
// Single source of truth for "is this provider/model actually usable" — as
// opposed to "does a credential exist for it". `test-llm-connection`
// (electron/ipcHandlers.ts) populates a ProviderHealth per provider via
// CredentialsManager.setProviderHealth(); Settings and the model picker read
// it to show real state instead of key-presence.
//
// Pure helpers only — no IPC, no axios, no Electron imports — so this file is
// importable from tests (and the renderer, for types) without mocking
// anything. Platform-neutral: no filesystem or process.platform branching.

import { getModelCapabilities } from './modelCapabilities';

export type ProviderFamily =
  | 'gemini'
  | 'groq'
  | 'openai'
  | 'claude'
  | 'deepseek'
  | 'nvidia_nim'
  | 'litellm'
  | 'ollama'
  | 'codex-cli'
  | 'custom';

const PROVIDER_FAMILIES: readonly ProviderFamily[] = [
  'gemini', 'groq', 'openai', 'claude', 'deepseek', 'nvidia_nim',
  'litellm', 'ollama', 'codex-cli', 'custom',
];

export interface VerifiedModelBinding {
  /** e.g. "ollama-llama3.2", "litellm/openai/gpt-4o", "gpt-4o". */
  id: string;
  provider: ProviderFamily;
  label: string;
  capabilities: { chat: boolean; vision: boolean; streaming: boolean };
  contextWindow?: number;
  maxOutputTokens?: number;
  source: 'live-probe' | 'ollama-tags' | 'litellm-info' | 'preset';
  verifiedAt: number;
  lastError?: string;
}

export interface ProviderHealth {
  status: 'disconnected' | 'verified' | 'degraded';
  authOk: boolean;
  lastProbeAt: number;
  /** NOT populated when the real cause is "provider disabled" — see ipcHandlers test-llm-connection. */
  lastError?: { code: string; message: string };
  models: VerifiedModelBinding[];
}

export interface BindingFromModelIdOptions {
  label?: string;
  /** Whether a chat probe against this exact id succeeded. Defaults true (list endpoints already filter to chat models). */
  chatOk?: boolean;
  /** Overrides the modelCapabilities-derived guess. */
  visionOk?: boolean;
  streamingOk?: boolean;
  source?: VerifiedModelBinding['source'];
  contextWindow?: number;
  maxOutputTokens?: number;
  lastError?: string;
  verifiedAt?: number;
}

/**
 * Build a VerifiedModelBinding for `modelId` under `provider`.
 *
 * Vision/context defaults are read from the existing modelCapabilities table
 * rather than re-derived here — one place already knows which model ids take
 * images and what their budgets are.
 */
export function bindingFromModelId(
  modelId: string,
  provider: ProviderFamily,
  opts: BindingFromModelIdOptions = {},
): VerifiedModelBinding {
  const caps = getModelCapabilities(modelId, provider === 'ollama');
  return {
    id: modelId,
    provider,
    label: opts.label || modelId,
    capabilities: {
      chat: opts.chatOk ?? true,
      vision: opts.visionOk ?? caps.supportsImages,
      streaming: opts.streamingOk ?? true,
    },
    contextWindow: opts.contextWindow ?? caps.maxContextTokens,
    maxOutputTokens: opts.maxOutputTokens ?? caps.outputBudgetTokens,
    source: opts.source || 'preset',
    verifiedAt: opts.verifiedAt ?? Date.now(),
    lastError: opts.lastError,
  };
}

/**
 * Defensive normalizer, not a plain field read: a binding restored from disk
 * may carry a provider id from a build that has since renamed/retired a
 * family. Callers that key off the result (grouping by family, routing)
 * get 'custom' instead of a value outside the known union.
 */
export function providerFamilyFromBinding(binding: Pick<VerifiedModelBinding, 'provider'>): ProviderFamily {
  return PROVIDER_FAMILIES.includes(binding?.provider as ProviderFamily)
    ? (binding.provider as ProviderFamily)
    : 'custom';
}

export function filterChatCapable(bindings: VerifiedModelBinding[]): VerifiedModelBinding[] {
  return (bindings || []).filter((b) => b?.capabilities?.chat === true);
}

export function filterVisionCapable(bindings: VerifiedModelBinding[]): VerifiedModelBinding[] {
  return (bindings || []).filter((b) => b?.capabilities?.vision === true);
}

export interface VisionGateResult {
  ok: boolean;
  /** Set when the current selection lacks vision and a verified vision-capable
   *  binding exists — the caller should switch to it (and report the switch,
   *  never apply it silently) before sending images. */
  switchTo?: VerifiedModelBinding;
  /** Set when `ok` is false: no vision-capable binding exists anywhere. */
  message?: string;
}

/**
 * Screen/vision capability gate (Problem 39): a screen ask must never hand
 * images to a text-only model. Pure — the caller supplies the current
 * model's capabilities (e.g. `LLMHelper.getCapabilities()`) and the
 * persisted provider health map (`CredentialsManager.getAllProviderHealth()`)
 * — so it stays importable from tests without mocking Electron or IPC.
 */
export function resolveVisionGate(
  currentCapabilities: { supportsImages: boolean },
  allProviderHealth: Record<string, ProviderHealth>,
): VisionGateResult {
  if (currentCapabilities.supportsImages) return { ok: true };
  const bindings = Object.values(allProviderHealth || {}).flatMap((h) => h?.models || []);
  const candidate = filterVisionCapable(filterChatCapable(bindings))[0];
  if (candidate) return { ok: true, switchTo: candidate };
  return {
    ok: false,
    message:
      'This screen capture needs a vision-capable model, but the selected model only supports text and no verified '
      + 'vision-capable provider is configured. Add or verify a vision-capable provider (OpenAI, Gemini, Claude, Groq '
      + 'qwen vision, or an Ollama vision model like llava/qwen2.5-vl) in Settings > AI Providers, then try again.',
  };
}
