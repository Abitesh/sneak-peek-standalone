import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { app } from 'electron';

export class NativeServiceManager {
    private process: ChildProcessWithoutNullStreams | null = null;
    private isRunning: boolean = false;
    private binaryPath: string;

    constructor() {
        // Resolve binary path
        // In dev: native-audio-service/.build/release/copilot-audio-service relative to root
        // In prod: resources/bin/copilot-audio-service (packaged)

        const isProd = app.isPackaged;
        const rootDir = process.cwd(); // In dev, this is project root

        if (isProd) {
            this.binaryPath = path.join(process.resourcesPath, 'bin', 'copilot-audio-service');
        } else {
            this.binaryPath = path.join(rootDir, 'native-audio-service', '.build', 'release', 'copilot-audio-service');
        }
    }

    public start(): boolean {
        if (this.isRunning) {
            console.log('[NativeServiceManager] Service already running.');
            return true;
        }

        console.log(`[NativeServiceManager] Spawning service at: ${this.binaryPath}`);

        try {
            this.process = spawn(this.binaryPath, [], {
                env: {
                    ...process.env,
                    // Pass any necessary env vars here, e.g. PORT
                }
            });

            this.isRunning = true;

            this.process.stdout.on('data', (data) => {
                console.log(`[NativeService] ${data.toString().trim()}`);
            });

            this.process.stderr.on('data', (data) => {
                console.error(`[NativeService ERR] ${data.toString().trim()}`);
            });

            this.process.on('close', (code) => {
                console.log(`[NativeServiceManager] Service exited with code ${code}`);
                this.isRunning = false;
                this.process = null;
            });

            this.process.on('error', (err) => {
                console.error('[NativeServiceManager] Failed to spawn service:', err);
                this.isRunning = false;
            });

            return true;

        } catch (err) {
            console.error('[NativeServiceManager] Exception spawning service:', err);
            return false;
        }
    }

    public stop(): void {
        if (!this.process || !this.isRunning) return;

        console.log('[NativeServiceManager] Stopping service (SIGKILL)...');
        this.process.kill('SIGKILL');

        // Ensure state is updated immediately
        this.isRunning = false;
        this.process = null;
    }
}
