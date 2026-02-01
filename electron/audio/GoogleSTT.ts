import { SpeechClient } from '@google-cloud/speech';
import { EventEmitter } from 'events';
import * as path from 'path';

/**
 * GoogleSTT
 * 
 * Manages a bi-directional streaming connection to Google Speech-to-Text.
 * Mirrors the logic previously in Swift:
 * - Handles infinite stream limits by restarting periodically (though less critical for short calls).
 * - Manages authentication via GOOGLE_APPLICATION_CREDENTIALS.
 * - Parses intermediate and final results.
 */
export class GoogleSTT extends EventEmitter {
    private client: SpeechClient | null = null;
    private stream: any = null; // Stream type is complex in google-cloud libs
    private isStreaming = false;
    private isConnecting = false;
    private dataBuffer: Buffer[] = [];
    private streamLabel: string;

    // Config
    private encoding = 'LINEAR16' as const;
    private sampleRateHertz = 16000;
    private audioChannelCount = 1; // Default to Mono
    private languageCode = 'en-US';

    constructor(label: string = 'STT') {
        super();
        this.streamLabel = label;
        // ... (credentials setup) ...
        const path = require('path');
        const dotenvPath = path.resolve(__dirname, '../../.env');
        require('dotenv').config();

        if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            require('dotenv').config({ path: path.join(process.cwd(), '.env') });
        }

        const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (!credentialsPath) {
            console.error('[GoogleSTT] Missing GOOGLE_APPLICATION_CREDENTIALS in environment. Checked CWD:', process.cwd());
        } else {
            console.log(`[GoogleSTT] Using credentials from: ${credentialsPath}`);
        }

        this.client = new SpeechClient({
            keyFilename: credentialsPath
        });
    }

    public setCredentials(keyFilePath: string): void {
        console.log(`[GoogleSTT] Updating credentials to: ${keyFilePath}`);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFilePath;
        this.client = new SpeechClient({
            keyFilename: keyFilePath
        });
    }

    public setSampleRate(rate: number): void {
        if (this.sampleRateHertz === rate) return;
        console.log(`[GoogleSTT] Updating Sample Rate to: ${rate}Hz`);
        this.sampleRateHertz = rate;
        if (this.isStreaming) {
            console.warn('[GoogleSTT] Config changed while streaming. Restarting stream...');
            this.stop();
            this.start();
        }
    }

    public setAudioChannelCount(count: number): void {
        if (this.audioChannelCount === count) return;
        console.log(`[GoogleSTT] Updating Channel Count to: ${count}`);
        this.audioChannelCount = count;
        if (this.isStreaming) {
            console.warn('[GoogleSTT] Config changed while streaming. Restarting stream...');
            this.stop();
            this.start();
        }
    }

    public start(): void {
        if (this.isStreaming) return;

        console.log('[GoogleSTT] Starting recognition stream...');
        this.startStream();
    }

    public stop(): void {
        if (!this.isStreaming) return;

        console.log('[GoogleSTT] Stopping stream...');
        this.isStreaming = false;
        if (this.stream) {
            this.stream.end();
            this.stream.destroy();
            this.stream = null;
        }
    }

    private buffer: Buffer[] = [];
    // private isConnecting = false; // Removed duplicate

    public write(audioData: Buffer): void {
        if (!this.isStreaming || !this.stream) {
            // Buffer if we are in connecting state or just started
            if (this.isConnecting || this.isStreaming) {
                // console.log(`[GoogleSTT] Buffering ${audioData.length} bytes (Stream not ready)`);
                this.buffer.push(audioData);
            }
            return;
        }

        // Safety check to prevent "write after destroyed" error
        if (this.stream.destroyed) {
            this.isStreaming = false;
            this.stream = null;
            return;
        }

        try {
            // Debug log every ~10th write for better visibility
            if (Math.random() < 0.1) {
                console.log(`[GoogleSTT-${this.streamLabel}] Writing ${audioData.length} bytes to stream`);
            }

            if (this.stream.command && this.stream.command.writable) {
                this.stream.write(audioData);
            } else if (this.stream.writable) {
                this.stream.write(audioData);
            } else {
                console.warn(`[GoogleSTT-${this.streamLabel}] Stream not writable!`);
            }
        } catch (err) {
            console.error(`[GoogleSTT-${this.streamLabel}] Safe write failed:`, err);
            this.isStreaming = false;
        }
    }

    private flushBuffer(): void {
        if (!this.stream) return;

        while (this.buffer.length > 0) {
            const data = this.buffer.shift();
            if (data) {
                try {
                    this.stream.write(data);
                } catch (e) {
                    console.error(`[GoogleSTT-${this.streamLabel}] Failed to flush buffer chunk:`, e);
                }
            }
        }
    }

    private startStream(): void {
        this.isStreaming = true;
        this.isConnecting = true;

        this.stream = this.client
            .streamingRecognize({
                config: {
                    encoding: this.encoding,
                    sampleRateHertz: this.sampleRateHertz,
                    audioChannelCount: this.audioChannelCount,
                    languageCode: this.languageCode,
                    enableAutomaticPunctuation: true,
                    model: 'latest_long',
                    useEnhanced: true,
                },
                interimResults: true,
            })
            .on('error', (err: Error) => {
                console.error(`[GoogleSTT-${this.streamLabel}] Stream error:`, err);
                this.emit('error', err);
                this.isConnecting = false;
            })
            .on('data', (data: any) => {
                // DEBUG: Log ALL responses from Google, even empty ones
                const hasResults = data.results && data.results.length > 0;
                const hasAlternatives = hasResults && data.results[0].alternatives && data.results[0].alternatives.length > 0;

                if (!hasResults) {
                    // Log that we received data but no results (happens occasionally)
                    if (Math.random() < 0.1) {
                        console.log(`[GoogleSTT-${this.streamLabel}] Received data but no results`);
                    }
                    return;
                }

                if (data.results[0] && data.results[0].alternatives[0]) {
                    const result = data.results[0];
                    const alt = result.alternatives[0];
                    const transcript = alt.transcript;
                    const isFinal = result.isFinal;

                    if (transcript) {
                        console.log(`[GoogleSTT-${this.streamLabel}] Transcript: "${transcript}" (final: ${isFinal})`);
                        this.emit('transcript', {
                            text: transcript,
                            isFinal,
                            confidence: alt.confidence
                        });
                    }
                }
            });

        // Initialize writeable check or wait for 'open'? 
        // gRPC streams are usually writeable immediately.
        // We can flush immediately after creation.
        this.isConnecting = false;
        this.flushBuffer();

        console.log(`[GoogleSTT-${this.streamLabel}] Stream created. Waiting for events...`);
    }
}
