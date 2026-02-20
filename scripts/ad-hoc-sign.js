const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Helper Renaming Configuration ───
// Disguise name used for helper processes in Activity Monitor
const DISGUISE_BASE = 'CoreServices';

const HELPER_SUFFIXES = ['', ' (GPU)', ' (Renderer)', ' (Plugin)'];

/**
 * Rename Electron helper bundles so they don't appear as "Natively Helper *"
 * in Activity Monitor. This runs BEFORE code signing.
 */
function renameHelpers(appOutDir, appName) {
    const frameworksDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Frameworks');

    if (!fs.existsSync(frameworksDir)) {
        console.log('[Helper Rename] Frameworks directory not found, skipping.');
        return;
    }

    for (const suffix of HELPER_SUFFIXES) {
        const oldHelperName = `${appName} Helper${suffix}`;
        const newHelperName = `${DISGUISE_BASE} Helper${suffix}`;

        const oldAppPath = path.join(frameworksDir, `${oldHelperName}.app`);
        const newAppPath = path.join(frameworksDir, `${newHelperName}.app`);

        if (!fs.existsSync(oldAppPath)) {
            console.log(`[Helper Rename] Skipping (not found): ${oldHelperName}.app`);
            continue;
        }

        console.log(`[Helper Rename] ${oldHelperName} → ${newHelperName}`);

        // 1. Rename the internal executable
        const oldExec = path.join(oldAppPath, 'Contents', 'MacOS', oldHelperName);
        const newExec = path.join(oldAppPath, 'Contents', 'MacOS', newHelperName);
        if (fs.existsSync(oldExec)) {
            fs.renameSync(oldExec, newExec);
        }

        // 2. Update Info.plist
        const plistPath = path.join(oldAppPath, 'Contents', 'Info.plist');
        if (fs.existsSync(plistPath)) {
            try {
                // Update CFBundleDisplayName
                execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName '${newHelperName}'" "${plistPath}"`, { stdio: 'pipe' });
                // Update CFBundleExecutable
                execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable '${newHelperName}'" "${plistPath}"`, { stdio: 'pipe' });
                // Update CFBundleName (originally "Electron Helper*")
                const newBundleName = `${DISGUISE_BASE} Helper${suffix}`;
                execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName '${newBundleName}'" "${plistPath}"`, { stdio: 'pipe' });
            } catch (err) {
                console.warn(`[Helper Rename] PlistBuddy warning for ${oldHelperName}:`, err.message);
            }
        }

        // 3. Rename the .app bundle folder itself (must be last)
        fs.renameSync(oldAppPath, newAppPath);
    }

    console.log('[Helper Rename] All helpers renamed successfully.');
}

exports.default = async function (context) {
    // Only process on macOS
    if (process.platform !== 'darwin') {
        return;
    }

    const appOutDir = context.appOutDir;
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    // ── Step 1: Rename helper executables (before signing) ──
    try {
        renameHelpers(appOutDir, appName);
    } catch (error) {
        console.error('[Helper Rename] Failed to rename helpers:', error);
        // Non-fatal: continue to signing
    }

    // ── Step 2: Ad-hoc sign the application ──
    // Resolve the path to the entitlements file so V8 gets JIT memory permissions
    const entitlementsPath = path.join(context.packager.info.projectDir, 'assets', 'entitlements.mac.plist');
    console.log(`[Ad-Hoc Signing] Signing ${appPath} with entitlements from ${entitlementsPath}...`);

    try {
        // --force: replace existing signature
        // --deep: sign nested code
        // --entitlements: attach JIT/memory entitlements (critical for Intel Macs)
        // --sign -: ad-hoc signature
        execSync(`codesign --force --deep --entitlements "${entitlementsPath}" --sign - "${appPath}"`, { stdio: 'inherit' });
        console.log('[Ad-Hoc Signing] Successfully signed the application with entitlements.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed to sign the application:', error);
        throw error;
    }
};
