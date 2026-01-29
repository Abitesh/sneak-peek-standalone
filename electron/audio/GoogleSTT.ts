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
    private client: SpeechClient;
    private stream: any = null; // Stream type is complex in google-cloud libs
    private isStreaming = false;

    // Config
    private encoding = 'LINEAR16' as const;
    private sampleRateHertz = 16000;
    private audioChannelCount = 1; // Default to Mono
    private languageCode = 'en-US';

    constructor() {
        super();
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

    public write(audioData: Buffer): void {
        if (!this.isStreaming || !this.stream) {
            return;
        }

        // Safety check to prevent "write after destroyed" error
        if (this.stream.destroyed) {
            // console.warn('[GoogleSTT] Attempted to write to destroyed stream, stopping...');
            this.isStreaming = false;
            this.stream = null;
            return;
        }

        try {
            if (this.stream.command && this.stream.command.writable) { // gRPC stream internal check
                if (audioData.length !== 320 && audioData.length !== 640) {
                    console.warn('[GoogleSTT] Unexpected audio frame size:', audioData.length);
                }
                this.stream.write(audioData);
            } else if (this.stream.writable) {
                if (audioData.length !== 320 && audioData.length !== 640) {
                    console.warn('[GoogleSTT] Unexpected audio frame size:', audioData.length);
                }
                this.stream.write(audioData);
            }
        } catch (err) {
            console.error('[GoogleSTT] Safe write failed:', err);
            this.isStreaming = false;
        }
    }

    private startStream(): void {
        this.isStreaming = true;

        this.stream = this.client
            .streamingRecognize({
                config: {
                    encoding: this.encoding,
                    sampleRateHertz: this.sampleRateHertz,
                    audioChannelCount: this.audioChannelCount,
                    languageCode: this.languageCode,
                    enableAutomaticPunctuation: true,
                    model: 'latest_long', // Optimized for long form
                    useEnhanced: true,
                },
                interimResults: true, // We want real-time feedback
            })
            .on('error', (err: Error) => {
                console.error('[GoogleSTT] Stream error:', err);
                this.emit('error', err);

                // Simple auto-reconnect strategy could go here
                // For now, we notify parent to decide.
            })
            .on('data', (data: any) => {
                // Parse results
                if (data.results[0] && data.results[0].alternatives[0]) {
                    const result = data.results[0];
                    const alt = result.alternatives[0];
                    const transcript = alt.transcript;
                    const isFinal = result.isFinal;

                    if (transcript) {
                        this.emit('transcript', {
                            text: transcript,
                            isFinal,
                            confidence: alt.confidence
                        });
                    }
                }
            });

        console.log('[GoogleSTT] Stream created. Waiting for events...');
    }
}
