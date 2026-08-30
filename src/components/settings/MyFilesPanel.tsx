// src/components/settings/MyFilesPanel.tsx
//
// PERSON 1 renderer surface.
// Add <MyFilesPanel /> to the settings surface where you want "My Files" to
// appear. It owns no persistence itself; all writes go through Electron IPC.

import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Paperclip, Trash2, RefreshCw, Database } from 'lucide-react';

type PersonalFileType = 'resume' | 'job_description' | 'general';
type PersonalFileIndexStatus = 'indexing' | 'done' | 'lexical_only';

type PersonalFile = {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
    chunkCount: number;
    fileType: PersonalFileType;
    indexStatus: PersonalFileIndexStatus;
};

const FILE_TYPE_LABELS: Record<PersonalFileType, string> = {
    resume: 'Resume',
    job_description: 'Job description',
    general: 'General',
};

const STATUS_BADGES: Record<PersonalFileIndexStatus, { label: string; color: string }> = {
    indexing: { label: 'INDEXING', color: '#eab308' },
    done: { label: 'READY', color: '#22c55e' },
    lexical_only: { label: 'NEEDS REPAIR', color: '#f97316' },
};

const normalizeSizeBytes = (value: number | string | undefined | null): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const formatBytes = (bytes: number | string | undefined | null) => {
    const safeBytes = normalizeSizeBytes(bytes);
    if (safeBytes < 1024) return `${safeBytes} B`;
    if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
    return `${(safeBytes / 1024 / 1024).toFixed(1)} MB`;
};

export function MyFilesPanel() {
    const [files, setFiles] = useState<PersonalFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await window.electronAPI?.personalFilesList?.();
            if (result?.success) {
                setFiles((result.files ?? []).map((file: any) => ({
                    ...file,
                    sizeBytes: normalizeSizeBytes(file?.sizeBytes ?? file?.size_bytes),
                    chunkCount: Number.isFinite(Number(file?.chunkCount ?? file?.chunk_count)) ? Number(file?.chunkCount ?? file?.chunk_count) : 0,
                    fileType: (file?.fileType ?? file?.file_type ?? 'general') as PersonalFileType,
                    indexStatus: (file?.indexStatus ?? file?.index_status ?? 'done') as PersonalFileIndexStatus,
                })));
            } else setError(result?.error ?? 'Could not load My Files.');
        } catch (e: any) {
            setError(e?.message ?? 'Could not load My Files.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const addFile = async () => {
        setBusy(true);
        setError('');
        try {
            const result = await window.electronAPI?.personalFilesPickAndIngest?.();
            if (result?.cancelled) return;
            if (!result?.success) {
                setError(result?.error ?? 'File indexing failed.');
                return;
            }
            await refresh();
        } catch (e: any) {
            setError(e?.message ?? 'File indexing failed.');
        } finally {
            setBusy(false);
        }
    };

    const changeFileType = async (file: PersonalFile, fileType: PersonalFileType) => {
        const previous = files;
        setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, fileType } : f)));
        try {
            const result = await window.electronAPI?.personalFilesSetFileType?.(file.id, fileType);
            if (!result?.success) {
                setFiles(previous);
                setError(result?.error ?? 'Could not update file type.');
            }
        } catch (e: any) {
            setFiles(previous);
            setError(e?.message ?? 'Could not update file type.');
        }
    };

    const removeFile = async (file: PersonalFile) => {
        if (!confirm(`Remove "${file.fileName}" from My Files?`)) return;
        setError('');
        try {
            const result = await window.electronAPI?.personalFilesDelete?.(file.id);
            if (!result?.success) {
                setError(result?.error ?? 'Could not delete file.');
                return;
            }
            setFiles(prev => prev.filter(f => f.id !== file.id));
        } catch (e: any) {
            setError(e?.message ?? 'Could not delete file.');
        }
    };

    return (
        <section style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>My Files</h3>
                    <p style={{ margin: '5px 0 0', fontSize: 12, opacity: 0.62 }}>
                        Upload documents once. I can retrieve relevant facts from them in later answers.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading}
                    title="Refresh"
                    style={{ background: 'transparent', border: 0, cursor: 'pointer', opacity: 0.7 }}
                >
                    <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            <div style={{
                display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0',
                padding: '10px 12px', borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.025)',
                fontSize: 11, opacity: 0.72,
            }}>
                <Database size={13} />
                Stored locally in the app database. The full file is not sent to the model on every question.
            </div>

            <button
                type="button"
                onClick={() => void addFile()}
                disabled={busy}
                style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    padding: '8px 13px', borderRadius: 9,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(255,255,255,0.06)',
                    color: 'inherit', cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.5 : 1,
                }}
            >
                {busy ? <RefreshCw size={13} className="animate-spin" /> : <Paperclip size={13} />}
                {busy ? 'Reading & indexing…' : 'Add file'}
            </button>

            {error && (
                <div style={{
                    marginTop: 12, padding: '8px 10px', borderRadius: 8,
                    color: '#ef4444', background: 'rgba(239,68,68,0.08)',
                    fontSize: 11,
                }}>
                    {error}
                </div>
            )}

            <div style={{ marginTop: 16, display: 'grid', gap: 7 }}>
                {files.map(file => {
                    const badge = STATUS_BADGES[file.indexStatus] ?? STATUS_BADGES.done;
                    return (
                    <div
                        key={file.id}
                        style={{
                            display: 'grid', gridTemplateColumns: '20px 1fr auto auto 24px',
                            alignItems: 'center', gap: 8,
                            padding: '9px 10px', borderRadius: 9,
                            border: '1px solid rgba(255,255,255,0.08)',
                            background: 'rgba(255,255,255,0.025)',
                        }}
                    >
                        <FileText size={14} style={{ opacity: 0.65 }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {file.fileName}
                            </div>
                            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>
                                {formatBytes(file.sizeBytes)} · {file.chunkCount} indexed chunks
                            </div>
                        </div>
                        <select
                            value={file.fileType}
                            onChange={(e) => void changeFileType(file, e.target.value as PersonalFileType)}
                            title="Tag this file so relevant answers (résumé/JD questions) can prioritize it"
                            style={{
                                fontSize: 10, padding: '3px 6px', borderRadius: 6,
                                background: 'rgba(255,255,255,0.05)', color: 'inherit',
                                border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer',
                            }}
                        >
                            {(Object.keys(FILE_TYPE_LABELS) as PersonalFileType[]).map((type) => (
                                <option key={type} value={type}>{FILE_TYPE_LABELS[type]}</option>
                            ))}
                        </select>
                        <span style={{ fontSize: 9, color: badge.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{badge.label}</span>
                        <button
                            type="button"
                            onClick={() => void removeFile(file)}
                            title="Remove file"
                            style={{ background: 'transparent', border: 0, cursor: 'pointer', opacity: 0.55 }}
                        >
                            <Trash2 size={13} />
                        </button>
                    </div>
                    );
                })}

                {!loading && files.length === 0 && (
                    <div style={{ padding: '28px 16px', textAlign: 'center', opacity: 0.45, fontSize: 12 }}>
                        No files yet. Add your resume, project docs, notes, PDFs, or other personal reference material.
                    </div>
                )}
            </div>
        </section>
    );
}
