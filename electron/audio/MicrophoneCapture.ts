import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';

// Load the native module
let NativeModule: any = null;

try {
    NativeModule = require('../../native-module/index.node');
} catch (e) {
    console.error('[MicrophoneCapture] Failed to load native module:', e);
}

const { MicrophoneCapture: RustMicCapture } = NativeModule || {};

export class MicrophoneCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private deviceId: string | null = null;

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Rust class implementation not found.');
        } else {
            console.log(`[MicrophoneCapture] Initialized wrapper. Device ID: ${this.deviceId || 'default'}`);
            try {
                console.log('[MicrophoneCapture] Creating native monitor (Eager Init)...');
                this.monitor = new RustMicCapture(this.deviceId);
            } catch (e) {
                console.error('[MicrophoneCapture] Failed to create native monitor:', e);
                // We don't throw here to allow app to start, but start() will fail
            }
        }
    }

    public getSampleRate(): number {
        // Return 16000 default as we effectively downsample to this now
        return this.monitor?.getSampleRate() || 16000;
    }

    /**
     * Start capturing microphone audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustMicCapture) {
            console.error('[MicrophoneCapture] Cannot start: Rust module missing');
            return;
        }

        // Monitor should be ready from constructor
        if (!this.monitor) {
            console.error('[MicrophoneCapture] Monitor not initialized.');
            // Optional: Try to recreate? For now, assume constructor init or failure.
            try {
                this.monitor = new RustMicCapture(this.deviceId);
            } catch (e) {
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[MicrophoneCapture] Starting native capture...');

            this.monitor.start((chunk: Uint8Array) => {
                if (chunk && chunk.length > 0) {
                    this.emit('data', Buffer.from(chunk));
                }
            });

            this.isRecording = true;
            this.emit('start');
        } catch (error) {
            console.error('[MicrophoneCapture] Failed to start:', error);
            this.emit('error', error);
        }
    }

    /**
     * Stop capturing
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[MicrophoneCapture] Stopping capture...');
        try {
            this.monitor?.stop();
        } catch (e) {
            console.error('[MicrophoneCapture] Error stopping:', e);
        }

        // Destroy monitor to release microphone access fully
        this.monitor = null;
        this.isRecording = false;
        this.emit('stop');
    }
}
