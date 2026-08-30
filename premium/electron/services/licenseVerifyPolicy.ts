export type ProVerifyPolicyVerdict = 'active' | 'revoke' | 'keep';

export function classifyProVerify(
  status: number,
  body: Record<string, unknown> | null,
): ProVerifyPolicyVerdict {
  if (status >= 200 && status < 300) {
    if (body && body.ok === true && body.has_pro === true) return 'active';
    if (body && body.ok === true && body.has_pro === false) return 'revoke';
    return 'keep';
  }

  const err = String((body && (body as any).error) || '').toLowerCase();
  if (status === 403 && (
    err.includes('subscription_inactive') ||
    err.includes('key_not_found') ||
    err.includes('invalid_key_format')
  )) {
    return 'revoke';
  }

  if (status === 400 && (
    err.includes('key_not_found') ||
    err.includes('invalid_key_format')
  )) {
    return 'revoke';
  }

  return 'keep';
}
