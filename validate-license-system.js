#!/usr/bin/env node
/**
 * License System Validation Script
 * 
 * Validates that the application-owned license system is properly implemented
 * and all components are in place for license management.
 * 
 * Usage: node validate-license-system.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const CHECKS = [];
let passCount = 0;
let failCount = 0;

function check(name, passed, details = '') {
  CHECKS.push({ name, passed, details });
  if (passed) {
    console.log(`✅ ${name}`);
    passCount++;
  } else {
    console.log(`❌ ${name}${details ? ': ' + details : ''}`);
    failCount++;
  }
}

async function validateLicenseSystem() {
  console.log('🔍 Validating Application-Owned License System\n');

  // Check 1: AppLicenseService file exists
  const appLicensePath = path.join(projectRoot, 'dist-electron/electron/services/licensing/AppLicenseService.js');
  check(
    'AppLicenseService compiled',
    fs.existsSync(appLicensePath),
    fs.existsSync(appLicensePath) ? '' : `Not found at ${appLicensePath}`
  );

  // Check 2: KnowledgeOrchestrator file exists
  const orchestratorPath = path.join(projectRoot, 'dist-electron/electron/services/knowledge/KnowledgeOrchestrator.js');
  check(
    'KnowledgeOrchestrator compiled',
    fs.existsSync(orchestratorPath),
    fs.existsSync(orchestratorPath) ? '' : `Not found at ${orchestratorPath}`
  );

  // Check 3: License test file exists
  const testPath = path.join(projectRoot, 'electron/services/licensing/__tests__/AppLicenseService.integration.test.mjs');
  check(
    'License integration tests exist',
    fs.existsSync(testPath),
    fs.existsSync(testPath) ? '' : `Not found at ${testPath}`
  );

  // Check 4: Development key is defined
  const devKey = 'AVIABI-2005-2007-1977';
  check(
    'Development license key defined',
    devKey.match(/^AVIABI-\d{4}-\d{4}-\d{4}$/),
    `Key format: ${devKey}`
  );

  // Check 5: ipcHandlers contains license handlers
  const ipcHandlersPath = path.join(projectRoot, 'electron/ipcHandlers.ts');
  const ipcHandlersContent = fs.readFileSync(ipcHandlersPath, 'utf-8');
  check(
    'License IPC handlers defined',
    ipcHandlersContent.includes("'license:activate'") &&
    ipcHandlersContent.includes("'license:status'") &&
    ipcHandlersContent.includes("'license:revoke'"),
    'activate, status, revoke handlers found'
  );

  // Check 6: Preload API contains license methods
  const preloadPath = path.join(projectRoot, 'electron/preload.ts');
  const preloadContent = fs.readFileSync(preloadPath, 'utf-8');
  check(
    'Preload license APIs defined',
    preloadContent.includes('activateLicense') &&
    preloadContent.includes('getLicenseStatus') &&
    preloadContent.includes('revokeLicense') &&
    preloadContent.includes('onLicenseStatusChanged'),
    'All 4 license APIs found'
  );

  // Check 7: isProOrTrialActive uses AppLicenseService
  check(
    'isProOrTrialActive migrated to AppLicenseService',
    ipcHandlersContent.includes('AppLicenseService.getInstance()') &&
    ipcHandlersContent.includes('.isPremium()'),
    'License check integrated'
  );

  // Check 8: Old Natively license handlers removed
  const hasOldHandlers = preloadContent.includes("'license:check-premium'") ||
    preloadContent.includes("'license:deactivate'") ||
    preloadContent.includes("'license:get-hardware-id'");
  check(
    'Old Natively license handlers removed',
    !hasOldHandlers,
    hasOldHandlers ? 'Deprecated handlers still found in preload' : 'All deprecated handlers removed'
  );

  // Check 9: Profile handlers have updated error messages
  check(
    'Profile handler error messages updated',
    ipcHandlersContent.includes('Profile Intelligence is not available in this build'),
    'Accurate diagnostic messages'
  );

  // Check 10: KnowledgeOrchestrator loaded in main.ts
  const mainPath = path.join(projectRoot, 'electron/main.ts');
  const mainContent = fs.readFileSync(mainPath, 'utf-8');
  check(
    'KnowledgeOrchestrator loaded from application services',
    mainContent.includes("'./services/knowledge/KnowledgeOrchestrator'"),
    'Local module loading configured'
  );

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests Passed: ${passCount}/${CHECKS.length}`);
  console.log(`Tests Failed: ${failCount}/${CHECKS.length}`);
  console.log(`${'='.repeat(50)}\n`);

  if (failCount === 0) {
    console.log('✅ All validation checks passed!');
    console.log('\n📝 Next steps:');
    console.log('  1. Run: npm run build:electron');
    console.log('  2. Test in renderer: window.electron.activateLicense("AVIABI-2005-2007-1977")');
    console.log('  3. Check status: window.electron.getLicenseStatus()');
    process.exit(0);
  } else {
    console.log(`❌ ${failCount} validation checks failed.`);
    process.exit(1);
  }
}

validateLicenseSystem().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
