/**
 * LicenseManager - Premium Implementation
 * 
 * Manages application licensing for premium features.
 * Singleton instance that handles:
 * - License activation with key validation
 * - License persistence to local storage
 * - Premium feature gating
 * - Hardware-based activation (optional)
 * - License revocation and deactivation
 * 
 * This is the source-controlled implementation that replaces the unavailable premium submodule.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface LicenseState {
  isLicensed: boolean;
  isPremium: boolean;
  licenseKey: string | null;
  status: 'active' | 'invalid' | 'missing' | 'revoked' | 'expired';
  activatedAt?: string;
  expiresAt?: string;
  entitlements: {
    profileIntelligence: boolean;
    advancedModes: boolean;
    hindsight: boolean;
    advancedRetrieval: boolean;
    myFilesRetrieval: boolean;
    allProFeatures: boolean;
  };
}

export class LicenseManager {
  private static instance: LicenseManager | null = null;
  private licenseState: LicenseState;
  private licenseFilePath: string;
  private readonly CANONICAL_APP_LICENSE_KEY = 'AVIABI-2005-2007-1977';

  private constructor() {
    this.licenseFilePath = path.join(app.getPath('userData'), 'license.json');
    this.licenseState = this.loadLicenseState();
  }

  /**
   * Get or create singleton instance
   */
  static getInstance(): LicenseManager {
    if (!LicenseManager.instance) {
      LicenseManager.instance = new LicenseManager();
    }
    return LicenseManager.instance;
  }

  /**
   * Validate a license key
   */
  private validateLicense(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    // Accept the development key AVIABI-2005-2007-1977
    // In production, this would validate against signed certificates or a licensing service
    return key === this.CANONICAL_APP_LICENSE_KEY;
  }

  /**
   * Activate a license with the provided key
   */
  async activateLicense(key: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.validateLicense(key)) {
        return { success: false, error: 'Invalid license key' };
      }

      // Build and persist the license state
      this.licenseState = this.buildValidatedLicenseState(key);
      this.persistLicenseState();

      console.log('[LicenseManager] License activated successfully');
      return { success: true };
    } catch (error: any) {
      console.error('[LicenseManager] License activation failed:', error);
      return { success: false, error: error.message || 'License activation failed' };
    }
  }

  /**
   * Deactivate/revoke the current license
   */
  async deactivate(): Promise<void> {
    try {
      // Clear the license file
      if (fs.existsSync(this.licenseFilePath)) {
        fs.unlinkSync(this.licenseFilePath);
      }
      this.licenseState = this.buildUnlicensedState();
      console.log('[LicenseManager] License deactivated');
    } catch (error: any) {
      console.error('[LicenseManager] Deactivation failed:', error);
    }
  }

  /**
   * Check if premium is currently active (synchronous)
   */
  isPremium(): boolean {
    return this.licenseState.isPremium;
  }

  /**
   * Async variant: performs server-side revocation check (not yet implemented)
   * For now, returns the cached sync result
   */
  async isPremiumAsync(): Promise<boolean> {
    // In a production system, this would call a licensing service to verify
    // the license key is still valid and not revoked
    return this.isPremium();
  }

  /**
   * Get full license details
   */
  getLicenseDetails(): LicenseState {
    return { ...this.licenseState };
  }

  /**
   * Get hardware ID for license binding (placeholder)
   */
  getHardwareId(): string {
    // In production, this would generate/retrieve a unique hardware ID
    // for license binding to a specific device
    try {
      const os = require('os');
      const crypto = require('crypto');
      const hostname = os.hostname();
      const hash = crypto.createHash('sha256').update(hostname).digest('hex');
      return hash.substring(0, 16).toUpperCase();
    } catch {
      return 'UNAVAILABLE';
    }
  }

  /**
   * Build valid license state
   */
  private buildValidatedLicenseState(key: string): LicenseState {
    return {
      isLicensed: true,
      isPremium: true,
      licenseKey: key.substring(0, 7) + '...' + key.substring(key.length - 4), // Masked for display
      status: 'active',
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

  /**
   * Build unlicensed state
   */
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

  /**
   * Load license state from file
   */
  private loadLicenseState(): LicenseState {
    try {
      if (fs.existsSync(this.licenseFilePath)) {
        const data = fs.readFileSync(this.licenseFilePath, 'utf-8');
        const state = JSON.parse(data) as LicenseState;
        console.log('[LicenseManager] License state loaded from file');
        return state;
      }
    } catch (error) {
      console.warn('[LicenseManager] Failed to load license state:', error);
    }
    return this.buildUnlicensedState();
  }

  /**
   * Persist license state to file
   */
  private persistLicenseState(): void {
    try {
      const dir = path.dirname(this.licenseFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.licenseFilePath, JSON.stringify(this.licenseState, null, 2), 'utf-8');
      console.log('[LicenseManager] License state persisted to file');
    } catch (error) {
      console.error('[LicenseManager] Failed to persist license state:', error);
    }
  }
}

export default LicenseManager;
