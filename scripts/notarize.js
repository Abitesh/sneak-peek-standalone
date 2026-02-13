require('dotenv').config();
const { notarize } = require('@electron/notarize');
const fs = require('fs');
const path = require('path');

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== 'darwin') {
        return;
    }

    const appName = context.packager.appInfo.productFilename;

    // Check for environment variables
    if (!process.env.APPLE_ID || !process.env.APPLE_ID_PASSWORD || !process.env.APPLE_TEAM_ID) {
        console.warn("Skipping notarization: APPLE_ID, APPLE_ID_PASSWORD, or APPLE_TEAM_ID environment variables are missing.");
        return;
    }

    console.log(`Notarizing ${appName}...`);

    try {
        await notarize({
            appBundleId: 'com.electron.meeting-notes',
            appPath: `${appOutDir}/${appName}.app`,
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_ID_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
        });
        console.log(`Done notarizing ${appName}`);
    } catch (error) {
        console.error("Notarization failed:", error);
        // Depending on strictness, you might want to throw error here to fail the build
        // throw error; 
    }
};
