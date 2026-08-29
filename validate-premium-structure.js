#!/usr/bin/env node

/**
 * Validation script to verify premium directory structure and module loads
 */

const fs = require('fs');
const path = require('path');

const premiumDir = path.join(__dirname, 'premium');
const electronDir = path.join(premiumDir, 'electron');

console.log('🔍 Validating premium directory structure...\n');

// Check directory structure
const requiredDirs = [
  'premium/electron/knowledge',
  'premium/electron/knowledge/roleInsight',
  'premium/electron/services',
];

const requiredFiles = [
  'premium/electron/knowledge/types.ts',
  'premium/electron/knowledge/KnowledgeOrchestrator.ts',
  'premium/electron/knowledge/NegotiationConversationTracker.ts',
  'premium/electron/knowledge/IntentClassifier.ts',
  'premium/electron/knowledge/ContextAssembler.ts',
  'premium/electron/knowledge/KnowledgeDatabaseManager.ts',
  'premium/electron/knowledge/roleInsight/JdSourceResolver.ts',
  'premium/electron/services/LicenseManager.ts',
];

let validationsPassed = 0;
let validationsFailed = 0;

console.log('📁 Checking directory structure:');
requiredDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (fs.existsSync(fullPath)) {
    console.log(`  ✓ ${dir}`);
    validationsPassed++;
  } else {
    console.log(`  ✗ ${dir} - MISSING`);
    validationsFailed++;
  }
});

console.log('\n📄 Checking required files:');
requiredFiles.forEach(file => {
  const fullPath = path.join(__dirname, file);
  if (fs.existsSync(fullPath)) {
    console.log(`  ✓ ${file}`);
    validationsPassed++;
  } else {
    console.log(`  ✗ ${file} - MISSING`);
    validationsFailed++;
  }
});

// Check for TypeScript compilation in dist-electron
console.log('\n🏗️  Checking built modules in dist-electron:');
const builtModules = [
  'dist-electron/premium/electron/knowledge/types.js',
  'dist-electron/premium/electron/knowledge/KnowledgeOrchestrator.js',
  'dist-electron/premium/electron/knowledge/NegotiationConversationTracker.js',
  'dist-electron/premium/electron/knowledge/IntentClassifier.js',
  'dist-electron/premium/electron/knowledge/ContextAssembler.js',
  'dist-electron/premium/electron/knowledge/KnowledgeDatabaseManager.js',
  'dist-electron/premium/electron/knowledge/roleInsight/JdSourceResolver.js',
  'dist-electron/premium/electron/services/LicenseManager.js',
];

builtModules.forEach(mod => {
  const fullPath = path.join(__dirname, mod);
  if (fs.existsSync(fullPath)) {
    const size = fs.statSync(fullPath).size;
    console.log(`  ✓ ${mod} (${size} bytes)`);
    validationsPassed++;
  } else {
    console.log(`  ✗ ${mod} - NOT FOUND`);
    validationsFailed++;
  }
});

// Summary
console.log(`\n📊 Validation Summary:`);
console.log(`  Passed: ${validationsPassed}`);
console.log(`  Failed: ${validationsFailed}`);

if (validationsFailed === 0) {
  console.log('\n✅ All validations passed! Premium directory is properly structured and built.');
  process.exit(0);
} else {
  console.log(`\n❌ ${validationsFailed} validation(s) failed. Check the premium directory structure.`);
  process.exit(1);
}
