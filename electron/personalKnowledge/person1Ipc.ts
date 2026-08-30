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
    { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'tsv', 'log', 'toml'] },
    { name: 'Source code', extensions: ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'sh', 'yaml', 'yml'] },
    { name: 'All supported files', extensions: [
        'pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm', 'tsv', 'log', 'toml',
        'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'sh', 'yaml', 'yml',
    ] },
];

export function registerPerson1Ipc(safeHandle: SafeHandle): void {
    const errorMessage = (error: unknown, fallback: string): string =>
        error instanceof Error && error.message ? error.message : fallback;

    safeHandle('personal-files:pick-and-ingest', async () => {
        try {
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
        } catch (error) {
            return { success: false, error: errorMessage(error, 'File indexing failed.') };
        }
    });

    safeHandle('personal-files:list', async () => {
        try {
            return { success: true, files: getPersonalKnowledgeManager().listFiles() };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Could not load My Files.'), files: [] };
        }
    });

    safeHandle('personal-files:set-file-type', async (_event: unknown, fileId: string, fileType: string) => {
        if (typeof fileId !== 'string' || !fileId.trim()) {
            return { success: false, error: 'Invalid file id.' };
        }
        try {
            const file = getPersonalKnowledgeManager().setFileType(fileId, fileType);
            return { success: true, file };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Could not update file type.') };
        }
    });

    safeHandle('personal-files:delete', async (_event: unknown, fileId: string) => {
        if (typeof fileId !== 'string' || !fileId.trim()) {
            return { success: false, error: 'Invalid file id.' };
        }
        try {
            const deleted = getPersonalKnowledgeManager().deleteFile(fileId);
            return deleted ? { success: true } : { success: false, error: 'File not found.' };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Could not delete file.') };
        }
    });

    safeHandle('personal-files:search', async (_event: unknown, query: string) => {
        if (typeof query !== 'string') return { success: true, results: [] };
        try {
            return { success: true, results: getPersonalKnowledgeManager().search(query) };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Could not search My Files.'), results: [] };
        }
    });
}
