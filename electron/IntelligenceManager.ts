// IntelligenceManager.ts
// Central orchestrator for the 5-mode intelligence layer
// Uses mode-specific LLMs for Natively-style interview copilot

import { EventEmitter } from 'events';
import { LLMHelper } from './LLMHelper';

export interface TranscriptSegment {
    marker?: string;
    speaker: string;
    text: string;
    timestamp: number;
    final: boolean;
    confidence?: number;
}

export interface SuggestionTrigger {
    context: string;
    lastQuestion: string;
    confidence: number;
}

import { AnswerLLM, AssistLLM, FollowUpLLM, RecapLLM, FollowUpQuestionsLLM, WhatToAnswerLLM, prepareTranscriptForWhatToAnswer, GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT, buildTemporalContext, AssistantResponse, classifyIntent } from './llm';
import { desktopCapturer } from 'electron';
import { DatabaseManager, Meeting } from './db/DatabaseManager';
const crypto = require('crypto');
import { app } from 'electron';


export const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";


// Refinement intent detection (refined to avoid false positives)
function detectRefinementIntent(userText: string): { isRefinement: boolean; intent: string } {
    const lowercased = userText.toLowerCase().trim();
    const refinementPatterns = [
        { pattern: /make it shorter|shorten this|be brief/i, intent: 'shorten' },
        { pattern: /make it longer|expand on this|elaborate more/i, intent: 'expand' },
        { pattern: /rephrase that|say it differently|put it another way/i, intent: 'rephrase' },
        { pattern: /give me an example|provide an instance/i, intent: 'add_example' },
        { pattern: /make it more confident|be more assertive|sound stronger/i, intent: 'more_confident' },
        { pattern: /make it casual|be less formal|sound relaxed/i, intent: 'more_casual' },
        { pattern: /make it formal|be more professional|sound professional/i, intent: 'more_formal' },
        { pattern: /simplify this|make it simpler|explain specifically/i, intent: 'simplify' },
    ];

    for (const { pattern, intent } of refinementPatterns) {
        if (pattern.test(lowercased)) {
            return { isRefinement: true, intent };
        }
    }

    return { isRefinement: false, intent: '' };
}

// Context item matching Swift ContextManager structure
export interface ContextItem {
    role: 'interviewer' | 'user' | 'assistant';
    text: string;
    timestamp: number;
}

// Mode types
export type IntelligenceMode = 'idle' | 'assist' | 'what_to_say' | 'follow_up' | 'recap' | 'manual' | 'follow_up_questions';

// Events emitted by IntelligenceManager
export interface IntelligenceModeEvents {
    'assist_update': (insight: string) => void;
    'suggested_answer': (answer: string, question: string, confidence: number) => void;
    'suggested_answer_token': (token: string, question: string, confidence: number) => void;
    'refined_answer': (answer: string, intent: string) => void;
    'refined_answer_token': (token: string, intent: string) => void;
    'recap': (summary: string) => void;
    'recap_token': (token: string) => void;
    'follow_up_questions_update': (questions: string) => void;
    'follow_up_questions_token': (token: string) => void;
    'manual_answer_started': () => void;
    'manual_answer_result': (answer: string, question: string) => void;
    'mode_changed': (mode: IntelligenceMode) => void;
    'error': (error: Error, mode: IntelligenceMode) => void;
}

/**
 * IntelligenceManager - Central orchestrator for all intelligence modes
 * Now uses mode-specific LLMs with strict token limits and post-processing
 * 
 * Modes:
 * 1. Assist (passive) - Low-priority insights, cancelable
 * 2. WhatShouldISay (primary) - Auto-triggered answers
 * 3. FollowUp (refinement) - Operate on last assistant message  
 * 4. Recap (summary) - Manual or auto on long conversations
 * 5. Manual (fallback) - Explicit user bypass
 */
export class IntelligenceManager extends EventEmitter {
    // Context management (mirrors Swift ContextManager)
    private contextItems: ContextItem[] = [];
    private readonly contextWindowDuration: number = 120; // 120 seconds
    private readonly maxContextItems: number = 500;

    // Last assistant message for follow-up mode
    private lastAssistantMessage: string | null = null;

    // Temporal RAG: Track all assistant responses in session for anti-repetition
    private assistantResponseHistory: AssistantResponse[] = [];

    private currentMeetingMetadata: {
        title?: string;
        calendarEventId?: string;
        source?: 'manual' | 'calendar';
    } | null = null;

    public setMeetingMetadata(metadata: any) {
        this.currentMeetingMetadata = metadata;
    }

    // Mode state
    private activeMode: IntelligenceMode = 'idle';
    private assistCancellationToken: AbortController | null = null;

    // Mode-specific LLMs (new architecture)
    private answerLLM: AnswerLLM | null = null;
    private assistLLM: AssistLLM | null = null;
    private followUpLLM: FollowUpLLM | null = null;
    private recapLLM: RecapLLM | null = null;
    private followUpQuestionsLLM: FollowUpQuestionsLLM | null = null;
    private whatToAnswerLLM: WhatToAnswerLLM | null = null;

    // Keep reference to LLMHelper for client access
    private llmHelper: LLMHelper;

    // Timestamps for tracking
    private lastTranscriptTime: number = 0;
    private lastTriggerTime: number = 0;
    private readonly triggerCooldown: number = 3000; // 3 seconds




    constructor(llmHelper: LLMHelper) {
        super();
        this.llmHelper = llmHelper;
        this.initializeLLMs();

    }



    /**
     * Initialize or Re-Initialize mode-specific LLMs with shared Gemini client and Groq client
     * Must be called after API keys are updated.
     */
    public initializeLLMs(): void {
        console.log(`[IntelligenceManager] Initializing LLMs with LLMHelper`);
        this.answerLLM = new AnswerLLM(this.llmHelper);
        this.assistLLM = new AssistLLM(this.llmHelper);
        // Wait, I missed AssistLLM in my refactoring list. 
        // But the user plan said: "AnswerLLM", "RecapLLM", "FollowUpLLM", "WhatToAnswerLLM".
        // It didn't mention AssistLLM explicitly but "Refactor feature specific LLM classes".
        // I should probably check AssistLLM too. 
        // For now I'll instantiate others with llmHelper.

        this.followUpLLM = new FollowUpLLM(this.llmHelper);
        this.recapLLM = new RecapLLM(this.llmHelper);
        this.followUpQuestionsLLM = new FollowUpQuestionsLLM(this.llmHelper);
        this.whatToAnswerLLM = new WhatToAnswerLLM(this.llmHelper);
    }



    // ============================================
    // Context Management (mirrors Swift ContextManager)
    // ============================================

    /**
     * Add a transcript segment to context
     * Only stores FINAL transcripts
     */
    addTranscript(segment: TranscriptSegment, skipRefinementCheck: boolean = false): void {
        if (!segment.final) return;

        const role = this.mapSpeakerToRole(segment.speaker);
        const text = segment.text.trim();

        if (!text) return;

        // Deduplicate: check if this exact item already exists
        const lastItem = this.contextItems[this.contextItems.length - 1];
        if (lastItem &&
            lastItem.role === role &&
            Math.abs(lastItem.timestamp - segment.timestamp) < 500 &&
            lastItem.text === text) {
            return;
        }

        this.contextItems.push({
            role,
            text,
            timestamp: segment.timestamp
        });

        this.evictOldEntries();
        this.lastTranscriptTime = Date.now();

        // Log to file
        // Map role to user request: "microphone input as user and system audio tagged as interviewer"
        // 'user' -> 'USER'
        // 'interviewer' -> 'INTERVIEWER'

        // Filter out internal system prompts that might be passed via IPC
        const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
            text.startsWith("You are a helper") ||
            text.startsWith("CONTEXT:");

        if (!isInternalPrompt) {

            // Add to session transcript
            this.fullTranscript.push(segment);
            // Compact transcript with summarization instead of losing early context
            this.compactTranscriptIfNeeded();
        }

        // Check for follow-up intent if user is speaking
        if (!skipRefinementCheck && role === 'user' && this.lastAssistantMessage) {
            const { isRefinement, intent } = detectRefinementIntent(text);
            if (isRefinement) {
                this.runFollowUp(intent, text);
            }
        }
    }

    /**
     * Add assistant-generated message to context
     */
    addAssistantMessage(text: string): void {
        console.log(`[IntelligenceManager] addAssistantMessage called with:`, text.substring(0, 50));

        // Natively-style filtering
        if (!text) return;

        const cleanText = text.trim();
        if (cleanText.length < 10) {
            console.warn(`[IntelligenceManager] Ignored short message (<10 chars)`);
            return;
        }

        if (cleanText.includes("I'm not sure") || cleanText.includes("I can't answer")) {
            console.warn(`[IntelligenceManager] Ignored fallback message`);
            return;
        }

        this.contextItems.push({
            role: 'assistant',
            text: cleanText,
            timestamp: Date.now()
        });

        // Also add to fullTranscript so it persists in the session history (and summaries)
        this.fullTranscript.push({
            speaker: 'assistant',
            text: cleanText,
            timestamp: Date.now(),
            final: true,
            confidence: 1.0
        });

        // Compact transcript with summarization instead of losing early context
        this.compactTranscriptIfNeeded();

        this.lastAssistantMessage = cleanText;

        // Temporal RAG: Track response history for anti-repetition
        this.assistantResponseHistory.push({
            text: cleanText,
            timestamp: Date.now(),
            questionContext: this.getLastInterviewerTurn() || 'unknown'
        });

        // Keep history bounded (last 10 responses)
        if (this.assistantResponseHistory.length > 10) {
            this.assistantResponseHistory = this.assistantResponseHistory.slice(-10);
        }

        console.log(`[IntelligenceManager] lastAssistantMessage updated, history size: ${this.assistantResponseHistory.length}`);
        this.evictOldEntries();
    }

    /**
     * Get context items within the last N seconds
     */
    getContext(lastSeconds: number = 120): ContextItem[] {
        const cutoff = Date.now() - (lastSeconds * 1000);
        return this.contextItems.filter(item => item.timestamp >= cutoff);
    }

    /**
     * Get the last assistant message
     */
    getLastAssistantMessage(): string | null {
        return this.lastAssistantMessage;
    }

    /**
     * Get formatted context string for LLM prompts
     */
    getFormattedContext(lastSeconds: number = 120): string {
        const items = this.getContext(lastSeconds);
        return items.map(item => {
            const label = item.role === 'interviewer' ? 'INTERVIEWER' :
                item.role === 'user' ? 'ME' :
                    'ASSISTANT (PREVIOUS SUGGESTION)';
            return `[${label}]: ${item.text}`;
        }).join('\n');
    }

    /**
     * Get the last interviewer turn
     */
    getLastInterviewerTurn(): string | null {
        for (let i = this.contextItems.length - 1; i >= 0; i--) {
            if (this.contextItems[i].role === 'interviewer') {
                return this.contextItems[i].text;
            }
        }
        return null;
    }

    /**
     * Get full session context from accumulated transcript (User + Interviewer + Assistant)
     */
    private getFullSessionContext(): string {
        const recentTranscript = this.fullTranscript.map(segment => {
            const role = this.mapSpeakerToRole(segment.speaker);
            const label = role === 'interviewer' ? 'INTERVIEWER' :
                role === 'user' ? 'ME' :
                    'ASSISTANT';
            return `[${label}]: ${segment.text}`;
        }).join('\n');

        // Prepend epoch summaries for full session context preservation
        if (this.transcriptEpochSummaries.length > 0) {
            const epochContext = this.transcriptEpochSummaries.join('\n---\n');
            return `[SESSION HISTORY - EARLIER DISCUSSION]\n${epochContext}\n\n[RECENT TRANSCRIPT]\n${recentTranscript}`;
        }

        return recentTranscript;
    }

    private mapSpeakerToRole(speaker: string): 'interviewer' | 'user' | 'assistant' {
        if (speaker === 'user') return 'user';
        if (speaker === 'assistant') return 'assistant';
        return 'interviewer'; // system audio = interviewer
    }

    private evictOldEntries(): void {
        const cutoff = Date.now() - (this.contextWindowDuration * 1000);
        this.contextItems = this.contextItems.filter(item => item.timestamp >= cutoff);

        // Safety limit
        if (this.contextItems.length > this.maxContextItems) {
            this.contextItems = this.contextItems.slice(-this.maxContextItems);
        }
    }

    // ============================================
    // Mode Executors (using mode-specific LLMs)
    // ============================================

    /**
     * MODE 1: Assist (Passive)
     * Low-priority observational insights
     */
    async runAssistMode(): Promise<string | null> {
        // Cancel if higher priority mode is active
        if (this.activeMode !== 'idle' && this.activeMode !== 'assist') {
            return null;
        }

        // Cancel previous assist if running
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
        }

        this.assistCancellationToken = new AbortController();
        this.setMode('assist');

        try {
            if (!this.assistLLM) {
                this.setMode('idle');
                return null;
            }

            const context = this.getFormattedContext(60); // Last 60 seconds
            if (!context) {
                this.setMode('idle');
                return null;
            }

            const insight = await this.assistLLM.generate(context);

            // Check if cancelled
            if (this.assistCancellationToken?.signal.aborted) {
                return null;
            }

            if (insight) {
                this.emit('assist_update', insight);
            }
            this.setMode('idle');
            return insight;

        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                return null;
            }
            this.emit('error', error as Error, 'assist');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 2: What Should I Say (Primary)
     * Manual trigger - uses clean transcript pipeline for question inference
     * NEVER returns null - always provides a usable response
     * @param question - Optional explicit question
     * @param confidence - Confidence score (default 0.8)
     * @param imagePath - Optional path to screenshot for visual context
     */
    async runWhatShouldISay(question?: string, confidence: number = 0.8, imagePath?: string): Promise<string | null> {
        const now = Date.now();

        // Cooldown check
        if (now - this.lastTriggerTime < this.triggerCooldown) {
            return null;
        }

        // Cancel assist mode if active
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('what_to_say');
        this.lastTriggerTime = now;

        try {
            // Use WhatToAnswerLLM for clean pipeline
            if (!this.whatToAnswerLLM) {
                // Fallback to AnswerLLM if not initialized
                if (!this.answerLLM) {
                    this.setMode('idle');
                    return "Please configure your API Keys in Settings to use this feature.";
                }
                const context = this.getFormattedContext(180);
                const answer = await this.answerLLM.generate(question || '', context);
                if (answer) {
                    this.addAssistantMessage(answer);
                    this.emit('suggested_answer', answer, question || 'inferred', confidence);
                }
                this.setMode('idle');
                return answer || "Could you repeat that? I want to make sure I address your question properly.";
            }

            // Prepare transcript using the new clean pipeline
            // Use 180 seconds window for broader context
            const contextItems = this.getContext(180);

            // Inject latest interim transcript if available (critical for latency)
            if (this.lastInterimInterviewer && this.lastInterimInterviewer.text.trim().length > 0) {
                // Check if it's not already in context (by timestamp proximity or exact text)
                const lastItem = contextItems[contextItems.length - 1];
                const isDuplicate = lastItem &&
                    lastItem.role === 'interviewer' &&
                    (lastItem.text === this.lastInterimInterviewer.text || Math.abs(lastItem.timestamp - this.lastInterimInterviewer.timestamp) < 1000); // 1s buffer

                if (!isDuplicate) {
                    console.log(`[IntelligenceManager] Injecting interim transcript: "${this.lastInterimInterviewer.text.substring(0, 50)}..."`);
                    contextItems.push({
                        role: 'interviewer',
                        text: this.lastInterimInterviewer.text,
                        timestamp: this.lastInterimInterviewer.timestamp
                    });
                }
            }

            const transcriptTurns = contextItems.map(item => ({
                role: item.role,
                text: item.text,
                timestamp: item.timestamp
            }));

            // Clean, sparsify, format in one call
            const preparedTranscript = prepareTranscriptForWhatToAnswer(transcriptTurns, 12);

            // Build temporal context for anti-repetition (Temporal RAG)
            const temporalContext = buildTemporalContext(
                contextItems,
                this.assistantResponseHistory,
                180 // 3 minute window
            );

            // Classify intent for answer shaping (lightweight, ~0-5ms)
            const lastInterviewerTurn = this.getLastInterviewerTurn();
            const intentResult = classifyIntent(
                lastInterviewerTurn,
                preparedTranscript,
                this.assistantResponseHistory.length
            );

            console.log(`[IntelligenceManager] Temporal RAG: ${temporalContext.previousResponses.length} responses, tone: ${temporalContext.toneSignals[0]?.type || 'neutral'}, intent: ${intentResult.intent}${imagePath ? ', with image' : ''}`);

            // Single-pass LLM call: question inference + answer generation with temporal context + intent
            // NOW STREAMING - with optional image support

            let fullAnswer = "";
            const stream = this.whatToAnswerLLM.generateStream(preparedTranscript, temporalContext, intentResult, imagePath);

            for await (const token of stream) {
                this.emit('suggested_answer_token', token, question || 'inferred', confidence);
                fullAnswer += token;
            }

            // Sanity check final answer
            if (!fullAnswer || fullAnswer.trim().length < 5) {
                fullAnswer = "Could you repeat that? I want to make sure I address your question properly.";
            }

            // Store in context (WhatToAnswerLLM never returns empty)
            this.addAssistantMessage(fullAnswer);

            // Log Usage
            this.fullUsage.push({
                type: 'assist',
                timestamp: Date.now(),
                question: question || 'What to Answer',
                answer: fullAnswer
            });
            // Cap usage history
            this.capUsageArray();

            // Emit completion event (legacy consumers + done signal)
            this.emit('suggested_answer', fullAnswer, question || 'What to Answer', confidence);

            this.setMode('idle');
            return fullAnswer;

        } catch (error) {
            this.emit('error', error as Error, 'what_to_say');
            this.setMode('idle');
            // Never fail silently - return a usable fallback
            return "Could you repeat that? I want to make sure I address your question properly.";
        }
    }

    /**
     * MODE 3: Follow-Up (Refinement)
     * Modify the last assistant message
     */
    async runFollowUp(intent: string, userRequest?: string): Promise<string | null> {
        console.log(`[IntelligenceManager] runFollowUp called with intent: ${intent}`);
        if (!this.lastAssistantMessage) {
            console.warn('[IntelligenceManager] No lastAssistantMessage found for follow-up');
            return null;
        }

        this.setMode('follow_up');

        try {
            if (!this.followUpLLM) {
                console.error('[IntelligenceManager] FollowUpLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.getFormattedContext(60);
            const refinementRequest = userRequest || intent;

            let fullRefined = "";
            const stream = this.followUpLLM.generateStream(
                this.lastAssistantMessage,
                refinementRequest,
                context
            );

            for await (const token of stream) {
                this.emit('refined_answer_token', token, intent);
                fullRefined += token;
            }

            if (fullRefined) {
                // Store refined answer
                this.addAssistantMessage(fullRefined);
                this.emit('refined_answer', fullRefined, intent);

                // Log Usage
                // Production-ready labeling map
                const intentMap: Record<string, string> = {
                    'shorten': 'Shorten Answer',
                    'expand': 'Expand Answer',
                    'rephrase': 'Rephrase Answer',
                    'add_example': 'Add Example',
                    'more_confident': 'Make More Confident',
                    'more_casual': 'Make More Casual',
                    'more_formal': 'Make More Formal',
                    'simplify': 'Simplify Answer'
                };

                const displayQuestion = userRequest || intentMap[intent] || `Refining: ${intent}`;

                this.fullUsage.push({
                    type: 'followup',
                    timestamp: Date.now(),
                    question: displayQuestion,
                    answer: fullRefined
                });
                // Cap usage history
                this.capUsageArray();
            }

            this.setMode('idle');
            return fullRefined;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 4: Recap (Summary)
     * Neutral conversation summary
     */
    async runRecap(): Promise<string | null> {
        console.log('[IntelligenceManager] runRecap called');
        this.setMode('recap');

        try {
            if (!this.recapLLM) {
                console.error('[IntelligenceManager] RecapLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.getFormattedContext(120);
            if (!context) {
                console.warn('[IntelligenceManager] No context available for recap');
                this.setMode('idle');
                return null;
            }

            let fullSummary = "";
            const stream = this.recapLLM.generateStream(context);

            for await (const token of stream) {
                this.emit('recap_token', token);
                fullSummary += token;
            }

            if (fullSummary) {
                this.emit('recap', fullSummary);

                // Log Usage
                this.fullUsage.push({
                    type: 'chat', // Using 'chat' for generic interaction, or add 'recap' type if supported by UI
                    timestamp: Date.now(),
                    question: 'Recap Meeting',
                    answer: fullSummary
                });
                // Cap usage history
                this.capUsageArray();
            }
            this.setMode('idle');
            return fullSummary;

        } catch (error) {
            this.emit('error', error as Error, 'recap');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 6: Follow-Up Questions
     * Suggest strategic questions for the user to ask
     */
    async runFollowUpQuestions(): Promise<string | null> {
        console.log('[IntelligenceManager] runFollowUpQuestions called');
        this.setMode('follow_up_questions');

        try {
            if (!this.followUpQuestionsLLM) {
                console.error('[IntelligenceManager] FollowUpQuestionsLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.getFormattedContext(120);
            if (!context) {
                console.warn('[IntelligenceManager] No context available for follow-up questions');
                this.setMode('idle');
                return null;
            }

            let fullQuestions = "";
            const stream = this.followUpQuestionsLLM.generateStream(context);

            for await (const token of stream) {
                this.emit('follow_up_questions_token', token);
                fullQuestions += token;
            }

            if (fullQuestions) {
                this.emit('follow_up_questions_update', fullQuestions);
                this.fullUsage.push({
                    type: 'followup_questions',
                    timestamp: Date.now(),
                    question: 'Generate Follow-up Questions',
                    answer: fullQuestions
                });
                // Cap usage history
                this.capUsageArray();
            }
            this.setMode('idle');
            return fullQuestions;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up_questions');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 5: Manual Answer (Fallback)
     * Explicit bypass when auto-detection fails
     */
    async runManualAnswer(question: string): Promise<string | null> {
        this.emit('manual_answer_started');
        this.setMode('manual');

        try {
            if (!this.answerLLM) {
                this.setMode('idle');
                return null;
            }

            // Use AnswerLLM with manual question
            const context = this.getFormattedContext(120);
            const answer = await this.answerLLM.generate(question, context);

            if (answer) {
                // Store in context
                this.addAssistantMessage(answer);
                this.emit('manual_answer_result', answer, question);

                this.fullUsage.push({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: question, // Already passed correctly from user input
                    answer: answer
                });
                // Cap usage history
                this.capUsageArray();
            }

            this.setMode('idle');
            return answer;

        } catch (error) {
            this.emit('error', error as Error, 'manual');
            this.setMode('idle');
            return null;
        }
    }

    // ============================================
    // Trigger Handlers (from NativeAudioClient events)
    // ============================================

    /**
     * Handle incoming transcript from native audio service
     */
    private lastInterimInterviewer: TranscriptSegment | null = null;

    /**
     * Handle incoming transcript from native audio service
     */
    handleTranscript(segment: TranscriptSegment): void {
        // Track interim segments for interviewer to prevent data loss on stop
        if (segment.speaker === 'interviewer') {
            // DEBUG LOGGING
            if (Math.random() < 0.05 || segment.final) {
                console.log(`[IntelligenceManager] RX Interviewer Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }

            if (!segment.final) {
                this.lastInterimInterviewer = segment;
            } else {
                this.lastInterimInterviewer = null;
            }
        }

        this.addTranscript(segment);
    }

    /**
     * Handle suggestion trigger from native audio service
     * This is the primary auto-trigger path
     */
    async handleSuggestionTrigger(trigger: SuggestionTrigger): Promise<void> {
        // Confidence threshold
        if (trigger.confidence < 0.5) {
            return;
        }

        await this.runWhatShouldISay(trigger.lastQuestion, trigger.confidence);
    }

    // ============================================
    // State Management
    // ============================================

    private setMode(mode: IntelligenceMode): void {
        if (this.activeMode !== mode) {
            this.activeMode = mode;
            this.emit('mode_changed', mode);
        }
    }

    getActiveMode(): IntelligenceMode {
        return this.activeMode;
    }

    // Full Session Tracking (Persisted)
    private fullTranscript: TranscriptSegment[] = [];
    private fullUsage: any[] = []; // UsageInteraction
    private sessionStartTime: number = Date.now();

    // Rolling summarization: epoch summaries preserve early context when arrays are compacted
    private transcriptEpochSummaries: string[] = [];
    private isCompacting: boolean = false;

    /**
     * Compact transcript buffer by summarizing oldest entries into an epoch summary.
     * Called instead of raw slice() to preserve early meeting context.
     */
    private async compactTranscriptIfNeeded(): Promise<void> {
        if (this.fullTranscript.length <= 1800 || this.isCompacting) return;

        this.isCompacting = true;
        try {
            // Take the oldest 500 entries to summarize
            const summarizeCount = 500;
            const oldEntries = this.fullTranscript.slice(0, summarizeCount);
            const summaryInput = oldEntries.map(seg => {
                const role = this.mapSpeakerToRole(seg.speaker);
                const label = role === 'interviewer' ? 'INTERVIEWER' :
                    role === 'user' ? 'ME' : 'ASSISTANT';
                return `[${label}]: ${seg.text}`;
            }).join('\n');

            // Fire-and-forget LLM summarization (non-blocking)
            if (this.recapLLM) {
                try {
                    const epochSummary = await this.recapLLM.generate(
                        `Summarize this conversation segment into 3-5 concise bullet points preserving key topics, decisions, and questions:\n\n${summaryInput}`
                    );
                    if (epochSummary && epochSummary.trim().length > 0) {
                        this.transcriptEpochSummaries.push(epochSummary.trim());
                        console.log(`[IntelligenceManager] Epoch summary created (${this.transcriptEpochSummaries.length} total)`);
                    }
                } catch (e) {
                    // If summarization fails, store a simple marker
                    const fallback = `[Earlier discussion: ${oldEntries.length} segments, topics: ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                    this.transcriptEpochSummaries.push(fallback);
                    console.warn('[IntelligenceManager] Epoch summarization failed, using fallback marker');
                }
            }

            // Evict ONLY the exact 500 oldest entries that we just summarized
            this.fullTranscript = this.fullTranscript.slice(summarizeCount);
        } finally {
            this.isCompacting = false;
        }
    }

    /**
     * Cap usage array with simple eviction (usage doesn't need summarization)
     */
    private capUsageArray(): void {
        if (this.fullUsage.length > 500) {
            this.fullUsage = this.fullUsage.slice(-500);
        }
    }

    /**
     * Public method to log usage from external sources (e.g. IPC direct chat)
     */
    public logUsage(type: string, question: string, answer: string): void {
        this.fullUsage.push({
            type,
            timestamp: Date.now(),
            question,
            answer
        });
    }

    /**
     * Save the current session to persistent storage
     */
    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    public async stopMeeting(): Promise<void> {
        console.log('[IntelligenceManager] Stopping meeting and queueing save...');

        // 0. Force-save any pending interim transcript (e.g. interviewer was speaking when stopped)
        if (this.lastInterimInterviewer) {
            console.log('[IntelligenceManager] Force-saving pending interim transcript:', this.lastInterimInterviewer.text);
            // Clone and mark as final so addTranscript accepts it
            const finalSegment = { ...this.lastInterimInterviewer, final: true };
            this.addTranscript(finalSegment);
            this.lastInterimInterviewer = null;
        }

        // 1. Snapshot valid data BEFORE resetting
        const durationMs = Date.now() - this.sessionStartTime;
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            this.reset();
            return;
        }

        const snapshot = {
            transcript: [...this.fullTranscript],
            usage: [...this.fullUsage],
            startTime: this.sessionStartTime,
            durationMs: durationMs,
            context: this.getFullSessionContext() // Use FULL session context, not just recent window
        };

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.reset();

        const meetingId = crypto.randomUUID();
        this.processAndSaveMeeting(snapshot, meetingId).catch(err => {
            console.error('[IntelligenceManager] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        const minutes = Math.floor(durationMs / 60000);
        const seconds = ((durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: durationStr,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            isProcessed: false // Mark as unprocessed initially
        };

        try {
            DatabaseManager.getInstance().saveMeeting(placeholder, snapshot.startTime, durationMs);
            // Notify Frontend
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        } catch (e) {
            console.error("Failed to save placeholder", e);
        }
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(data: { transcript: TranscriptSegment[], usage: any[], startTime: number, durationMs: number, context: string }, meetingId: string): Promise<void> {
        let title = "Untitled Session";
        let summaryData: { actionItems: string[], keyPoints: string[] } = { actionItems: [], keyPoints: [] };
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' = 'manual';

        if (this.currentMeetingMetadata) {
            if (this.currentMeetingMetadata.title) title = this.currentMeetingMetadata.title;
            if (this.currentMeetingMetadata.calendarEventId) calendarEventId = this.currentMeetingMetadata.calendarEventId;
            if (this.currentMeetingMetadata.source) source = this.currentMeetingMetadata.source;
        }

        try {
            // Generate Title (only if not set by calendar)
            if (this.recapLLM && (!this.currentMeetingMetadata || !this.currentMeetingMetadata.title)) {
                const titlePrompt = `Generate a concise 3-6 word title for this meeting context. Output ONLY the title text. Do not use quotes or conversational filler.`;
                const groqTitlePrompt = GROQ_TITLE_PROMPT;

                // Use robust Groq-first generation for title
                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, data.context.substring(0, 5000), groqTitlePrompt);
                if (generatedTitle) title = generatedTitle.replace(/["*]/g, '').trim();
            }

            // Generate Structured Summary
            // Only generate if we have sufficient context/transcript
            if (this.recapLLM && data.transcript.length > 2) {
                const summaryPrompt = `You are a silent meeting summarizer. Convert this conversation into concise internal meeting notes.
    
    RULES:
    - Do NOT invent information not present in the context
    - You MAY infer implied action items or next steps if they are logical consequences of the discussion
    - Do NOT explain or define concepts mentioned
    - Do NOT use filler phrases like "The meeting covered..." or "Discussed various..."
    - Do NOT mention transcripts, AI, or summaries
    - Do NOT sound like an AI assistant
    - Sound like a senior PM's internal notes
    
    STYLE: Calm, neutral, professional, skim-friendly. Short bullets, no sub-bullets.
    
    Return ONLY valid JSON (no markdown code blocks):
    {
      "overview": "1-2 sentence description of what was discussed",
      "keyPoints": ["3-6 specific bullets - each = one concrete topic or point discussed"],
      "actionItems": ["specific next steps, assigned tasks, or implied follow-ups. If absolutely none found, return empty array"]
    }`;

                const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT; // Context is now removed from the template

                // Use the new robust summary generation method
                const generatedSummary = await this.llmHelper.generateMeetingSummary(summaryPrompt, data.context.substring(0, 10000), groqSummaryPrompt);

                if (generatedSummary) {
                    // Try to extract JSON - handle both raw JSON and markdown-wrapped
                    const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
                    const jsonStr = (jsonMatch[1] || generatedSummary).trim();
                    try {
                        summaryData = JSON.parse(jsonStr);
                    } catch (e) { console.error("Failed to parse summary JSON", e); }
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        try {
            // Prepare Meeting Object
            // meetingId is passed in now!
            const minutes = Math.floor(data.durationMs / 60000);
            const seconds = ((data.durationMs % 60000) / 1000).toFixed(0);
            const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(), // This will use current time of completion, maybe usage start time is better? 
                // Actually, using completion time updates the sort order to top.
                // But let's respect original date. Ideally we pass date in data.
                // For now, new Date() is fine as it's just a few seconds difference.
                duration: durationStr,
                summary: "See detailed summary",
                detailedSummary: summaryData,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true // Mark as processed
            };

            // Save to SQLite
            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.durationMs);

            // Clear metadata
            this.currentMeetingMetadata = null;

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

        } catch (error) {
            console.error('[IntelligenceManager] Failed to save meeting:', error);
        }
    }

    /**
     * Recover meetings that were started but not fully processed (e.g. app crash)
     */
    public async recoverUnprocessedMeetings(): Promise<void> {
        console.log('[IntelligenceManager] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[IntelligenceManager] No unprocessed meetings found.');
            return;
        }

        console.log(`[IntelligenceManager] Found ${unprocessed.length} unprocessed meetings. recovering...`);

        for (const m of unprocessed) {
            try {
                const details = db.getMeetingDetails(m.id);
                if (!details) continue;

                console.log(`[IntelligenceManager] Recovering meeting ${m.id}...`);

                // Reconstruct context from transcript
                // Format: [SPEAKER]: text
                const context = details.transcript?.map(t => {
                    const label = t.speaker === 'interviewer' ? 'INTERVIEWER' :
                        t.speaker === 'user' ? 'ME' : 'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                const parts = details.duration.split(':');
                const durationMs = ((parseInt(parts[0]) * 60) + parseInt(parts[1])) * 1000;
                const startTime = new Date(details.date).getTime();

                const snapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime: startTime,
                    durationMs: durationMs,
                    context: context
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[IntelligenceManager] Recovered meeting ${m.id}`);

            } catch (e) {
                console.error(`[IntelligenceManager] Failed to recover meeting ${m.id}`, e);
            }
        }
    }
    /**
     * Clear all context and reset state
     */
    reset(): void {
        this.contextItems = [];
        this.fullTranscript = [];
        this.fullUsage = [];
        this.transcriptEpochSummaries = [];
        this.sessionStartTime = Date.now();
        this.lastAssistantMessage = null;
        this.assistantResponseHistory = []; // Reset temporal RAG history
        this.activeMode = 'idle';
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }
    }

    /**
     * Reinitialize LLMs (e.g., after switching providers)
     */
    reinitializeLLMs(): void {
        this.initializeLLMs();
    }
}
