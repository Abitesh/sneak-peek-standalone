/**
 * AppLicenseService tests
 * Tests the application license system for activation, validation, and state management
 */

import test from 'node:test';
import assert from 'node:assert';

// Load the compiled AppLicenseService from relative path
async function loadService() {
  const { AppLicenseService } = await import('../AppLicenseService.js');
  return AppLicenseService;
}

test('AppLicenseService', async (t) => {
  const AppLicenseService = await loadService();

  await t.test('should validate the correct development license key', () => {
    const license = AppLicenseService.getInstance();
    const isValid = license.validateLicense('AVIABI-2005-2007-1977');
    assert.strictEqual(isValid, true, 'Valid license key should validate');
  });

  await t.test('should reject invalid license keys', () => {
    const license = AppLicenseService.getInstance();
    const isValid = license.validateLicense('INVALID-KEY-12345');
    assert.strictEqual(isValid, false, 'Invalid license key should not validate');
  });

  await t.test('should reject empty license keys', () => {
    const license = AppLicenseService.getInstance();
    const isValid = license.validateLicense('');
    assert.strictEqual(isValid, false, 'Empty license key should not validate');
  });

  await t.test('should activate valid license key', () => {
    const license = AppLicenseService.getInstance();
    const state = license.activateLicense('AVIABI-2005-2007-1977');
    assert.strictEqual(state.isLicensed, true, 'License should be marked as licensed');
    assert.strictEqual(state.isPremium, true, 'License should enable premium features');
    assert.strictEqual(state.status, 'active', 'License status should be active');
  });

  await t.test('should enable all entitlements when licensed', () => {
    const license = AppLicenseService.getInstance();
    license.activateLicense('AVIABI-2005-2007-1977');
    const state = license.getLicenseState();
    assert.strictEqual(state.entitlements.profileIntelligence, true, 'Profile Intelligence should be enabled');
    assert.strictEqual(state.entitlements.advancedModes, true, 'Advanced Modes should be enabled');
    assert.strictEqual(state.entitlements.hindsight, true, 'Hindsight should be enabled');
    assert.strictEqual(state.entitlements.advancedRetrieval, true, 'Advanced Retrieval should be enabled');
    assert.strictEqual(state.entitlements.myFilesRetrieval, true, 'My Files Retrieval should be enabled');
    assert.strictEqual(state.entitlements.allProFeatures, true, 'All Pro Features should be enabled');
  });

  await t.test('should reject invalid keys and return unlicensed state', () => {
    const license = AppLicenseService.getInstance();
    const state = license.activateLicense('WRONG-KEY');
    assert.strictEqual(state.isLicensed, false, 'Invalid key should result in unlicensed state');
    assert.strictEqual(state.status, 'invalid', 'Status should be invalid');
  });

  await t.test('should provide default unlicensed state', () => {
    const license = AppLicenseService.getInstance();
    license.revokeLicense();
    const state = license.getLicenseState();
    assert.strictEqual(state.isLicensed, false, 'Should be unlicensed');
    assert.strictEqual(state.status, 'missing', 'Status should be missing');
    assert.strictEqual(state.isPremium, false, 'Premium should be disabled');
  });

  await t.test('should disable all entitlements when not licensed', () => {
    const license = AppLicenseService.getInstance();
    license.revokeLicense();
    const state = license.getLicenseState();
    assert.strictEqual(state.entitlements.profileIntelligence, false, 'Profile Intelligence should be disabled');
    assert.strictEqual(state.entitlements.advancedModes, false, 'Advanced Modes should be disabled');
    assert.strictEqual(state.entitlements.hindsight, false, 'Hindsight should be disabled');
  });

  await t.test('isPremium() should return license status', () => {
    const license = AppLicenseService.getInstance();
    license.activateLicense('AVIABI-2005-2007-1977');
    assert.strictEqual(license.isPremium(), true, 'isPremium should return true when licensed');
    license.revokeLicense();
    assert.strictEqual(license.isPremium(), false, 'isPremium should return false when unlicensed');
  });

  await t.test('isLicensed() should return license status', () => {
    const license = AppLicenseService.getInstance();
    license.activateLicense('AVIABI-2005-2007-1977');
    assert.strictEqual(license.isLicensed(), true, 'isLicensed should return true when licensed');
    license.revokeLicense();
    assert.strictEqual(license.isLicensed(), false, 'isLicensed should return false when unlicensed');
  });

  await t.test('hasEntitlement should check specific features', () => {
    const license = AppLicenseService.getInstance();
    license.activateLicense('AVIABI-2005-2007-1977');
    assert.strictEqual(
      license.hasEntitlement('profileIntelligence'),
      true,
      'Should have profileIntelligence entitlement when licensed'
    );
    license.revokeLicense();
    assert.strictEqual(
      license.hasEntitlement('profileIntelligence'),
      false,
      'Should not have profileIntelligence entitlement when unlicensed'
    );
  });
});
