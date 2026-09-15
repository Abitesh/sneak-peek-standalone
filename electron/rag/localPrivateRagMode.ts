import type { ProviderDataScopePolicy } from '../llm/ProviderRouter';

export const LOCAL_PRIVATE_RAG_MODES = ['off', 'local-retrieval', 'full-local'] as const;
export type LocalPrivateRagMode = typeof LOCAL_PRIVATE_RAG_MODES[number];

export function isLocalPrivateRagMode(value: unknown): value is LocalPrivateRagMode {
  return LOCAL_PRIVATE_RAG_MODES.includes(value as LocalPrivateRagMode);
}

export function parseLocalPrivateRagMode(value: unknown): LocalPrivateRagMode {
  return isLocalPrivateRagMode(value) ? value : 'off';
}

export function wantsLocalRetrieval(mode: LocalPrivateRagMode): boolean {
  return mode === 'local-retrieval' || mode === 'full-local';
}

export function wantsLocalAnswers(mode: LocalPrivateRagMode): boolean {
  return mode === 'full-local';
}

export function applyLocalPrivateRagScopes(
  scopes: ProviderDataScopePolicy | undefined,
  mode: LocalPrivateRagMode,
): ProviderDataScopePolicy | undefined {
  if (!wantsLocalRetrieval(mode)) return scopes;
  return { ...(scopes || {}), embeddings: false };
}

export function readLocalPrivateRagMode(): LocalPrivateRagMode {
  try {
    const { SettingsManager } = require('../services/SettingsManager');
    return parseLocalPrivateRagMode(SettingsManager.getInstance().get('localPrivateRagMode'));
  } catch {
    return 'off';
  }
}

export function applyLocalPrivateRagAnswers(
  helper: { setLocalOnlyMode(enabled: boolean): void },
  mode: LocalPrivateRagMode = readLocalPrivateRagMode(),
): void {
  helper.setLocalOnlyMode(wantsLocalAnswers(mode));
}
