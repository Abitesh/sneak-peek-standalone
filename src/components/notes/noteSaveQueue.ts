export interface NoteSaveDraft {
  id: string;
  title: string;
  content: string;
}

/** Serialize writes per note so an older async save cannot overtake a newer one. */
export function createNoteSaveQueue<T>(
  persist: (draft: NoteSaveDraft) => Promise<T>,
): (draft: NoteSaveDraft) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();

  return (draft) => {
    const snapshot = { ...draft };
    const previous = tails.get(snapshot.id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => persist(snapshot));
    tails.set(snapshot.id, write);
    return write.finally(() => {
      if (tails.get(snapshot.id) === write) tails.delete(snapshot.id);
    });
  };
}