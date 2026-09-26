import fs from 'node:fs';

const source = 'electron/LLMHelper.ts';
if (!fs.existsSync(source)) throw new Error('electron/LLMHelper.ts is missing.');
const text = fs.readFileSync(source, 'utf8');
if (!text.includes('retrieveUniversalModeContext')) {
  throw new Error('The extracted Change 50B replacement source is not present. Re-run: unzip -o Change50B_LLMHelper_UniversalRAG.zip');
}
console.log('Change 50B LLMHelper Universal RAG boundary applied.');
