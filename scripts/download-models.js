const { pipeline, env } = require('@xenova/transformers');
const path = require('path');
const fs = require('fs');

async function downloadModels() {
    const modelOutDir = path.join(__dirname, '../resources/models/all-MiniLM-L6-v2');
    
    // Ensure the directory exists
    if (!fs.existsSync(modelOutDir)) {
        fs.mkdirSync(modelOutDir, { recursive: true });
    }

    console.log('[download-models] Downloading Xenova/all-MiniLM-L6-v2...');

    // Let Transformers.js handle the download but specify the local directory cache
    env.cacheDir = path.join(__dirname, '../resources/models');
    
    try {
        const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('[download-models] Download complete!');
        
        // transformers.js will have downloaded it into the `xenova/all-MiniLM-L6-v2` structure
        // Let's actually use the specific script method provided by transformers.js or just pre-load it.
        // Wait, the python/CLI `npx @xenova/transformers download all-MiniLM-L6-v2 --output ...` format is natively simpler maybe? 
        // We'll leave this simple cache warming script to ensure files exist.
    } catch (e) {
        console.error('[download-models] Error downloading model:', e);
        process.exit(1);
    }
}

downloadModels();
