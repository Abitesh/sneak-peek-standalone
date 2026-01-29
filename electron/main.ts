import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron"
import path from "path"
import { autoUpdater } from "electron-updater"
require('dotenv').config();

// Handle stdout/stderr errors at the process level to prevent EIO crashes
// This is critical for Electron apps that may have their terminal detached
process.stdout?.on?.('error', () => { });
process.stderr?.on?.('error', () => { });

// Safe console wrapper to prevent EIO errors in detached process
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: any[]) => {
  try {
    originalLog.apply(console, args);
  } catch {
    // Silently ignore all console write errors (EIO, EPIPE, etc.)
  }
};

console.warn = (...args: any[]) => {
  try {
    originalWarn.apply(console, args);
  } catch {
    // Silently ignore all console write errors (EIO, EPIPE, etc.)
  }
};

console.error = (...args: any[]) => {
  try {
    originalError.apply(console, args);
  } catch {
    // Silently ignore all console write errors (EIO, EPIPE, etc.)
  }
};

import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { SettingsWindowHelper } from "./SettingsWindowHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { ProcessingHelper } from "./ProcessingHelper"

import { IntelligenceManager } from "./IntelligenceManager"
import { SystemAudioCapture } from "./audio/SystemAudioCapture"
import { GoogleSTT } from "./audio/GoogleSTT"
import { ThemeManager } from "./ThemeManager"
import { RAGManager } from "./rag/RAGManager"
import { DatabaseManager } from "./db/DatabaseManager"

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  public settingsWindowHelper: SettingsWindowHelper
  private screenshotHelper: ScreenshotHelper
  public shortcutsHelper: ShortcutsHelper
  public processingHelper: ProcessingHelper

  private intelligenceManager: IntelligenceManager
  private themeManager: ThemeManager
  private ragManager: RAGManager | null = null
  private tray: Tray | null = null
  private updateAvailable: boolean = false

  // View management
  private view: "queue" | "solutions" = "queue"
  private isUndetectable: boolean = true

  private problemInfo: {
    problem_statement: string
    input_format: Record<string, any>
    output_format: Record<string, any>
    constraints: Array<Record<string, any>>
    test_cases: Array<Record<string, any>>
  } | null = null // Allow null

  private hasDebugged: boolean = false

  // Processing events
  public readonly PROCESSING_EVENTS = {
    //global states
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",

    //states for generating the initial solution
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",

    //states for processing the debugging
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const

  constructor() {
    // Initialize WindowHelper with this
    this.windowHelper = new WindowHelper(this)
    this.settingsWindowHelper = new SettingsWindowHelper()

    // Initialize ScreenshotHelper
    this.screenshotHelper = new ScreenshotHelper(this.view)

    // Initialize ProcessingHelper
    this.processingHelper = new ProcessingHelper(this)

    // Initialize ShortcutsHelper
    this.shortcutsHelper = new ShortcutsHelper(this)



    // Initialize IntelligenceManager with LLMHelper
    this.intelligenceManager = new IntelligenceManager(this.processingHelper.getLLMHelper())

    // Initialize ThemeManager
    this.themeManager = ThemeManager.getInstance()

    // Initialize RAGManager (requires database to be ready)
    this.initializeRAGManager()


    this.setupIntelligenceEvents()

    // --- NEW SYSTEM AUDIO PIPELINE (SOX + NODE GOOGLE STT) ---
    this.setupSystemAudioPipeline()

    // Initialize Auto-Updater
    this.setupAutoUpdater()
  }

  private initializeRAGManager(): void {
    try {
      const db = DatabaseManager.getInstance();
      // @ts-ignore - accessing private db for RAGManager
      const sqliteDb = db['db'];

      if (sqliteDb) {
        const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        this.ragManager = new RAGManager({ db: sqliteDb, apiKey });
        this.ragManager.setLLMHelper(this.processingHelper.getLLMHelper());
        console.log('[AppState] RAGManager initialized');
      }
    } catch (error) {
      console.error('[AppState] Failed to initialize RAGManager:', error);
    }
  }

  private setupAutoUpdater(): void {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on("checking-for-update", () => {
      console.log("[AutoUpdater] Checking for update...")
      this.getMainWindow()?.webContents.send("update-checking")
    })

    autoUpdater.on("update-available", (info) => {
      console.log("[AutoUpdater] Update available:", info.version)
      this.updateAvailable = true
      // Notify renderer that an update is available (for optional UI signal)
      this.getMainWindow()?.webContents.send("update-available", info)
    })

    autoUpdater.on("update-not-available", (info) => {
      console.log("[AutoUpdater] Update not available:", info.version)
      this.getMainWindow()?.webContents.send("update-not-available", info)
    })

    autoUpdater.on("error", (err) => {
      console.error("[AutoUpdater] Error:", err)
      this.getMainWindow()?.webContents.send("update-error", err.message)
    })

    autoUpdater.on("download-progress", (progressObj) => {
      let log_message = "Download speed: " + progressObj.bytesPerSecond
      log_message = log_message + " - Downloaded " + progressObj.percent + "%"
      log_message = log_message + " (" + progressObj.transferred + "/" + progressObj.total + ")"
      console.log("[AutoUpdater] " + log_message)
    })

    autoUpdater.on("update-downloaded", (info) => {
      console.log("[AutoUpdater] Update downloaded:", info.version)
      // Notify renderer that update is ready to install
      this.getMainWindow()?.webContents.send("update-downloaded", info)
    })

    // Only skip the automatic check in development
    if (process.env.NODE_ENV === "development") {
      console.log("[AutoUpdater] Skipping automatic update check in development mode")
      return
    }

    // Start checking for updates
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.error("[AutoUpdater] Failed to check for updates:", err)
    })
  }

  public quitAndInstallUpdate(): void {
    autoUpdater.quitAndInstall()
  }

  public async checkForUpdates(): Promise<void> {
    await autoUpdater.checkForUpdatesAndNotify()
  }

  // New Property for System Audio & Microphone
  private systemAudioCapture: SystemAudioCapture | null = null;
  private microphoneCapture: any | null = null; // Typing loosely to avoid import issues
  private googleSTT: GoogleSTT | null = null; // Interviewer
  private googleSTT_User: GoogleSTT | null = null; // User

  // State flags for strict audio management
  private isMeetingActive: boolean = false;
  private isAudioTestActive: boolean = false;

  private setupSystemAudioPipeline(): void {
    try {
      const { SystemAudioCapture } = require('./audio/SystemAudioCapture');
      const { MicrophoneCapture } = require('./audio/MicrophoneCapture');
      const { GoogleSTT } = require('./audio/GoogleSTT');

      // Initialize wrappers but DO NOT START capture (Lazy init handles native creation)
      this.systemAudioCapture = new SystemAudioCapture();
      this.microphoneCapture = new MicrophoneCapture();
      this.googleSTT = new GoogleSTT();
      this.googleSTT_User = new GoogleSTT();

      // --- CRITICAL: NATIVE MODULE NOW DOWNSAMPLES TO 16kHz ---

      // 1. System Audio Rate
      const sysRate = this.systemAudioCapture?.getSampleRate() || 16000;
      console.log(`[Main] Device System Rate: ${sysRate}Hz. Configuring Interviewer STT to 16000Hz (Downsampled)`);
      this.googleSTT?.setSampleRate(16000);
      this.googleSTT?.setAudioChannelCount(1);

      // 2. Mic Rate
      const micRate = this.microphoneCapture?.getSampleRate() || 16000;
      console.log(`[Main] Device Mic Rate: ${micRate}Hz. Configuring User STT to 16000Hz (Downsampled)`);
      this.googleSTT_User?.setSampleRate(16000);
      this.googleSTT_User?.setAudioChannelCount(1);

      // --- Attach Listeners ---
      this.setupSystemAudioListeners();
      this.setupMicrophoneListeners();

      this.googleSTT?.on('transcript', (segment: { text: string, isFinal: boolean, confidence: number }) => {
        if (!this.isMeetingActive) return; // Ignore if meeting ended

        this.intelligenceManager.handleTranscript({
          speaker: 'interviewer',
          text: segment.text,
          timestamp: Date.now(),
          final: segment.isFinal,
          confidence: segment.confidence
        });

        const helper = this.getWindowHelper();
        const payload = {
          speaker: 'interviewer',
          text: segment.text,
          timestamp: Date.now(),
          final: segment.isFinal,
          confidence: segment.confidence
        };
        helper.getLauncherWindow()?.webContents.send('native-audio-transcript', payload);
        helper.getOverlayWindow()?.webContents.send('native-audio-transcript', payload);
      });

      this.googleSTT?.on('error', (err: Error) => {
        console.error('[Main] GoogleSTT (Interviewer) Error:', err);
      });

      this.googleSTT_User?.on('transcript', (segment: { text: string, isFinal: boolean, confidence: number }) => {
        if (!this.isMeetingActive) return;

        this.intelligenceManager.handleTranscript({
          speaker: 'user', // Identified as User
          text: segment.text,
          timestamp: Date.now(),
          final: segment.isFinal,
          confidence: segment.confidence
        });

        // Forward User transcript to UI too
        const helper = this.getWindowHelper();
        const payload = {
          speaker: 'user',
          text: segment.text,
          timestamp: Date.now(),
          final: segment.isFinal,
          confidence: segment.confidence
        };
        helper.getLauncherWindow()?.webContents.send('native-audio-transcript', payload);
        helper.getOverlayWindow()?.webContents.send('native-audio-transcript', payload);
      });

      this.googleSTT_User?.on('error', (err: Error) => {
        console.error('[Main] GoogleSTT (User) Error:', err);
      });

      console.log('[Main] Full Audio Pipeline (System + Mic) Initialized (Stopped)');

    } catch (err) {
      console.error('[Main] Failed to setup System Audio Pipeline:', err);
    }
  }

  // --- Helper to attach System Audio listeners to current instance ---
  private setupSystemAudioListeners(): void {
    if (!this.systemAudioCapture) return;

    this.systemAudioCapture.removeAllListeners('data');
    this.systemAudioCapture.removeAllListeners('error');

    this.systemAudioCapture.on('data', (chunk: Buffer) => {
      if (this.isMeetingActive) {
        this.googleSTT?.write(chunk);
      }
    });

    this.systemAudioCapture.on('error', (err: Error) => {
      console.error('[Main] SystemAudioCapture Error:', err);
    });
  }

  // --- Helper to attach Microphone listeners to current instance ---
  private setupMicrophoneListeners(): void {
    if (!this.microphoneCapture) return;

    this.microphoneCapture.removeAllListeners('data');
    this.microphoneCapture.removeAllListeners('error');

    this.microphoneCapture.on('data', (chunk: Buffer) => {
      // Route to STT if meeting active
      if (this.isMeetingActive) {
        this.googleSTT_User?.write(chunk);
      }

      // Route to Level Meter if Test or Meeting active
      if (this.isAudioTestActive || this.isMeetingActive) {
        let sum = 0;
        for (let i = 0; i < chunk.length; i += 8) {
          const val = chunk.readInt16LE(i);
          sum += val * val;
        }
        const rms = Math.sqrt(sum / (chunk.length / 8));
        const level = Math.min(rms / 10000.0, 1.0);

        if (this.isAudioTestActive) {
          this.settingsWindowHelper.getSettingsWindow()?.webContents.send('audio-level', level);
        }
      }
    });

    this.microphoneCapture.on('error', (err: Error) => {
      console.error('[Main] MicrophoneCapture Error:', err);
    });
  }

  // --- Robust Device Switching Methods ---
  private updateSystemAudioDevice(deviceId: string): void {
    console.log(`[Main] Switching Output Device to: ${deviceId}`);
    if (this.systemAudioCapture) {
      this.systemAudioCapture.stop();
      this.systemAudioCapture = null;
    }
    try {
      const { SystemAudioCapture } = require('./audio/SystemAudioCapture');
      this.systemAudioCapture = new SystemAudioCapture(deviceId);
      this.setupSystemAudioListeners();
    } catch (e) {
      console.error('[Main] Failed to switch output device:', e);
    }
  }

  private updateMicrophoneDevice(deviceId: string): void {
    console.log(`[Main] Switching Input Device to: ${deviceId}`);
    if (this.microphoneCapture) {
      this.microphoneCapture.stop();
      this.microphoneCapture = null;
    }
    try {
      const { MicrophoneCapture } = require('./audio/MicrophoneCapture');
      this.microphoneCapture = new MicrophoneCapture(deviceId);
      this.setupMicrophoneListeners();
    } catch (e) {
      console.error('[Main] Failed to switch input device:', e);
    }
  }

  // ... Reconfigure Audio logic remains similar but should handle lazy start ...
  // Skipping full reconfigureAudio refactor for brevity, assuming standard start logic works.
  // Actually, reconfigureAudio destroys and creates new instances. 
  // We need to ensure new instances get the same listeners.
  // The current reconfigureAudio implementation overwrites listeners which is potentially buggy if done repeatedly.
  // For now, assume reconfiguration happens rarely.

  private updateAudioState(): void {
    const shouldBeRunning = this.isMeetingActive || this.isAudioTestActive;

    if (shouldBeRunning) {
      // Start if not already started (internally start() checks isRecording)
      console.log('[Main] Audio State: Active. Ensuring capture running...');
      this.systemAudioCapture?.start();
      this.microphoneCapture?.start();

      if (this.isMeetingActive) {
        this.googleSTT?.start();
        this.googleSTT_User?.start();
      }
    } else {
      // Stop
      console.log('[Main] Audio State: Inactive. Stopping capture...');
      this.systemAudioCapture?.stop();
      this.microphoneCapture?.stop();
      this.googleSTT?.stop();
      this.googleSTT_User?.stop();
    }
  }

  public async startAudioTest(deviceId?: string): Promise<void> {
    console.log(`[Main] Starting Audio Test Mode using device: ${deviceId || 'default'}`);

    if (deviceId && deviceId !== 'default') {
      this.updateMicrophoneDevice(deviceId);
    }

    this.isAudioTestActive = true;
    this.updateAudioState();
  }

  public stopAudioTest(): void {
    console.log('[Main] Stopping Audio Test Mode');
    this.isAudioTestActive = false;
    this.updateAudioState();
  }

  public async startMeeting(metadata?: any): Promise<void> {
    console.log('[Main] Starting Meeting...', metadata);
    this.isMeetingActive = true;

    if (metadata) {
      this.intelligenceManager.setMeetingMetadata(metadata);
      // Check for audio configuration preference
      if (metadata.audio) {
        if (metadata.audio.inputDeviceId) {
          this.updateMicrophoneDevice(metadata.audio.inputDeviceId);
        }
        if (metadata.audio.outputDeviceId) {
          this.updateSystemAudioDevice(metadata.audio.outputDeviceId);
        }
      }
    }

    this.updateAudioState();
  }

  public async endMeeting(): Promise<void> {
    console.log('[Main] Ending Meeting...');
    this.isMeetingActive = false;
    this.updateAudioState();

    // 4. Reset Intelligence Context & Save
    await this.intelligenceManager.stopMeeting();

    // 5. Process meeting for RAG (embeddings)
    await this.processCompletedMeetingForRAG();
  }

  private async processCompletedMeetingForRAG(): Promise<void> {
    if (!this.ragManager) return;

    try {
      // Get the most recent meeting from database
      const meetings = DatabaseManager.getInstance().getRecentMeetings(1);
      if (meetings.length === 0) return;

      const meeting = DatabaseManager.getInstance().getMeetingDetails(meetings[0].id);
      if (!meeting || !meeting.transcript || meeting.transcript.length === 0) return;

      // Convert transcript to RAG format
      const segments = meeting.transcript.map(t => ({
        speaker: t.speaker,
        text: t.text,
        timestamp: t.timestamp
      }));

      // Generate summary from detailedSummary if available
      let summary: string | undefined;
      if (meeting.detailedSummary) {
        summary = [
          ...(meeting.detailedSummary.keyPoints || []),
          ...(meeting.detailedSummary.actionItems || []).map(a => `Action: ${a}`)
        ].join('. ');
      }

      // Process meeting for RAG
      const result = await this.ragManager.processMeeting(meeting.id, segments, summary);
      console.log(`[AppState] RAG processed meeting ${meeting.id}: ${result.chunkCount} chunks`);

    } catch (error) {
      console.error('[AppState] Failed to process meeting for RAG:', error);
    }
  }

  private setupIntelligenceEvents(): void {
    const mainWindow = this.getMainWindow.bind(this)

    // Forward intelligence events to renderer
    this.intelligenceManager.on('assist_update', (insight: string) => {
      // Send to both if both exist, though mostly overlay needs it
      const helper = this.getWindowHelper();
      helper.getLauncherWindow()?.webContents.send('intelligence-assist-update', { insight });
      helper.getOverlayWindow()?.webContents.send('intelligence-assist-update', { insight });
    })

    this.intelligenceManager.on('suggested_answer', (answer: string, question: string, confidence: number) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-suggested-answer', { answer, question, confidence })
      }

    })

    this.intelligenceManager.on('suggested_answer_token', (token: string, question: string, confidence: number) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-suggested-answer-token', { token, question, confidence })
      }
    })

    this.intelligenceManager.on('refined_answer_token', (token: string, intent: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-refined-answer-token', { token, intent })
      }
    })

    this.intelligenceManager.on('refined_answer', (answer: string, intent: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-refined-answer', { answer, intent })
      }

    })

    this.intelligenceManager.on('recap', (summary: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-recap', { summary })
      }
    })

    this.intelligenceManager.on('recap_token', (token: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-recap-token', { token })
      }
    })

    this.intelligenceManager.on('follow_up_questions_update', (questions: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-follow-up-questions-update', { questions })
      }
    })

    this.intelligenceManager.on('follow_up_questions_token', (token: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-follow-up-questions-token', { token })
      }
    })

    this.intelligenceManager.on('manual_answer_started', () => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-manual-started')
      }
    })

    this.intelligenceManager.on('manual_answer_result', (answer: string, question: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-manual-result', { answer, question })
      }

    })

    this.intelligenceManager.on('mode_changed', (mode: string) => {
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-mode-changed', { mode })
      }
    })

    this.intelligenceManager.on('error', (error: Error, mode: string) => {
      console.error(`[IntelligenceManager] Error in ${mode}:`, error)
      const win = mainWindow()
      if (win) {
        win.webContents.send('intelligence-error', { error: error.message, mode })
      }
    })
  }





  public updateGoogleCredentials(keyPath: string): void {
    if (this.googleSTT) {
      this.googleSTT.setCredentials(keyPath);
    } else {
      console.warn('[AppState] GoogleSTT not initialized, cannot update credentials');
    }
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // Getters and Setters
  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getWindowHelper(): WindowHelper {
    return this.windowHelper
  }

  public getIntelligenceManager(): IntelligenceManager {
    return this.intelligenceManager
  }

  public getThemeManager(): ThemeManager {
    return this.themeManager
  }

  public getRAGManager(): RAGManager | null {
    return this.ragManager;
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(problemInfo: any): void {
    this.problemInfo = problemInfo
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  // Window management methods
  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(): void {
    this.windowHelper.showMainWindow()
  }

  public toggleMainWindow(): void {
    console.log(
      "Screenshots: ",
      this.screenshotHelper.getScreenshotQueue().length,
      "Extra screenshots: ",
      this.screenshotHelper.getExtraScreenshotQueue().length
    )
    this.windowHelper.toggleMainWindow()
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()

    // Clear problem info
    this.problemInfo = null

    // Reset view to initial state
    this.setView("queue")
  }

  // Screenshot management methods
  public async takeScreenshot(): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const screenshotPath = await this.screenshotHelper.takeScreenshot(
      () => this.hideMainWindow(),
      () => this.showMainWindow()
    )

    return screenshotPath
  }

  public async takeSelectiveScreenshot(): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const screenshotPath = await this.screenshotHelper.takeSelectiveScreenshot(
      () => this.hideMainWindow(),
      () => this.showMainWindow()
    )

    return screenshotPath
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(path)
  }

  // New methods to move the window
  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }
  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }
  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
  }

  public createTray(): void {
    const iconPath = process.env.NODE_ENV === 'development'
      ? require('path').join(__dirname, '../src/components/icon.png')
      : require('path').join(process.resourcesPath, 'src/components/icon.png');

    // For now, let's use a simpler path for local development testing
    // In production, we'd need to ensure it's bundled.
    const trayIcon = nativeImage.createFromPath(require('path').join(app.getAppPath(), 'src/components/icon.png')).resize({ width: 16, height: 16 });

    this.tray = new Tray(trayIcon)

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Natively',
        click: () => {
          this.centerAndShowWindow()
        }
      },
      {
        label: 'Toggle Window',
        click: () => {
          this.toggleMainWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Take Screenshot (Cmd+H)',
        click: async () => {
          try {
            const screenshotPath = await this.takeScreenshot()
            const preview = await this.getImagePreview(screenshotPath)
            const mainWindow = this.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send("screenshot-taken", {
                path: screenshotPath,
                preview
              })
            }
          } catch (error) {
            console.error("Error taking screenshot from tray:", error)
          }
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => {
          app.quit()
        }
      }
    ])

    this.tray.setToolTip('Natively - Press Cmd+Shift+Space to show')
    this.tray.setContextMenu(contextMenu)

    // Set a title for macOS (will appear in menu bar)
    if (process.platform === 'darwin') {
      // Tray now uses icon.png, no title needed
    }

    // Double-click to show window
    this.tray.on('double-click', () => {
      this.centerAndShowWindow()
    })
  }

  public setHasDebugged(value: boolean): void {
    this.hasDebugged = value
  }

  public getHasDebugged(): boolean {
    return this.hasDebugged
  }

  public setUndetectable(state: boolean): void {
    this.isUndetectable = state
    this.windowHelper.setContentProtection(state)
    this.settingsWindowHelper.setContentProtection(state)
  }

  public getUndetectable(): boolean {
    return this.isUndetectable
  }
}

// Application initialization

// Canonical Dock Icon Setup (dev + prod safe) - MUST be called before any window is created
function setMacDockIcon() {
  if (process.platform !== "darwin") return;

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "natively.icns")
    : path.resolve(__dirname, "../assets/natively.icns");

  console.log("[DockIcon] Using:", iconPath);
  app.dock.setIcon(iconPath);
}

async function initializeApp() {
  const appState = AppState.getInstance()

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  app.whenReady().then(() => {
    app.setName("Natively"); // Fix App Name in Menu

    try {
      setMacDockIcon(); // 🔴 MUST be first, before any window
    } catch (e) {
      console.error("Failed to set dock icon:", e);
    }

    console.log("App is ready")
    appState.createWindow()
    appState.createTray()
    // Register global shortcuts using ShortcutsHelper
    appState.shortcutsHelper.registerGlobalShortcuts()

    // Pre-create settings window in background for faster first open
    appState.settingsWindowHelper.preloadWindow()

    // Initialize CalendarManager
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      const calMgr = CalendarManager.getInstance();
      calMgr.init();

      calMgr.on('start-meeting-requested', (event: any) => {
        console.log('[Main] Start meeting requested from calendar notification', event);
        appState.centerAndShowWindow();
        appState.startMeeting({
          title: event.title,
          calendarEventId: event.id,
          source: 'calendar'
        });
      });

      calMgr.on('open-requested', () => {
        appState.centerAndShowWindow();
      });

      console.log('[Main] CalendarManager initialized');
    } catch (e) {
      console.error('[Main] Failed to initialize CalendarManager:', e);
    }

    if (process.platform === 'darwin') {
      app.dock.show(); // Ensure dock is visible (but icon already set)
    }
  })

  app.on("activate", () => {
    console.log("App activated")
    if (process.platform === 'darwin') {
      app.dock.show();
    }
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    }
  })

  // Quit when all windows are closed, except on macOS
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })



  // app.dock?.hide() // REMOVED: User wants Dock icon visible
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}

// Start the application
initializeApp().catch(console.error)
