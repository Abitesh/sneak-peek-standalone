// electron/personalKnowledge/person1Ipc.ts
//
// IPC registration helper. This deliberately accepts the existing `safeHandle`
// function from electron/ipcHandlers.ts instead of importing/replacing its
// implementation. That keeps Person 1 isolated and makes the integration a
// small, auditable change.

import { dialog } from 'electron';
import path from 'path';
import { getPersonalKnowledgeManager } from './index';

type SafeHandle = (channel: string, handler: (...args: any[]) => any) => void;

const FILE_FILTERS = [
    { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm'] },
    { name: 'Source code', extensions: ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'sh', 'yaml', 'yml'] },
    { name: 'All supported files', extensions: [
        'pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm',
        'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'sh', 'yaml', 'yml',
    ] },
];

export function registerPerson1Ipc(safeHandle: SafeHandle): void {
    safeHandle('personal-files:pick-and-ingest', async () => {
        const picked = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: FILE_FILTERS,
            title: 'Add a file to My Files',
        });

        if (picked.canceled || !picked.filePaths[0]) {
            return { cancelled: true };
        }

        const filePath = path.resolve(picked.filePaths[0]);
        const file = await getPersonalKnowledgeManager().ingestFile(filePath);

        return { success: true, file };
    });

    safeHandle('personal-files:list', async () => {
        return { success: true, files: getPersonalKnowledgeManager().listFiles() };
    });

    safeHandle('personal-files:delete', async (_event: unknown, fileId: string) => {
        if (typeof fileId !== 'string' || !fileId.trim()) {
            return { success: false, error: 'Invalid file id.' };
        }
        return { success: getPersonalKnowledgeManager().deleteFile(fileId) };
    });

    safeHandle('personal-files:search', async (_event: unknown, query: string) => {
        if (typeof query !== 'string') return { success: true, results: [] };
        return {
            success: true,
            results: getPersonalKnowledgeManager().search(query),
        };
    });
}
