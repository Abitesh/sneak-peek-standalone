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
            console.log(`[MicrophoneCapture] Initialized with device: ${this.deviceId || 'default'}`);
            this.monitor = new RustMicCapture(this.deviceId);
        }
    }

    public getSampleRate(): number {
        return this.monitor?.getSampleRate() || 16000;
    }

    /**
     * Start capturing microphone audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!this.monitor) {
            console.error('[MicrophoneCapture] Monitor not initialized');
            return;
        }

        try {
            console.log('[MicrophoneCapture] Starting native capture...');

            this.monitor.start((chunk: Buffer) => {
                if (chunk && chunk.length > 0) {
                    // console.log(`[MicrophoneCapture] Received chunk: ${chunk.length} bytes`);
                    this.emit('data', chunk);
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

        this.monitor = null;
        this.isRecording = false;
        this.emit('stop');
    }
}
