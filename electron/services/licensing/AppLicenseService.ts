/**
 * AppLicenseService - Application-owned license validation and state management
 *
 * This service replaces the deprecated Natively API licensing model.
 * It provides a single canonical source of truth for application license state.
 *
 * License Key: AVIABI-2005-2007-1977 (development build)
 *
 * Architecture:
 * LICENSE KEY → validateLicense() → LicenseState → EntitlementState → Feature Access
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as crypto from 'crypto';

/**
 * The canonical application license key for this build.
 * In production, this would be loaded from signing certificate / secure storage.
 */
const CANONICAL_APP_LICENSE_KEY = 'AVIABI-2005-2007-1977';

export type LicenseStatus = 'active' | 'invalid' | 'missing' | 'expired';

export interface LicenseState {
  isLicensed: boolean;
  isPremium: boolean;
  licenseKey?: string;
  status: LicenseStatus;
  activatedAt?: string;
  entitlements: {
    profileIntelligence: boolean;
    advancedModes: boolean;
    hindsight: boolean;
    advancedRetrieval: boolean;
    myFilesRetrieval: boolean;
    allProFeatures: boolean;
  };
}

/**
 * Persistence layer for license state
 */
interface PersistedLicenseData {
  licenseKey?: string;
  activatedAt?: string;
  validatedAt?: string;
}

class AppLicenseServiceImpl {
  private static instance: AppLicenseServiceImpl;
  private licenseState: LicenseState;
  private persistencePath: string;

  constructor() {
    this.persistencePath = path.join(app.getPath('userData'), 'license.json');
    this.licenseState = this.loadPersistedLicense();
  }

  public static getInstance(): AppLicenseServiceImpl {
    if (!AppLicenseServiceImpl.instance) {
      AppLicenseServiceImpl.instance = new AppLicenseServiceImpl();
    }
    return AppLicenseServiceImpl.instance;
  }

  /**
   * Load persisted license from storage
   */
  private loadPersistedLicense(): LicenseState {
    try {
      if (fs.existsSync(this.persistencePath)) {
        const data = JSON.parse(fs.readFileSync(this.persistencePath, 'utf-8'));
        return this.validateAndBuildLicenseState(data.licenseKey);
      }
    } catch (error) {
      console.warn('[AppLicenseService] Failed to load persisted license:', error);
    }

    // Default: unlicensed state
    return this.buildUnlicensedState();
  }

  /**
   * Persist license to storage
   */
  private persistLicense(licenseKey: string): void {
    try {
      const licenseDir = path.dirname(this.persistencePath);
      if (!fs.existsSync(licenseDir)) {
        fs.mkdirSync(licenseDir, { recursive: true });
      }

      const data: PersistedLicenseData = {
        licenseKey,
        activatedAt: new Date().toISOString(),
        validatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.persistencePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log('[AppLicenseService] License persisted');
    } catch (error) {
      console.error('[AppLicenseService] Failed to persist license:', error);
    }
  }

  /**
   * Clear persisted license
   */
  private clearPersistedLicense(): void {
    try {
      if (fs.existsSync(this.persistencePath)) {
        fs.unlinkSync(this.persistencePath);
        console.log('[AppLicenseService] License cleared');
      }
    } catch (error) {
      console.error('[AppLicenseService] Failed to clear license:', error);
    }
  }

  /**
   * Validate a license key
   * Returns true if the key is valid for this application
   */
  public validateLicense(key: string): boolean {
    if (!key || typeof key !== 'string') {
      return false;
    }

    const trimmed = key.trim();

    // Development license
    if (trimmed === CANONICAL_APP_LICENSE_KEY) {
      return true;
    }

    // Future: Add support for signed/cryptographic licenses here
    // For now: only the canonical development key is valid

    return false;
  }

  /**
   * Activate a license key
   * Returns the new license state
   */
  public activateLicense(licenseKey: string): LicenseState {
    if (!this.validateLicense(licenseKey)) {
      this.licenseState = this.buildInvalidLicenseState();
      this.clearPersistedLicense();
      return this.licenseState;
    }

    this.licenseState = this.validateAndBuildLicenseState(licenseKey);
    this.persistLicense(licenseKey);
    return this.licenseState;
  }

  /**
   * Deactivate/revoke the current license
   */
  public revokeLicense(): LicenseState {
    this.licenseState = this.buildUnlicensedState();
    this.clearPersistedLicense();
    return this.licenseState;
  }

  /**
   * Get the current license state
   */
  public getLicenseState(): LicenseState {
    return { ...this.licenseState };
  }

  /**
   * Check if any license is currently active
   */
  public isLicensed(): boolean {
    return this.licenseState.isLicensed;
  }

  /**
   * Check if premium features are available
   */
  public isPremium(): boolean {
    return this.licenseState.isPremium;
  }

  /**
   * Check a specific entitlement
   */
  public hasEntitlement(name: keyof LicenseState['entitlements']): boolean {
    return this.licenseState.entitlements[name];
  }

  /**
   * Build a licensed state (all features enabled)
   */
  private validateAndBuildLicenseState(licenseKey: string): LicenseState {
    return {
      isLicensed: true,
      isPremium: true,
      licenseKey: this.maskLicenseKey(licenseKey),
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
   * Build an unlicensed state (no features available)
   */
  private buildUnlicensedState(): LicenseState {
    return {
      isLicensed: false,
      isPremium: false,
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
   * Build an invalid license state (bad key)
   */
  private buildInvalidLicenseState(): LicenseState {
    return {
      isLicensed: false,
      isPremium: false,
      status: 'invalid',
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
   * Mask license key for display (show only first and last 4 chars)
   */
  private maskLicenseKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
  }
}

export const AppLicenseService = AppLicenseServiceImpl;
