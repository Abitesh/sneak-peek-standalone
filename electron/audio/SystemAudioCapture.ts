import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

/**
 * SystemAudioCapture
 * 
 * Captures system audio via BlackHole using the 'sox' CLI tool.
 * Bypasses the native Swift service for maximum reliability and direct control.
 * 
 * Logic:
 * 1. Spawns 'sox' reading from 'BlackHole 2ch' (CoreAudio).
 * 2. Downsamples to 16kHz Mono 16-bit PCM (Standard for STT).
 * 3. Streams raw bytes to listeners.
 * 4. Performs real-time RMS (Root Mean Square) analysis to detect silence.
 */
export class SystemAudioCapture extends EventEmitter {
    private process: ChildProcessWithoutNullStreams | null = null;
    private isRecording: boolean = false;
    private silenceThreshold: number = 0.01; // ~ -40dB
    private silenceTimer: NodeJS.Timeout | null = null;
    private lastAudioTime: number = Date.now();

    // Configuration
    private readonly deviceName = 'BlackHole 2ch';
    private readonly sampleRate = 16000;

    constructor() {
        super();
    }

    /**
     * Start capturing audio
     */
    public start(): void {
        if (this.isRecording) return;

        console.log('[SystemAudioCapture] Starting capture chain...');

        // Arguments for SoX:
        // -q: Quiet mode (suppress automatic logging except errors)
        // -t coreaudio: Input type
        // "BlackHole 2ch": Input device
        // -r 16000: Resample to 16k
        // -c 1: Downmix to Mono (Google STT uses Mono) - sox intelligently mixes usually
        // -b 16: 16-bit depth
        // -e signed-integer: Encoding
        // -t raw: Output container format (headerless)
        // -: Output to stdout

        // Note: Buffer size (--buffer) might need tuning if latency is high, but defaults are usually fine

        const args = [
            '-q',
            '-t', 'coreaudio', this.deviceName,
            '-r', '16000',
            '-c', '1',
            '-b', '16',
            '-e', 'signed-integer',
            '-t', 'raw',
            '-' // Output to stdout
        ];

        try {
            this.process = spawn('sox', args);
            this.isRecording = true;
            console.log(`[SystemAudioCapture] Spwaned process: sox ${args.join(' ')}`);

            this.setupProcessHandlers();
            this.startSilenceMonitor();

        } catch (error) {
            console.error('[SystemAudioCapture] Failed to spawn sox:', error);
            this.emit('error', new Error(`Failed to start audio capture: ${error}`));
        }
    }

    /**
     * Stop capturing
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[SystemAudioCapture] Stopping capture...');
        this.isRecording = false;

        if (this.silenceTimer) {
            clearInterval(this.silenceTimer);
            this.silenceTimer = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM'); // Nice kill
            this.process = null;
        }
    }

    private setupProcessHandlers(): void {
        if (!this.process) return;

        // --- STDOUT (Audio Data) ---
        this.process.stdout.on('data', (chunk: Buffer) => {
            if (!this.isRecording) return;

            // 1. Emit raw data for STT
            this.emit('data', chunk);

            // 2. Perform RMS Check for diagnostics
            this.checkRMS(chunk);
        });

        // --- STDERR (Errors & Warnings) ---
        this.process.stderr.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            // Ignore some standard sox info if not in quiet mode, but -q should suppress most.
            // Critical errors usually look like "Soundflower: Input/output error" or "Device not found"

            if (msg.includes('HARDWARE-ERROR') || msg.includes('Input/output error') || msg.includes('not found')) {
                console.error(`[SystemAudioCapture] Sox Error: ${msg}`);
                this.emit('error', new Error(msg));
            } else {
                console.log(`[SystemAudioCapture] Sox Log: ${msg}`);
            }
        });

        // --- EXIT ---
        this.process.on('close', (code) => {
            console.log(`[SystemAudioCapture] Sox exited with code ${code}`);
            if (this.isRecording) {
                // Unexpected exit
                this.isRecording = false;
                this.emit('error', new Error(`Audio process exited unexpectedly with code ${code}`));
            }
        });

        this.process.on('error', (err) => {
            console.error('[SystemAudioCapture] Process error:', err);
            this.emit('error', err);
        });
    }

    /**
     * Calculate Root Mean Square to detect if actual audio is flowing
     * vs just empty silence frames.
     */
    private checkRMS(chunk: Buffer): void {
        // 16-bit samples are 2 bytes
        const numSamples = Math.floor(chunk.length / 2);
        if (numSamples === 0) return;

        let sumSquares = 0;

        // Analyze a subset of samples to save CPU (every 10th sample)
        const stride = 10;
        let p = 0;

        for (let i = 0; i < numSamples; i += stride) {
            // Read Int16LE
            const val = chunk.readInt16LE(i * 2);
            // Normalize to -1.0 -> 1.0 range
            const normalized = val / 32768.0;
            sumSquares += normalized * normalized;
            p++;
        }

        const rms = Math.sqrt(sumSquares / p);

        // Update activity timestamp if RMS > threshold
        if (rms > this.silenceThreshold) {
            this.lastAudioTime = Date.now();
        }
    }

    /**
     * Periodic check to warn user if silence persists too long while 'connected'
     * indicating a routing issue (Chrome not sending to BlackHole).
     */
    private startSilenceMonitor(): void {
        this.lastAudioTime = Date.now(); // Reset on start

        this.silenceTimer = setInterval(() => {
            if (!this.isRecording) return;

            const timeSinceAudio = Date.now() - this.lastAudioTime;
            const thresholdMs = 5000; // 5 seconds of absolute silence warning

            // We just emit a 'warning' status, not a hard error.
            // Silence is normal in meetings. But extended absolute pure digital silence 
            // often means the routing is broken (OS output != BlackHole).
            // A noise floor usually keeps RMS > 0 for Mic, but BlackHole is digital zero when empty.

            if (timeSinceAudio > thresholdMs) {
                // Optional: emit warning for UI to show "Is System Audio Playing?" badge
                this.emit('silence_warning', timeSinceAudio);
            } else {
                this.emit('audio_active');
            }

        }, 1000);
    }
}
