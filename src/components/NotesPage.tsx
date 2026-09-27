import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, LayoutGrid, Plus, X } from 'lucide-react';
import { useT } from '../i18n';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { isMac } from '../utils/platformUtils';
import type { LocalNote } from '../types/electron';
import { createNoteSaveQueue, type NoteSaveDraft } from './notes/noteSaveQueue';
import WindowControls from './WindowControls';

interface NotesPageProps {
  onBack: () => void;
  onOpenModes?: () => void;
}

function formatUpdatedAt(value: string, t: (key: string) => string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return t('Just now');
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} ${t(minutes === 1 ? 'minute ago' : 'minutes ago')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${t(hours === 1 ? 'hour ago' : 'hours ago')}`;
  const days = Math.floor(hours / 24);
  if (days === 1) return t('Yesterday');
  if (days < 7) return `${days} ${t('days ago')}`;
  return new Date(timestamp).toLocaleDateString();
}

const NotesPage: React.FC<NotesPageProps> = ({ onBack, onOpenModes }) => {
  const t = useT();
  const isLight = useResolvedTheme() === 'light';
  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState('');
  const [persistDraft] = useState(() => createNoteSaveQueue<LocalNote | null>(
    (draft) => window.electronAPI.notesUpdate(draft.id, draft.title, draft.content),
  ));
  const mountedRef = useRef(true);
  const selectedIdRef = useRef<string | null>(null);
  const openSequenceRef = useRef(0);
  const pendingDraftsRef = useRef(new Map<string, NoteSaveDraft>());
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flushingRef = useRef(new Map<string, { draft: NoteSaveDraft; promise: Promise<LocalNote | null> }>());
  const createTitleRef = useRef<HTMLInputElement>(null);

  const updateList = (saved: LocalNote) => {
    if (!mountedRef.current) return;
    setNotes((previous) => [saved, ...previous.filter((note) => note.id !== saved.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  };

  const flushNote = (noteId: string): Promise<LocalNote | null> => {
    const timer = saveTimersRef.current.get(noteId);
    if (timer) clearTimeout(timer);
    saveTimersRef.current.delete(noteId);
    const draft = pendingDraftsRef.current.get(noteId);
    if (!draft) return flushingRef.current.get(noteId)?.promise ?? Promise.resolve(null);
    const existing = flushingRef.current.get(noteId);
    if (existing?.draft === draft) return existing.promise;

    let promise: Promise<LocalNote | null>;
    promise = persistDraft(draft)
      .then((saved) => {
        if (!saved) {
          if (mountedRef.current) setError(t('Could not save note.'));
          return null;
        }
        if (pendingDraftsRef.current.get(noteId) === draft) pendingDraftsRef.current.delete(noteId);
        updateList(saved);
        return saved;
      })
      .catch(() => {
        if (mountedRef.current) setError(t('Could not save note.'));
        return null;
      })
      .finally(() => {
        if (flushingRef.current.get(noteId)?.promise === promise) flushingRef.current.delete(noteId);
      });
    flushingRef.current.set(noteId, { draft, promise });
    return promise;
  };

  const scheduleSave = (draft: NoteSaveDraft) => {
    pendingDraftsRef.current.set(draft.id, draft);
    const previousTimer = saveTimersRef.current.get(draft.id);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => { void flushNote(draft.id); }, 400);
    saveTimersRef.current.set(draft.id, timer);
  };

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    window.electronAPI.notesList()
      .then((items) => { if (active) setNotes(items); })
      .catch(() => { if (active) setError(t('Could not load notes.')); })
      .finally(() => { if (active) setIsLoading(false); });

    const flushOnClose = () => {
      for (const noteId of pendingDraftsRef.current.keys()) void flushNote(noteId);
    };
    window.addEventListener('beforeunload', flushOnClose);
    return () => {
      active = false;
      mountedRef.current = false;
      window.removeEventListener('beforeunload', flushOnClose);
      for (const timer of saveTimersRef.current.values()) clearTimeout(timer);
      saveTimersRef.current.clear();
      for (const noteId of pendingDraftsRef.current.keys()) void flushNote(noteId);
    };
  // Mount-only. `t` is stable for the active language provider.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isCreateOpen) return;
    const frame = requestAnimationFrame(() => createTitleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isCreateOpen]);

  const openNote = async (note: LocalNote) => {
    const sequence = ++openSequenceRef.current;
    const currentId = selectedIdRef.current;
    if (currentId) await flushNote(currentId);
    if (sequence !== openSequenceRef.current) return;
    selectedIdRef.current = note.id;
    setSelectedNoteId(note.id);
    setTitleDraft(note.title);
    setContentDraft(note.content);
    setError('');
  };

  const handleBack = async () => {
    const currentId = selectedIdRef.current;
    if (currentId) {
      await flushNote(currentId);
      selectedIdRef.current = null;
      setSelectedNoteId(null);
      setTitleDraft('');
      setContentDraft('');
      return;
    }
    onBack();
  };

  const createNote = async () => {
    const title = newTitle.trim();
    if (!title) {
      setError(t('Enter a title for the note.'));
      createTitleRef.current?.focus();
      return;
    }
    setError('');
    const note = await window.electronAPI.notesCreate(title);
    if (!note) {
      setError(t('Could not create note.'));
      return;
    }
    setNotes((previous) => [note, ...previous.filter((item) => item.id !== note.id)]);
    setIsCreateOpen(false);
    setNewTitle('');
    await openNote(note);
  };

  const changeTitle = (title: string) => {
    setTitleDraft(title);
    if (!selectedNoteId) return;
    const storedTitle = notes.find((note) => note.id === selectedNoteId)?.title ?? '';
    const normalizedTitle = title.trim() || storedTitle;
    if (title.trim()) setError('');
    scheduleSave({ id: selectedNoteId, title: normalizedTitle, content: contentDraft });
  };

  const changeContent = (content: string) => {
    setContentDraft(content);
    if (!selectedNoteId) return;
    const storedTitle = notes.find((note) => note.id === selectedNoteId)?.title ?? '';
    scheduleSave({ id: selectedNoteId, title: titleDraft.trim() || storedTitle, content });
  };

  const handleModes = async () => {
    if (selectedIdRef.current) await flushNote(selectedIdRef.current);
    onOpenModes?.();
  };

  const selectedNote = selectedNoteId ? notes.find((note) => note.id === selectedNoteId) : null;

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col overflow-hidden bg-bg-primary text-text-primary">
      <header className={`drag-region flex h-12 shrink-0 items-center justify-between border-b border-border-subtle pr-2 ${isLight ? 'bg-bg-primary' : 'bg-bg-secondary'}`}>
        <div className="no-drag flex min-w-0 items-center gap-3">
        {isMac && <div className="w-[70px] shrink-0" />}
        <button type="button" onClick={() => void handleBack()} title={t('Back')} aria-label={t('Back')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-elevated hover:text-text-primary">
          <ArrowLeft size={17} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{selectedNote ? titleDraft : t('Notes')}</h1>
        {!selectedNote && (
          <>
            <button type="button" onClick={() => void handleModes()} title={t('Modes')} aria-label={t('Modes')}
              className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary">
              <LayoutGrid size={15} />
              <span>{t('Modes')}</span>
            </button>
            <button type="button" onClick={() => { setError(''); setNewTitle(''); setIsCreateOpen(true); }} title={t('New Note')} aria-label={t('New Note')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary text-white hover:opacity-90">
              <Plus size={17} />
            </button>
          </>
        )}
        </div>
        {!isMac && <WindowControls />}
      </header>

      {error && <div role="status" className="shrink-0 border-b border-border-subtle px-5 py-2 text-xs text-text-secondary">{error}</div>}

      {selectedNote ? (
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
          <input
            aria-label={t('Title')}
            value={titleDraft}
            onChange={(event) => changeTitle(event.target.value)}
            onBlur={() => {
              if (!titleDraft.trim() && selectedNote) setTitleDraft(selectedNote.title);
              void flushNote(selectedNote.id);
            }}
            className="w-full shrink-0 border-0 border-b border-border-subtle bg-transparent px-1 py-2 text-xl font-semibold text-text-primary outline-none focus:border-accent-primary"
          />
          <textarea
            aria-label={t('Note content')}
            value={contentDraft}
            onChange={(event) => changeContent(event.target.value)}
            onBlur={() => void flushNote(selectedNote.id)}
            placeholder={t('Write your note...')}
            spellCheck
            className="min-h-0 flex-1 resize-none overflow-y-auto rounded-lg border border-border-subtle bg-bg-secondary px-4 py-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-primary"
          />
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-text-secondary">{t('Loading notes...')}</div>
          ) : notes.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-bg-elevated text-text-secondary"><FileText size={20} /></div>
              <p className="text-sm font-medium text-text-primary">{t('No notes yet')}</p>
              <p className="mt-1 text-xs text-text-secondary">{t('Click + to create your first note.')}</p>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {notes.map((note) => (
                <button key={note.id} type="button" onClick={() => void openNote(note)}
                  className="flex w-full items-start justify-between gap-4 rounded-lg border border-border-subtle bg-bg-secondary px-4 py-3 text-left transition-colors hover:bg-bg-elevated">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-primary">{note.title}</span>
                    {note.content && <span className="mt-1 block truncate text-xs text-text-secondary">{note.content.replace(/\s+/g, ' ').slice(0, 120)}</span>}
                  </span>
                  <span className="shrink-0 pt-0.5 text-[11px] text-text-tertiary">{formatUpdatedAt(note.updatedAt, t)}</span>
                </button>
              ))}
            </div>
          )}
        </main>
      )}

      {isCreateOpen && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsCreateOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="new-note-title" className="w-full max-w-sm rounded-xl border border-border-subtle bg-bg-elevated p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="new-note-title" className="text-base font-semibold">{t('New Note')}</h2>
              <button type="button" onClick={() => setIsCreateOpen(false)} title={t('Cancel')} aria-label={t('Cancel')} className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-secondary"><X size={15} /></button>
            </div>
            <label htmlFor="new-note-title-input" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('Title')}</label>
            <input
              ref={createTitleRef}
              id="new-note-title-input"
              value={newTitle}
              onChange={(event) => { setNewTitle(event.target.value); if (event.target.value.trim()) setError(''); }}
              onKeyDown={(event) => { if (event.key === 'Enter') void createNote(); if (event.key === 'Escape') setIsCreateOpen(false); }}
              maxLength={200}
              className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setIsCreateOpen(false)} className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-secondary">{t('Cancel')}</button>
              <button type="button" onClick={() => void createNote()} disabled={!newTitle.trim()} className="rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{t('Add')}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default NotesPage;