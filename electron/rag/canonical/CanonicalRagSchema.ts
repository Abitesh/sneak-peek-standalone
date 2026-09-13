import type Database from 'better-sqlite3';

/**
 * Change 25 — Step 2.7
 *
 * Installs only the NEW canonical RAG physical foundation. No legacy table is
 * renamed, altered, populated, or read here.
 *
 * `rag_index_status` already exists as a live v36 production contract. The
 * canonical revision-scoped table therefore uses the collision-free physical
 * name `rag_canonical_index_status`. The logical concept remains
 * CanonicalRagIndexStatus.
 */

const INDEX_STATUSES = [
  'NOT_INDEXED', 'QUEUED', 'EXTRACTING', 'OCR_REQUIRED', 'CHUNKING',
  'LEXICAL_READY', 'EMBEDDING', 'READY', 'FAILED',
] as const;

const JOB_TYPES = ['extract', 'chunk', 'rebuild_fts', 'embed', 'rebuild_vector_index'] as const;
const JOB_STATES = ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function installCanonicalRagSchema(db: Database.Database): void {
  const install = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rag_documents (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        owner_id TEXT,
        scope_id TEXT,
        name TEXT NOT NULL,
        path TEXT,
        mime_type TEXT,
        file_type TEXT,
        size_bytes INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        current_revision_id TEXT,
        deleted_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(source_type, source_id),
        FOREIGN KEY(current_revision_id)
          REFERENCES rag_document_revisions(id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_rag_documents_source_type
        ON rag_documents(source_type);
      CREATE INDEX IF NOT EXISTS idx_rag_documents_current_revision
        ON rag_documents(current_revision_id);
      CREATE INDEX IF NOT EXISTS idx_rag_documents_deleted_at
        ON rag_documents(deleted_at);

      CREATE TABLE IF NOT EXISTS rag_document_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        extraction_version TEXT NOT NULL,
        chunking_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        extraction_state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (extraction_state IN ('PENDING', 'EXTRACTED', 'FAILED')),
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(document_id, revision_number),
        UNIQUE(
          document_id,
          content_hash,
          extraction_version,
          chunking_version,
          normalization_version
        ),
        UNIQUE(id, document_id),
        FOREIGN KEY(document_id)
          REFERENCES rag_documents(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rag_document_revisions_document
        ON rag_document_revisions(document_id, revision_number);

      CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        page_start INTEGER,
        page_end INTEGER,
        section TEXT,
        heading TEXT,
        content_type TEXT,
        start_char INTEGER,
        end_char INTEGER,
        table_index INTEGER,
        token_count INTEGER,
        speaker TEXT,
        timestamp_start INTEGER,
        timestamp_end INTEGER,
        source_locator TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(revision_id, chunk_index),
        FOREIGN KEY(revision_id, document_id)
          REFERENCES rag_document_revisions(id, document_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rag_chunks_document
        ON rag_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_rag_chunks_revision
        ON rag_chunks(revision_id, chunk_index);

      CREATE TABLE IF NOT EXISTS rag_embedding_spaces (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        metric TEXT NOT NULL CHECK (metric IN ('cosine')),
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT,
        vector_table_key INTEGER NOT NULL UNIQUE CHECK (vector_table_key > 0),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(provider, model, dimensions, metric, version)
      );

      CREATE TABLE IF NOT EXISTS rag_embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL,
        embedding_space_id TEXT NOT NULL,
        physical_row_key INTEGER NOT NULL UNIQUE,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(chunk_id, embedding_space_id),
        FOREIGN KEY(chunk_id)
          REFERENCES rag_chunks(id)
          ON DELETE CASCADE,
        FOREIGN KEY(embedding_space_id)
          REFERENCES rag_embedding_spaces(id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_rag_embeddings_chunk
        ON rag_embeddings(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_rag_embeddings_space
        ON rag_embeddings(embedding_space_id);

      CREATE TABLE IF NOT EXISTS rag_canonical_index_status (
        document_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('NOT_INDEXED', 'QUEUED', 'EXTRACTING', 'OCR_REQUIRED',
                     'CHUNKING', 'LEXICAL_READY', 'EMBEDDING', 'READY', 'FAILED')
        ),
        chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
        embedded_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (embedded_chunk_count >= 0),
        extracted_page_count INTEGER,
        total_page_count INTEGER,
        error_code TEXT,
        error_message TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(document_id, revision_id),
        FOREIGN KEY(revision_id, document_id)
          REFERENCES rag_document_revisions(id, document_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rag_canonical_index_status_updated
        ON rag_canonical_index_status(updated_at);

      CREATE TABLE IF NOT EXISTS rag_index_jobs (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK (
          job_type IN ('extract', 'chunk', 'rebuild_fts', 'embed', 'rebuild_vector_index')
        ),
        embedding_space_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'COMPLETED', 'FAILED', 'CANCELLED')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        leased_by TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(revision_id, document_id)
          REFERENCES rag_document_revisions(id, document_id)
          ON DELETE CASCADE,
        FOREIGN KEY(embedding_space_id)
          REFERENCES rag_embedding_spaces(id)
          ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_rag_index_jobs_revision_general
        ON rag_index_jobs(document_id, revision_id, job_type)
        WHERE embedding_space_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rag_index_jobs_revision_space
        ON rag_index_jobs(document_id, revision_id, job_type, embedding_space_id)
        WHERE embedding_space_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_rag_index_jobs_claim
        ON rag_index_jobs(state, available_at, lease_until);

      CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        revision_id UNINDEXED,
        source_type UNINDEXED,
        document_name,
        heading,
        section,
        text,
        tokenize = 'unicode61'
      );
    `);

    // Database-level protection for the one invariant that a simple FK cannot
    // express: a document's current revision must belong to that document.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS rag_documents_current_revision_guard_insert
      BEFORE INSERT ON rag_documents
      WHEN NEW.current_revision_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'current_revision_id does not belong to document')
        WHERE NOT EXISTS (
          SELECT 1 FROM rag_document_revisions
          WHERE id = NEW.current_revision_id AND document_id = NEW.id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS rag_documents_current_revision_guard_update
      BEFORE UPDATE OF current_revision_id, id ON rag_documents
      WHEN NEW.current_revision_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'current_revision_id does not belong to document')
        WHERE NOT EXISTS (
          SELECT 1 FROM rag_document_revisions
          WHERE id = NEW.current_revision_id AND document_id = NEW.id
        );
      END;
    `);

    // These constants intentionally remain in source so adding a new state/job
    // requires changing the schema CHECK constraints as well as the service.
    void INDEX_STATUSES;
    void JOB_TYPES;
    void JOB_STATES;
  });

  install();
}
