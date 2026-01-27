// NativeAudioClient.ts
// WebSocket client to connect Electron to the native audio service

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface TranscriptSegment {
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

export interface ServiceStatus {
    state: string;
    micConnected: boolean;
    systemAudioConnected: boolean;
    sttConnected: boolean;
}

export interface NativeServiceMessage {
    type: 'transcript' | 'suggestion_trigger' | 'status';
    data: TranscriptSegment | SuggestionTrigger | ServiceStatus;
    timestamp: number;
}

/**
 * Client for connecting to the native audio service via WebSocket
 * 
 * Events:
 * - 'transcript': Emitted when a transcript is received
 * - 'suggestion': Emitted when AI suggestion should be triggered
 * - 'status': Emitted when service status changes
 * - 'connected': Emitted when connected to service
 * - 'disconnected': Emitted when disconnected from service
 * - 'error': Emitted on errors
 */
export class NativeAudioClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private url: string;
    private reconnectInterval: number = 3000;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isConnecting: boolean = false;
    private shouldReconnect: boolean = true;

    constructor(url: string = 'ws://127.0.0.1:9876/ws') {
        super();
        this.url = url;
    }

    /**
     * Connect to the native audio service
     */
    connect(): Promise<boolean> {
        return new Promise((resolve) => {
            if (this.ws || this.isConnecting) {
                resolve(this.isConnected());
                return;
            }

            this.isConnecting = true;
            this.shouldReconnect = true;

            try {
                this.ws = new WebSocket(this.url);

                this.ws.on('open', () => {
                    this.isConnecting = false;
                    // console.log('[NativeAudioClient] Connected to native audio service');
                    this.emit('connected');
                    resolve(true);
                });

                this.ws.on('close', () => {
                    this.isConnecting = false;
                    this.ws = null;
                    // console.log('[NativeAudioClient] Disconnected from native audio service');
                    this.emit('disconnected');

                    if (this.shouldReconnect) {
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('error', (error: Error) => {
                    this.isConnecting = false;
                    // console.error('[NativeAudioClient] WebSocket error:', error.message);
                    this.emit('error', error);
                    resolve(false);
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data.toString());
                });
            } catch (error) {
                this.isConnecting = false;
                // console.error('[NativeAudioClient] Failed to create WebSocket:', error);
                this.emit('error', error);
                this.scheduleReconnect();
                resolve(false);
            }
        });
    }

    /**
     * Disconnect from the native audio service
     */
    disconnect(): void {
        this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Send pause command to native service
     */
    pause(): void {
        this.send({ type: 'pause' });
    }

    /**
     * Send resume command to native service
     */
    resume(): void {
        this.send({ type: 'resume' });
    }

    /**
     * Request current context from native service
     */
    getContext(): void {
        this.send({ type: 'get_context' });
    }

    /**
     * Send assistant suggestion to native service for context storage
     * This enables Natively-style follow-up commands like "rephrase that" or "make it shorter"
     * @param suggestion - The AI-generated suggestion text
     */
    sendAssistantSuggestion(suggestion: string): void {
        this.send({
            type: 'assistant_suggestion',
            data: { text: suggestion }
        });
        // console.log('[NativeAudioClient] Sent assistant suggestion to native service');
    }

    /**
     * Check if connected to native service
     */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    private send(message: object): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private handleMessage(data: string): void {
        // console.log('[NativeAudioClient] Received message:', data.substring(0, 200));
        try {
            const message: NativeServiceMessage = JSON.parse(data);

            switch (message.type) {
                case 'transcript':
                    const transcript = message.data as TranscriptSegment;
                    this.emit('transcript', transcript);
                    break;

                case 'suggestion_trigger':
                    const suggestion = message.data as SuggestionTrigger;
                    this.emit('suggestion', suggestion);
                    break;

                case 'status':
                    const status = message.data as ServiceStatus;
                    this.emit('status', status);
                    break;

                default:
                // console.log('[NativeAudioClient] Unknown message type:', message.type);
            }
        } catch (error) {
            // console.error('[NativeAudioClient] Failed to parse message:', error);
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.shouldReconnect) {
            return;
        }

        // console.log(`[NativeAudioClient] Reconnecting in ${this.reconnectInterval}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectInterval);
    }
}

// Singleton instance
let nativeAudioClient: NativeAudioClient | null = null;

/**
 * Get or create the shared NativeAudioClient instance
 */
export function getNativeAudioClient(): NativeAudioClient {
    if (!nativeAudioClient) {
        nativeAudioClient = new NativeAudioClient();
    }
    return nativeAudioClient;
}
