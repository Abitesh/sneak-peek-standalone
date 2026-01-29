import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';

let NativeModule: any = null;

try {
    NativeModule = require('../../native-module/index.node');
} catch (e) {
    console.error('[SystemAudioCapture] Failed to load native module:', e);
}

const { SystemAudioCapture: RustAudioCapture } = NativeModule || {};

export class SystemAudioCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private deviceId: string | null = null;
    private detectedSampleRate: number = 16000;

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Rust class implementation not found.');
        } else {
            console.log(`[SystemAudioCapture] Initialized wrapper. Device ID: ${this.deviceId || 'default'}`);
            // Lazy init: Do not create monitor here
        }
    }

    public getSampleRate(): number {
        // Return 16000 default as we effectively downsample to this now
        return this.monitor?.getSampleRate() || 16000;
    }

    /**
     * Start capturing audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustAudioCapture) {
            console.error('[SystemAudioCapture] Cannot start: Rust module missing');
            return;
        }

        // Lazy initialization
        if (!this.monitor) {
            try {
                console.log('[SystemAudioCapture] Creating native monitor...');
                this.monitor = new RustAudioCapture(this.deviceId);
            } catch (e) {
                console.error('[SystemAudioCapture] Failed to create native monitor:', e);
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[SystemAudioCapture] Starting native capture...');

            this.monitor.start((chunk: Buffer) => {
                // The native module sends raw PCM bytes (Buffer)
                if (chunk && chunk.length > 0) {
                    if (Math.random() < 0.05) {
                        const prefix = chunk.slice(0, 10).toString('hex');
                        console.log(`[SystemAudioCapture] Chunk: ${chunk.length}b, Rate: ${this.detectedSampleRate}, Data(hex): ${prefix}...`);
                    }
                    this.emit('data', chunk);
                }
            });

            this.isRecording = true;
            this.emit('start');
        } catch (error) {
            console.error('[SystemAudioCapture] Failed to start:', error);
            this.emit('error', error);
        }
    }

    /**
     * Stop capturing
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[SystemAudioCapture] Stopping capture...');
        try {
            this.monitor?.stop();
        } catch (e) {
            console.error('[SystemAudioCapture] Error stopping:', e);
        }

        // Destroy monitor
        this.monitor = null;
        this.isRecording = false;
        this.emit('stop');
    }
}
