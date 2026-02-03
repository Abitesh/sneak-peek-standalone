
import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';

// Interfaces for our data objects
export interface Meeting {
    id: string;
    title: string;
    date: string; // ISO string
    duration: string;
    summary: string;
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
    calendarEventId?: string;
    source?: 'manual' | 'calendar';
    isProcessed?: boolean;
}

export class DatabaseManager {
    private static instance: DatabaseManager;
    private db: Database.Database | null = null;
    private dbPath: string;

    private constructor() {
        const userDataPath = app.getPath('userData');
        this.dbPath = path.join(userDataPath, 'natively.db');
        this.init();
    }

    public static getInstance(): DatabaseManager {
        if (!DatabaseManager.instance) {
            DatabaseManager.instance = new DatabaseManager();
        }
        return DatabaseManager.instance;
    }

    private init() {
        try {
            console.log(`[DatabaseManager] Initializing database at ${this.dbPath}`);
            // Ensure directory exists (though userData usually does)
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this.db = new Database(this.dbPath, { verbose: console.log });
            this.runMigrations();
        } catch (error) {
            console.error('[DatabaseManager] Failed to initialize database:', error);
            throw error;
        }
    }

    private runMigrations() {
        if (!this.db) return;

        const createMeetingsTable = `
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                title TEXT,
                start_time INTEGER,
                duration_ms INTEGER,
                summary_json TEXT, -- JSON containing actionItems, keyPoints, and legacy summary text if needed
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                calendar_event_id TEXT,
                source TEXT
            );
        `;

        const createTranscriptsTable = `
            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT,
                speaker TEXT,
                content TEXT,
                timestamp_ms INTEGER,
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
        `;

        const createAiInteractionsTable = `
            CREATE TABLE IF NOT EXISTS ai_interactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT,
                type TEXT,
                timestamp INTEGER,
                user_query TEXT,
                ai_response TEXT,
                metadata_json TEXT, -- JSON for lists or extra data
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
        `;

        this.db.exec(createMeetingsTable);
        this.db.exec(createTranscriptsTable);
        this.db.exec(createAiInteractionsTable);

        // RAG: Semantic chunks with embeddings
        const createChunksTable = `
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                speaker TEXT,
                start_timestamp_ms INTEGER,
                end_timestamp_ms INTEGER,
                cleaned_text TEXT NOT NULL,
                token_count INTEGER NOT NULL,
                embedding BLOB,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
        `;
        this.db.exec(createChunksTable);

        // RAG: Meeting-level summaries for global search
        const createChunkSummariesTable = `
            CREATE TABLE IF NOT EXISTS chunk_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL UNIQUE,
                summary_text TEXT NOT NULL,
                embedding BLOB,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
        `;
        this.db.exec(createChunkSummariesTable);

        // RAG: Embedding queue for retry/failure handling
        const createEmbeddingQueueTable = `
            CREATE TABLE IF NOT EXISTS embedding_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                chunk_id INTEGER,
                status TEXT DEFAULT 'pending',
                retry_count INTEGER DEFAULT 0,
                error_message TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                processed_at TEXT
            );
        `;
        this.db.exec(createEmbeddingQueueTable);

        // Create index for chunks lookup
        try {
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON chunks(meeting_id)");
        } catch (e) { /* Index may exist */ }

        // Migration for existing tables
        try {
            this.db.exec("ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT");
        } catch (e) { /* Column likely exists */ }

        try {
            this.db.exec("ALTER TABLE meetings ADD COLUMN source TEXT");
        } catch (e) { /* Column likely exists */ }

        try {
            this.db.exec("ALTER TABLE meetings ADD COLUMN is_processed INTEGER DEFAULT 1"); // Default to 1 (true) for existing records
        } catch (e) { /* Column likely exists */ }

        console.log('[DatabaseManager] Migrations completed.');
    }

    // ============================================
    // Public API
    // ============================================

    public saveMeeting(meeting: Meeting, startTimeMs: number, durationMs: number) {
        if (!this.db) {
            console.error('[DatabaseManager] DB not initialized');
            return;
        }

        const insertMeeting = this.db.prepare(`
            INSERT OR REPLACE INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, calendar_event_id, source, is_processed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertTranscript = this.db.prepare(`
            INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms)
            VALUES (?, ?, ?, ?)
        `);

        const insertInteraction = this.db.prepare(`
            INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const summaryJson = JSON.stringify({
            legacySummary: meeting.summary,
            detailedSummary: meeting.detailedSummary
        });

        const runTransaction = this.db.transaction(() => {
            // 1. Insert Meeting
            insertMeeting.run(
                meeting.id,
                meeting.title,
                startTimeMs,
                durationMs,
                summaryJson,
                meeting.date, // Using the ISO string as created_at for sorting simply
                meeting.calendarEventId || null,
                meeting.source || 'manual',
                meeting.isProcessed ? 1 : 0
            );

            // 2. Insert Transcript
            if (meeting.transcript) {
                for (const segment of meeting.transcript) {
                    insertTranscript.run(
                        meeting.id,
                        segment.speaker,
                        segment.text,
                        segment.timestamp
                    );
                }
            }

            // 3. Insert Interactions
            if (meeting.usage) {
                for (const usage of meeting.usage) {
                    let metadata = null;
                    if (usage.items) {
                        metadata = JSON.stringify(usage.items);
                    } else if (usage.type === 'followup_questions' && usage.answer) {
                        // Sometimes answer is the array for questions, or we store it in metadata
                        // In intelligence manager we pushed: { type: 'followup_questions', answer: fullQuestions }
                        // Let's store that 'answer' (array) in metadata for this type
                        if (Array.isArray(usage.answer)) {
                            metadata = JSON.stringify(usage.answer);
                        }
                    }

                    // Normalization
                    const answerText = Array.isArray(usage.answer) ? null : usage.answer || null;
                    const queryText = usage.question || null;

                    insertInteraction.run(
                        meeting.id,
                        usage.type,
                        usage.timestamp,
                        queryText,
                        answerText,
                        metadata
                    );
                }
            }
        });

        try {
            runTransaction();
            console.log(`[DatabaseManager] Successfully saved meeting ${meeting.id}`);
        } catch (err) {
            console.error(`[DatabaseManager] Failed to save meeting ${meeting.id}`, err);
            throw err;
        }
    }

    public updateMeetingTitle(id: string, title: string): boolean {
        if (!this.db) return false;
        try {
            const stmt = this.db.prepare('UPDATE meetings SET title = ? WHERE id = ?');
            const info = stmt.run(title, id);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to update title for meeting ${id}:`, error);
            return false;
        }
    }

    public updateMeetingSummary(id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string }): boolean {
        if (!this.db) return false;

        try {
            // 1. Get current summary_json
            const row = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id) as any;
            if (!row) return false;

            const existingData = JSON.parse(row.summary_json || '{}');
            const currentDetailed = existingData.detailedSummary || {};

            // 2. Merge updates
            const newDetailed = {
                ...currentDetailed,
                ...updates
            };

            // Should likely filter out undefined updates if spread doesn't handle them how we want, 
            // but spread over undefined is fine. We want to overwrite if provided.
            // If updates.overview is empty string, it overwrites. 
            // If updates.overview is undefined, we use ...updates trick:
            // Actually spread only includes own enumerable properties. If I pass { overview: "new" }, it works.

            // However, we need to be careful not to wipe legacySummary if it exists
            const newData = {
                ...existingData,
                detailedSummary: newDetailed
            };

            const jsonStr = JSON.stringify(newData);

            // 3. Write back
            const stmt = this.db.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?');
            const info = stmt.run(jsonStr, id);
            return info.changes > 0;

        } catch (error) {
            console.error(`[DatabaseManager] Failed to update summary for meeting ${id}:`, error);
            return false;
        }
    }

    public getRecentMeetings(limit: number = 50): Meeting[] {
        if (!this.db) return [];

        const stmt = this.db.prepare(`
            SELECT * FROM meetings 
            ORDER BY created_at DESC 
            LIMIT ?
        `);

        const rows = stmt.all(limit) as any[];

        return rows.map(row => {
            const summaryData = JSON.parse(row.summary_json || '{}');

            // Format duration string if needed, but we typically store ms
            // Let's recreate the 'duration' string "MM:SS" from duration_ms
            const minutes = Math.floor(row.duration_ms / 60000);
            const seconds = Math.floor((row.duration_ms % 60000) / 1000);
            const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

            return {
                id: row.id,
                title: row.title,
                date: row.created_at, // Use the stored ISO string
                duration: durationStr,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source as any,
                // We don't load full transcript/usage for list view to keep it light
                transcript: [] as any[],
                usage: [] as any[]
            };
        });
    }

    public getMeetingDetails(id: string): Meeting | null {
        if (!this.db) return null;

        const meetingStmt = this.db.prepare('SELECT * FROM meetings WHERE id = ?');
        const meetingRow = meetingStmt.get(id) as any;

        if (!meetingRow) return null;

        // Get Transcript
        const transcriptStmt = this.db.prepare('SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY timestamp_ms ASC');
        const transcriptRows = transcriptStmt.all(id) as any[];

        // Get Usage
        const usageStmt = this.db.prepare('SELECT * FROM ai_interactions WHERE meeting_id = ? ORDER BY timestamp ASC');
        const usageRows = usageStmt.all(id) as any[];

        // Reconstruct
        const summaryData = JSON.parse(meetingRow.summary_json || '{}');
        const minutes = Math.floor(meetingRow.duration_ms / 60000);
        const seconds = Math.floor((meetingRow.duration_ms % 60000) / 1000);
        const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        const transcript = transcriptRows.map(row => ({
            speaker: row.speaker,
            text: row.content,
            timestamp: row.timestamp_ms
        }));

        const usage = usageRows.map(row => {
            let items: string[] | undefined;
            let answer = row.ai_response;

            if (row.metadata_json) {
                try {
                    const parsed = JSON.parse(row.metadata_json);
                    if (Array.isArray(parsed)) {
                        items = parsed;
                        // Special case: for 'followup_questions', earlier we treated 'answer' as the array in memory
                        // UI expects appropriate field. If type is 'followup_questions', usually answer is null and items has the questions.
                    }
                } catch (e) { }
            }

            return {
                type: row.type,
                timestamp: row.timestamp,
                question: row.user_query,
                answer: answer,
                items: items
            };
        });

        return {
            id: meetingRow.id,
            title: meetingRow.title,
            date: meetingRow.created_at,
            duration: durationStr,
            summary: summaryData.legacySummary || '',
            detailedSummary: summaryData.detailedSummary,
            calendarEventId: meetingRow.calendar_event_id,
            source: meetingRow.source,
            transcript: transcript,
            usage: usage
        };
    }

    public deleteMeeting(id: string): boolean {
        if (!this.db) return false;

        try {
            const stmt = this.db.prepare('DELETE FROM meetings WHERE id = ?');
            const info = stmt.run(id);
            console.log(`[DatabaseManager] Deleted meeting ${id}. Changes: ${info.changes}`);
            return info.changes > 0;
        } catch (error) {
            console.error(`[DatabaseManager] Failed to delete meeting ${id}:`, error);
            return false;
        }
    }

    public getUnprocessedMeetings(): Meeting[] {
        if (!this.db) return [];

        // is_processed = 0 means false
        const stmt = this.db.prepare(`
            SELECT * FROM meetings 
            WHERE is_processed = 0 
            ORDER BY created_at DESC
        `);

        const rows = stmt.all() as any[];

        return rows.map(row => {
            // Reconstruct minimal meeting object for processing
            // We mainly need ID to fetch transcripts later
            const summaryData = JSON.parse(row.summary_json || '{}');
            const minutes = Math.floor(row.duration_ms / 60000);
            const seconds = Math.floor((row.duration_ms % 60000) / 1000);
            const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

            return {
                id: row.id,
                title: row.title,
                date: row.created_at,
                duration: durationStr,
                summary: summaryData.legacySummary || '',
                detailedSummary: summaryData.detailedSummary,
                calendarEventId: row.calendar_event_id,
                source: row.source,
                isProcessed: false,
                transcript: [] as any[], // Fetched separately via getMeetingDetails or manually if needed
                usage: [] as any[]
            };
        });
    }

    public clearAllData(): boolean {
        if (!this.db) return false;

        try {
            // Clear all tables (order matters due to foreign keys, but SQLite handles with ON DELETE CASCADE)
            this.db.exec('DELETE FROM embedding_queue');
            this.db.exec('DELETE FROM chunk_summaries');
            this.db.exec('DELETE FROM chunks');
            this.db.exec('DELETE FROM ai_interactions');
            this.db.exec('DELETE FROM transcripts');
            this.db.exec('DELETE FROM meetings');

            console.log('[DatabaseManager] All data cleared from database.');
            return true;
        } catch (error) {
            console.error('[DatabaseManager] Failed to clear all data:', error);
            return false;
        }
    }

    public seedDemoMeeting() {
        if (!this.db) return;

        const demoId = 'demo-meeting-003';

        // Check if exists
        const exists = this.db.prepare('SELECT id FROM meetings WHERE id = ?').get(demoId);
        if (exists) {
            console.log('[DatabaseManager] Demo meeting already exists');
            return;
        }

        // Set date to today 9:30 AM
        const today = new Date();
        today.setHours(9, 30, 0, 0);

        const durationMs = 300000; // 5 min

        const summaryMarkdown = `# Next Steps

1. Use Natively on at least 5 calls
2. Try each of the 5 action buttons during calls

## Overview

Natively is your real-time AI meeting assistant. Get instant answers to questions on calls, super-fast AI responses, and comprehensive meeting notes.

## Getting Started

- Click **Start Session** from the dashboard, or join from an upcoming meeting notification.
- Use the 5 quick action buttons for real-time assistance:
  - **What to answer** - AI suggests what you should say based on the conversation
  - **Shorten** - Condenses the last response for quicker delivery
  - **Recap** - Summarizes the entire conversation so far
  - **Follow Up Questions** - Suggests questions you can ask
  - **Answer** - Speak your question and get an instant response
- Show and hide Natively at any time with **Cmd+B** on Mac or **Ctrl+B** on Windows.
- Drag and drop the widget anywhere on your screen by hovering over the top pill.

## Screenshots

- **Full Screen Screenshot**: Press **Cmd+H** to capture the entire screen
- **Selective Screenshot**: Press **Cmd+Shift+H** to select a specific area
- The AI will automatically analyze screenshots and help you with questions

## AI Chat

- Type anything in the input field and press **Enter** or click Submit for an answer
- Attach screenshots for visual context with your questions
- All responses are optimized for speaking out loud

## Meeting Notes

After every call you've recorded with Natively, you'll get:

- **Action Items**: Never miss a detail with detailed next steps
- **Key Points**: Review the main discussion points
- **Meeting Chat**: Chat with your meeting notes and transcript for more insights
- **Transcript**: View the full transcript anytime by clicking the Transcript tab

## Settings

- **Undetectable Mode**: Enable invisibility to screen share for complete privacy
- **Language Preferences**: Change your recognition language in settings

Contact natively.contact@gmail.com for support at anytime.`;

        const demoMeeting: Meeting = {
            id: demoId,
            title: "Natively Demo & Guide",
            date: today.toISOString(),
            duration: "5:00",
            summary: "Complete guide to using Natively - your real-time AI meeting assistant.",
            detailedSummary: {
                overview: summaryMarkdown,
                actionItems: [],
                keyPoints: []
            },
            transcript: [
                { speaker: 'interviewer', text: "Welcome to Natively! Let me show you how it works.", timestamp: 0 },
                { speaker: 'user', text: "Thanks! I'm excited to try it out.", timestamp: 5000 },
                { speaker: 'interviewer', text: "You have 5 quick action buttons. 'What to answer' listens to the conversation and suggests what you should say.", timestamp: 10000 },
                { speaker: 'user', text: "That sounds helpful for interviews.", timestamp: 18000 },
                { speaker: 'interviewer', text: "'Shorten' condenses the last response. 'Recap' summarizes the entire conversation so far.", timestamp: 22000 },
                { speaker: 'user', text: "What about the other buttons?", timestamp: 30000 },
                { speaker: 'interviewer', text: "'Follow Up Questions' suggests questions you can ask. 'Answer' lets you speak a question and get an instant response.", timestamp: 35000 },
                { speaker: 'user', text: "Can I take screenshots during calls?", timestamp: 45000 },
                { speaker: 'interviewer', text: "Yes! Press Cmd+H for full screen or Cmd+Shift+H to select an area. The AI will analyze it and help you.", timestamp: 50000 },
                { speaker: 'user', text: "How do I hide Natively during screen share?", timestamp: 60000 },
                { speaker: 'interviewer', text: "Press Cmd+B to toggle visibility anytime. You can also enable undetectable mode in settings.", timestamp: 65000 },
                { speaker: 'user', text: "This is amazing. What happens after the call?", timestamp: 75000 },
                { speaker: 'interviewer', text: "You get detailed meeting notes with action items, key points, full transcript, and a log of all AI interactions.", timestamp: 80000 }
            ],
            usage: [
                { type: 'assist', timestamp: 15000, question: 'What features does Natively have?', answer: 'Natively offers 5 quick action buttons, screenshot analysis, real-time transcription, and comprehensive meeting notes.' },
                { type: 'followup', timestamp: 40000, question: 'How do the action buttons work?', answer: 'Each button serves a specific purpose: suggest answers, shorten responses, recap conversations, generate follow-up questions, or get instant voice-to-answer responses.' }
            ]
        };

        this.saveMeeting(demoMeeting, today.getTime(), durationMs);
        console.log('[DatabaseManager] Seeded demo meeting.');
    }
}
