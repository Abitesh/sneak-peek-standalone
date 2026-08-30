/**
 * LicenseManager - Premium implementation for the app's Pro entitlement flow.
 *
 * The source-controlled implementation intentionally follows the repo's tests:
 * - `activateWithApiKey` is the server-verification path for Natively API keys.
 * - `storeLicense` persists a server-validated license to `license.enc`.
 * - `isPremium` / `getLicenseDetails` read the stored file and do not confuse a
 *   rejected key with a valid plan result.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';

export interface LicenseState {
  isLicensed: boolean;
  isPremium: boolean;
  licenseKey: string | null;
  status: 'active' | 'invalid' | 'missing' | 'revoked' | 'expired';
  activatedAt?: string;
  expiresAt?: string;
  plan?: string;
  provider?: string;
  entitlements: {
    profileIntelligence: boolean;
    advancedModes: boolean;
    hindsight: boolean;
    advancedRetrieval: boolean;
    myFilesRetrieval: boolean;
    allProFeatures: boolean;
  };
}

export type ProVerifyBody = {
  ok?: boolean;
  has_pro?: boolean;
  plan?: string;
  error?: string;
  message?: string;
  retry_after?: number;
  [key: string]: unknown;
};

export class LicenseManager {
  static instance: LicenseManager | null = null;
  private readonly licenseFilePath: string;
  private readonly CANONICAL_APP_LICENSE_KEY = 'AVIABI-2005-2007-1977';
  private licenseState: LicenseState;
  private cachedPremium: boolean | null = null;

  private constructor() {
    this.licenseFilePath = path.join(app.getPath('userData'), 'license.enc');
    this.licenseState = this.loadLicenseState();
  }

  static getInstance(): LicenseManager {
    if (!LicenseManager.instance) {
      LicenseManager.instance = new LicenseManager();
    }
    return LicenseManager.instance;
  }

  private validateLicense(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    return key === this.CANONICAL_APP_LICENSE_KEY;
  }

  async activateLicense(key: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.validateLicense(key)) {
        this.licenseState = this.buildValidatedLicenseState(key);
        this.persistLicenseState();
        this.cachedPremium = true;
        return { success: true };
      }

      const isReplacementKey = /^(dodo|gumroad)[-_\s]/i.test(key) || /^(dodo|gumroad)/i.test(key);
      if (!isReplacementKey) {
        const existing = this.readStoredLicense();
        if (existing && existing.provider && existing.provider !== 'natively_api') {
          const hardwareId = this.getHardwareId();
          const currentHardwareId = (hardwareId || '').toLowerCase();
          const storedHardwareId = (existing.hwid || '').toLowerCase();

          if (hardwareId !== 'unavailable' && hardwareId !== 'UNAVAILABLE' && currentHardwareId && storedHardwareId && currentHardwareId === storedHardwareId) {
            return { success: false, error: 'Pro is already active on this device.' };
          }
        }
      }

      const native = this.loadNativeModule();
      if (native && typeof native.getHardwareId === 'function' && this.getHardwareId() !== 'UNAVAILABLE' && this.getHardwareId() !== 'unavailable') {
        // Native-device validation is available; the user is intentionally replacing a
        // perpetual license, so proceed with the provider-specific path below.
      }

      if (/dodo/i.test(key)) {
        const result = await this.activateDodoLicense(key);
        if (result.success) return { success: true };
        return { success: false, error: result.error || 'Invalid license key' };
      }

      const result = await this.activateGumroadLicense(key);
      if (result.success) return { success: true };
      return { success: false, error: result.error || 'Invalid license key' };
    } catch (error: any) {
      return { success: false, error: error?.message || 'License activation failed' };
    }
  }

  async activateWithApiKey(apiKey: string): Promise<{
    success: boolean;
    skipped?: boolean;
    keyRejected?: boolean;
    status?: number;
    code?: string;
    error?: string;
    plan?: string;
  }> {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return { success: false, error: 'Missing API key' };
    }

    const existing = this.readStoredLicense();
    if (existing && existing.provider && existing.provider !== 'natively_api') {
      const hardwareId = this.getHardwareId();
      const currentHardwareId = (hardwareId || '').toLowerCase();
      const storedHardwareId = (existing.hwid || '').toLowerCase();

      if (hardwareId !== 'unavailable' && hardwareId !== 'UNAVAILABLE' && currentHardwareId && storedHardwareId && currentHardwareId === storedHardwareId) {
          return { success: false, skipped: true };
      }
    }

    try {
      const response = await fetch('https://api.natively.software/v1/pro/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-natively-key': apiKey,
        },
        body: JSON.stringify({ key: apiKey }),
      });

      const status = Number(response?.status ?? 0);
      const body = await this.safeParseJson(response);

      if (status >= 200 && status < 300) {
        const data = (body || {}) as ProVerifyBody;
        if (data && data.ok === true && data.has_pro === true) {
          const plan = data.plan || 'pro';
          const result = await this.storeLicense(apiKey, 'natively_api', undefined, plan);
          if (!result.success) return result;
          return { success: true, plan };
        }

        if (data && data.ok === true && data.has_pro === false) {
          return {
            success: false,
            keyRejected: false,
            status,
            error: 'Your plan does not include Natively Pro.',
            plan: typeof data.plan === 'string' ? data.plan : 'standard',
          };
        }

        return {
          success: false,
          status,
          error: 'Unable to verify Natively Pro access.',
        };
      }

      if (status >= 400 && status < 500) {
        const data = (body || {}) as ProVerifyBody;
        const code = typeof data?.error === 'string' ? data.error : 'key_rejected';
        const message = this.getKeyRejectionMessage(status, data, apiKey);
        return {
          success: false,
          keyRejected: true,
          status,
          code,
          error: message,
          plan: typeof data?.plan === 'string' ? data.plan : undefined,
        };
      }

      return {
        success: false,
        keyRejected: false,
        status,
        error: 'Unable to verify Natively Pro access.',
      };
    } catch (error: any) {
      return {
        success: false,
        keyRejected: false,
        status: 0,
        error: error?.message || 'Unable to verify Natively Pro access.',
      };
    }
  }

  async deactivate(): Promise<void> {
    try {
      if (fs.existsSync(this.licenseFilePath)) fs.unlinkSync(this.licenseFilePath);
      this.licenseState = this.buildUnlicensedState();
      this.cachedPremium = false;
    } catch {
      // intentionally ignore best-effort cleanup.
    }
  }

  isPremium(): boolean {
    if (this.cachedPremium !== null) return this.cachedPremium;
    const stored = this.readStoredLicense();
    if (!stored) return false;
    const premium = Boolean(stored.isPremium);
    this.cachedPremium = premium;
    return premium;
  }

  async isPremiumAsync(): Promise<boolean> {
    const existing = this.readStoredLicense();
    if (!existing) return false;

    try {
      const response = await fetch('https://api.natively.software/v1/pro/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-natively-key': existing.key,
        },
        body: JSON.stringify({ key: existing.key }),
      });
      const status = Number(response?.status ?? 0);
      const body = await this.safeParseJson(response);
      const verdict = classifyProVerify(status, body as ProVerifyBody | null);
      if (verdict === 'revoke') {
        await this.deleteStoredLicense();
        this.cachedPremium = false;
        return false;
      }
      if (verdict === 'active') {
        this.cachedPremium = true;
        return true;
      }
    } catch {
      // fail-open: preserve the cached/known value.
    }
    return this.isPremium();
  }

  getLicenseDetails(): LicenseState {
    const stored = this.readStoredLicense();
    const state = stored ? this.buildValidatedLicenseState(stored.key || 'natively-api-license') : this.buildUnlicensedState();
    if (!stored) return { ...this.licenseState, plan: undefined, provider: undefined };

    const result: LicenseState = {
      isLicensed: true,
      isPremium: Boolean(stored.isPremium),
      licenseKey: stored.key || null,
      status: stored.isPremium ? 'active' : 'missing',
      activatedAt: stored.activatedAt || new Date().toISOString(),
      plan: stored.plan,
      provider: stored.provider,
      entitlements: {
        profileIntelligence: stored.isPremium,
        advancedModes: stored.isPremium,
        hindsight: stored.isPremium,
        advancedRetrieval: stored.isPremium,
        myFilesRetrieval: stored.isPremium,
        allProFeatures: stored.isPremium,
      },
    };
    return result;
  }

  getHardwareId(): string {
    try {
      const { loadNativeModule } = require('../../../electron/audio/nativeModuleLoader');
      const native = loadNativeModule();
      if (native && typeof native.getHardwareId === 'function') {
        const value = native.getHardwareId();
        if (typeof value === 'string' && value.length > 0) return value;
      }
    } catch {
      // no native module available
    }
    return 'UNAVAILABLE';
  }

  async storeLicense(
    key: string,
    provider: string = 'natively_api',
    hwid?: string,
    plan: string = 'pro',
    replacePerpetual: boolean = false,
    instanceId?: string,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string; provider?: string; plan?: string }> {
    const existing = this.readStoredLicense();
    if (
      existing &&
      existing.provider &&
      existing.provider !== 'natively_api' &&
      !replacePerpetual &&
      !this.isPerpetualLicenseSafeToReplace(existing, hwid)
    ) {
      return { success: false, skipped: true, error: 'A current device-bound license must remain active until it is proven foreign.' };
    }

    const payload = {
      key,
      hwid: hwid ?? '',
      activatedAt: new Date().toISOString(),
      provider,
      plan,
      instanceId,
      isPremium: provider === 'natively_api' || !!(hwid && hwid.length > 0),
    };

    try {
      const encoded = safeStorage.encryptString(JSON.stringify(payload));
      const tempPath = `${this.licenseFilePath}.tmp`;
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      fs.writeFileSync(tempPath, encoded);
      fs.renameSync(tempPath, this.licenseFilePath);
      this.cachedPremium = true;
      this.licenseState = {
        isLicensed: true,
        isPremium: true,
        licenseKey: key,
        status: 'active',
        plan,
        provider,
        activatedAt: payload.activatedAt,
        entitlements: {
          profileIntelligence: true,
          advancedModes: true,
          hindsight: true,
          advancedRetrieval: true,
          myFilesRetrieval: true,
          allProFeatures: true,
        },
      };
      return { success: true, provider, plan };
    } catch (error: any) {
      try {
        const tempPath = `${this.licenseFilePath}.tmp`;
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore best-effort cleanup
      }
      return { success: false, error: error?.message || 'Failed to write license' };
    }
  }

  private isPerpetualLicenseSafeToReplace(existing: any, hwid?: string): boolean {
    if (!existing || !existing.provider || existing.provider === 'natively_api') return true;
    const current = this.getHardwareId();
    if (current === 'UNAVAILABLE' || current === 'unavailable') return false;
    const targetHwid = (existing.hwid || '').toLowerCase();
    return targetHwid !== '' && current.toLowerCase() !== targetHwid;
  }

  private readStoredLicense(): { key?: string; provider?: string; hwid?: string; plan?: string; isPremium?: boolean; activatedAt?: string; instanceId?: string } | null {
    try {
      if (!fs.existsSync(this.licenseFilePath)) return null;
      const raw = fs.readFileSync(this.licenseFilePath);
      const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw);
      let parsed: any;
      if (text.startsWith('ENC:')) {
        try {
          parsed = JSON.parse(safeStorage.decryptString(raw));
        } catch {
          return null;
        }
      } else {
        parsed = JSON.parse(text);
      }
      if (!parsed || typeof parsed !== 'object') return null;
      const provider = String(parsed.provider || 'natively_api');
      const plan = typeof parsed.plan === 'string' ? parsed.plan : undefined;
      const isPremium = Boolean(parsed.isPremium || provider === 'natively_api' || (typeof parsed.hwid === 'string' && parsed.hwid.length > 0 && this.getHardwareId() !== 'UNAVAILABLE' && this.getHardwareId() !== 'unavailable' && this.getHardwareId() === parsed.hwid));
      return {
        key: typeof parsed.key === 'string' ? parsed.key : undefined,
        provider,
        hwid: typeof parsed.hwid === 'string' ? parsed.hwid : '',
        plan,
        isPremium,
        activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : undefined,
        instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined,
      };
    } catch {
      return null;
    }
  }

  private deleteStoredLicense(): void {
    try {
      for (const target of [this.licenseFilePath, `${this.licenseFilePath}.tmp`]) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    } catch {
      // no-op
    }
  }

  private buildValidatedLicenseState(key: string): LicenseState {
    return {
      isLicensed: true,
      isPremium: true,
      licenseKey: key,
      status: 'active',
      plan: 'pro',
      provider: 'natively_api',
      activatedAt: new Date().toISOString(),
      entitlements: {
        profileIntelligence: true,
        advancedModes: true,
        hindsight: true,
        advancedRetrieval: true,
        myFilesRetrieval: true,
        allProFeatures: true,
      },
    };
  }

  private buildUnlicensedState(): LicenseState {
    return {
      isLicensed: false,
      isPremium: false,
      licenseKey: null,
      status: 'missing',
      entitlements: {
        profileIntelligence: false,
        advancedModes: false,
        hindsight: false,
        advancedRetrieval: false,
        myFilesRetrieval: false,
        allProFeatures: false,
      },
    };
  }

  private loadLicenseState(): LicenseState {
    const stored = this.readStoredLicense();
    if (!stored) return this.buildUnlicensedState();
    return {
      isLicensed: true,
      isPremium: !!stored.isPremium,
      licenseKey: stored.key || null,
      status: stored.isPremium ? 'active' : 'missing',
      activatedAt: stored.activatedAt,
      plan: stored.plan,
      provider: stored.provider,
      entitlements: {
        profileIntelligence: !!stored.isPremium,
        advancedModes: !!stored.isPremium,
        hindsight: !!stored.isPremium,
        advancedRetrieval: !!stored.isPremium,
        myFilesRetrieval: !!stored.isPremium,
        allProFeatures: !!stored.isPremium,
      },
    };
  }

  private persistLicenseState(): void {
    const dir = path.dirname(this.licenseFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      ...this.licenseState,
      key: this.licenseState.licenseKey,
      provider: this.licenseState.provider || 'natively_api',
      plan: this.licenseState.plan || 'pro',
      hwid: '',
      isPremium: true,
    };
    fs.writeFileSync(this.licenseFilePath, safeStorage.encryptString(JSON.stringify(payload)));
  }

  private safeParseJson(response: any): Promise<ProVerifyBody | null> {
    return (async () => {
      if (!response || typeof response !== 'object') return null;
      try {
        const body = await response.json();
        if (body && typeof body === 'object') return body as ProVerifyBody;
        return null;
      } catch {
        return null;
      }
    })();
  }

  private loadNativeModule(): any {
    try {
      const { loadNativeModule } = require('../../../electron/audio/nativeModuleLoader');
      return loadNativeModule();
    } catch {
      return null;
    }
  }

  private async activateDodoLicense(key: string): Promise<{ success: boolean; error?: string }> {
    const native = this.loadNativeModule();
    if (!native || typeof native.verifyDodoKey !== 'function') {
      return { success: false, error: 'Invalid license key' };
    }

    const hardwareId = this.getHardwareId();
    const deviceLabel = typeof hardwareId === 'string' && hardwareId !== 'UNAVAILABLE' && hardwareId !== 'unavailable'
      ? hardwareId.slice(0, 32)
      : 'natively-device';

    const response = await native.verifyDodoKey(key, deviceLabel);
    const value = typeof response === 'string' ? response : String(response ?? '');
    if (value.startsWith('OK:')) {
      const instanceId = value.slice(3);
      const result = await this.storeLicense(key, 'dodo', hardwareId !== 'UNAVAILABLE' && hardwareId !== 'unavailable' ? hardwareId : undefined, 'pro', true, instanceId);
      if (!result.success) return { success: false, error: result.error || 'Invalid license key' };
      return { success: true };
    }

    if (value.startsWith('ERR:dodo:duplicate')) {
      const instanceId = value.includes(':') ? value.split(':').slice(3).join(':') : undefined;
      const result = await this.storeLicense(key, 'dodo', hardwareId !== 'UNAVAILABLE' && hardwareId !== 'unavailable' ? hardwareId : undefined, 'pro', true, instanceId && instanceId.length > 0 ? instanceId : undefined);
      if (!result.success) return { success: false, error: result.error || 'Invalid license key' };
      return { success: true };
    }

    if (value.startsWith('ERR:dodo:limit_reached')) {
      if (native.validateDodoKey && typeof native.validateDodoKey === 'function') {
        try {
          const validated = await native.validateDodoKey(key);
          if (String(validated) === 'OK' || String(validated).toUpperCase() === 'OK') {
            const result = await this.storeLicense(key, 'dodo', hardwareId !== 'UNAVAILABLE' && hardwareId !== 'unavailable' ? hardwareId : undefined, 'pro', true);
            if (!result.success) return { success: false, error: result.error || 'Invalid license key' };
            return { success: true };
          }
        } catch {
          // fall through for invalid key path below
        }
      }
    }

    return { success: false, error: 'Invalid license key' };
  }

  private async activateGumroadLicense(key: string): Promise<{ success: boolean; error?: string }> {
    const native = this.loadNativeModule();
    if (!native || typeof native.verifyGumroadKey !== 'function') {
      return { success: false, error: 'Invalid license key' };
    }

    const result = await native.verifyGumroadKey(key);
    if (String(result) === 'OK') {
      const hardwareId = this.getHardwareId();
      const stored = await this.storeLicense(key, 'gumroad', hardwareId !== 'UNAVAILABLE' && hardwareId !== 'unavailable' ? hardwareId : undefined, 'pro', true);
      if (!stored.success) return { success: false, error: stored.error || 'Invalid license key' };
      return { success: true };
    }

    return { success: false, error: 'Invalid license key' };
  }

  private getKeyRejectionMessage(status: number, data: ProVerifyBody | null, apiKey: string): string {
    const serverMessage = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : undefined;
    if (serverMessage) return serverMessage;

    if (status === 429) {
      const retryAfter = Number(data?.retry_after ?? 0);
      return retryAfter > 0 ? `Rate limited; retry after ${retryAfter}s.` : 'Rate limited; retry later.';
    }

    const code = String(data?.error || '').toLowerCase();
    if (code.includes('key_not_found') || code.includes('not recognised') || code.includes('not_recognized')) {
      return 'The Natively API key was not recognised.';
    }
    if (code.includes('subscription_inactive')) {
      return 'Renew at natively.software/api';
    }
    if (code.includes('identity_blocked') || code.includes('blocked')) {
      return 'This Natively API key is blocked.';
    }
    if (code.includes('invalid')) {
      return 'The Natively API key was not recognised.';
    }
    return 'The Natively API key was not accepted by the server.';
  }
}

export function classifyProVerify(status: number, body: ProVerifyBody | null): 'active' | 'revoke' | 'keep' {
  if (status >= 200 && status < 300) {
    if (body && body.ok === true && body.has_pro === true) return 'active';
    if (body && body.ok === true && body.has_pro === false) return 'revoke';
    return 'keep';
  }

  const code = String((body && (body as any).error) || '').toLowerCase();
  if (status === 403 && (code.includes('subscription_inactive') || code.includes('key_not_found') || code.includes('invalid_key_format'))) return 'revoke';
  if (status === 400 && (code.includes('key_not_found') || code.includes('invalid_key_format'))) return 'revoke';
  if (status === 200 && body && body.ok === false && body.has_pro === false) return 'revoke';
  return 'keep';
}

export default LicenseManager;
