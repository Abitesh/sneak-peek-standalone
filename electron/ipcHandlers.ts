// ipcHandlers.ts

import { app, ipcMain, shell, dialog, desktopCapturer, systemPreferences, BrowserWindow, screen } from "electron"
import { AppState } from "./main"
import { GEMINI_FLASH_MODEL, GEMINI_PRO_MODEL } from "./IntelligenceManager"
import { DatabaseManager } from "./db/DatabaseManager"; // Import Database Manager
import * as path from "path";
import * as fs from "fs";

export function initializeIpcHandlers(appState: AppState): void {
  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (!width || !height) return

      const senderWebContents = event.sender
      const settingsWin = appState.settingsWindowHelper.getSettingsWindow()
      const advancedWin = appState.settingsWindowHelper.getAdvancedWindow()

      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.id === senderWebContents.id) {
        appState.settingsWindowHelper.setWindowDimensions(settingsWin, width, height)
      } else if (advancedWin && !advancedWin.isDestroyed() && advancedWin.webContents.id === senderWebContents.id) {
        appState.settingsWindowHelper.setWindowDimensions(advancedWin, width, height)
      }
    }
  )

  ipcMain.handle("set-window-mode", async (event, mode: 'launcher' | 'overlay') => {
    appState.getWindowHelper().setWindowMode(mode);
    return { success: true };
  })

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return appState.deleteScreenshot(path)
  })

  ipcMain.handle("take-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      // console.error("Error taking screenshot:", error)
      throw error
    }
  })

  ipcMain.handle("get-screenshots", async () => {
    // console.log({ view: appState.getView() })
    try {
      let previews = []
      if (appState.getView() === "queue") {
        previews = await Promise.all(
          appState.getScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      } else {
        previews = await Promise.all(
          appState.getExtraScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      }
      // previews.forEach((preview: any) => console.log(preview.path))
      return previews
    } catch (error) {
      // console.error("Error getting screenshots:", error)
      throw error
    }
  })

  ipcMain.handle("toggle-window", async () => {
    appState.toggleMainWindow()
  })

  ipcMain.handle("show-window", async () => {
    // Default show main window (Launcher usually)
    appState.showMainWindow()
  })

  ipcMain.handle("hide-window", async () => {
    appState.hideMainWindow()
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      appState.clearQueues()
      // console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      // console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })



  // Generate suggestion from transcript - Natively-style text-only reasoning
  ipcMain.handle("generate-suggestion", async (event, context: string, lastQuestion: string) => {
    try {
      const suggestion = await appState.processingHelper.getLLMHelper().generateSuggestion(context, lastQuestion)
      return { suggestion }
    } catch (error: any) {
      // console.error("Error generating suggestion:", error)
      throw error
    }
  })

  // IPC handler for analyzing image from file path
  ipcMain.handle("analyze-image-file", async (event, path: string) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().analyzeImageFile(path)
      return result
    } catch (error: any) {
      // console.error("Error in analyze-image-file handler:", error)
      throw error
    }
  })

  ipcMain.handle("gemini-chat", async (event, message: string, imagePath?: string, context?: string, options?: { skipSystemPrompt?: boolean }) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().chatWithGemini(message, imagePath, context, options?.skipSystemPrompt);

      console.log(`[IPC] gemini - chat response: `, result ? result.substring(0, 50) : "(empty)");

      // Don't process empty responses
      if (!result || result.trim().length === 0) {
        console.warn("[IPC] Empty response from LLM, not updating IntelligenceManager");
        return "I apologize, but I couldn't generate a response. Please try again.";
      }

      // Sync with IntelligenceManager so Follow-Up/Recap work
      const intelligenceManager = appState.getIntelligenceManager();

      // 1. Add user question to context (as 'user')
      // CRITICAL: Skip refinement check to prevent auto-triggering follow-up logic
      // The user's manual question is a NEW input, not a refinement of previous answer.
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true
      }, true);

      // 2. Add assistant response and set as last message
      console.log(`[IPC] Updating IntelligenceManager with assistant message...`);
      intelligenceManager.addAssistantMessage(result);
      console.log(`[IPC] Updated IntelligenceManager.Last message: `, intelligenceManager.getLastAssistantMessage()?.substring(0, 50));

      return result;
    } catch (error: any) {
      // console.error("Error in gemini-chat handler:", error);
      throw error;
    }
  });

  // Streaming IPC Handler
  ipcMain.handle("gemini-chat-stream", async (event, message: string, imagePath?: string, context?: string, options?: { skipSystemPrompt?: boolean }) => {
    try {
      console.log("[IPC] gemini-chat-stream started");
      const llmHelper = appState.processingHelper.getLLMHelper();

      // Update IntelligenceManager with USER message immediately
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true
      }, true);

      let fullResponse = "";

      try {
        const stream = llmHelper.streamChatWithGemini(message, imagePath, context, options?.skipSystemPrompt);

        for await (const token of stream) {
          event.sender.send("gemini-stream-token", token);
          fullResponse += token;
        }

        event.sender.send("gemini-stream-done");

        // Update IntelligenceManager with ASSISTANT message after completion
        if (fullResponse.trim().length > 0) {
          intelligenceManager.addAssistantMessage(fullResponse);
        }

      } catch (streamError: any) {
        console.error("[IPC] Streaming error:", streamError);
        event.sender.send("gemini-stream-error", streamError.message || "Unknown streaming error");
      }

      return null; // Return null as data is sent via events

    } catch (error: any) {
      console.error("[IPC] Error in gemini-chat-stream setup:", error);
      throw error;
    }
  });

  ipcMain.handle("quit-app", () => {
    app.quit()
  })

  ipcMain.handle("quit-and-install-update", () => {
    appState.quitAndInstallUpdate()
  })

  ipcMain.handle("delete-meeting", async (_, id: string) => {
    return DatabaseManager.getInstance().deleteMeeting(id);
  });

  ipcMain.handle("check-for-updates", async () => {
    await appState.checkForUpdates()
  })

  // Window movement handlers
  ipcMain.handle("move-window-left", async () => {
    appState.moveWindowLeft()
  })

  ipcMain.handle("move-window-right", async () => {
    appState.moveWindowRight()
  })

  ipcMain.handle("move-window-up", async () => {
    appState.moveWindowUp()
  })

  ipcMain.handle("move-window-down", async () => {
    appState.moveWindowDown()
  })

  ipcMain.handle("center-and-show-window", async () => {
    appState.centerAndShowWindow()
  })

  // Settings Window
  ipcMain.handle("toggle-settings-window", (event, { x, y } = {}) => {
    appState.settingsWindowHelper.toggleWindow(x, y)
  })

  ipcMain.handle("close-settings-window", () => {
    appState.settingsWindowHelper.closeWindow()
  })

  ipcMain.handle("toggle-advanced-settings", () => {
    appState.settingsWindowHelper.toggleAdvancedWindow()
  })

  ipcMain.handle("close-advanced-settings", () => {
    appState.settingsWindowHelper.closeAdvancedWindow()
  })

  ipcMain.handle("set-undetectable", async (_, state: boolean) => {
    appState.setUndetectable(state)
    return { success: true }
  })

  ipcMain.handle("get-undetectable", async () => {
    return appState.getUndetectable()
  })

  ipcMain.handle("set-open-at-login", async (_, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false
    });
    return { success: true };
  });

  ipcMain.handle("get-open-at-login", async () => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  });

  // LLM Model Management Handlers
  ipcMain.handle("get-current-llm-config", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return {
        provider: llmHelper.getCurrentProvider(),
        model: llmHelper.getCurrentModel(),
        isOllama: llmHelper.isUsingOllama()
      };
    } catch (error: any) {
      // console.error("Error getting current LLM config:", error);
      throw error;
    }
  });

  ipcMain.handle("get-available-ollama-models", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const models = await llmHelper.getOllamaModels();
      return models;
    } catch (error: any) {
      // console.error("Error getting Ollama models:", error);
      throw error;
    }
  });

  ipcMain.handle("switch-to-ollama", async (_, model?: string, url?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToOllama(model, url);
      return { success: true };
    } catch (error: any) {
      // console.error("Error switching to Ollama:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("switch-to-gemini", async (_, apiKey?: string, modelId?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToGemini(apiKey, modelId);
      return { success: true };
    } catch (error: any) {
      // console.error("Error switching to Gemini:", error);
      return { success: false, error: error.message };
    }
  });



  ipcMain.handle("set-model-preference", (_, type: "flash" | "pro") => {
    try {
      const im = appState.getIntelligenceManager();
      const model = type === 'pro' ? GEMINI_PRO_MODEL : GEMINI_FLASH_MODEL;
      im.setModel(model);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("test-llm-connection", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const result = await llmHelper.testConnection();
      return result;
    } catch (error: any) {
      // console.error("Error testing LLM connection:", error);
      return { success: false, error: error.message };
    }
  });

  // Native Audio Service Handlers
  ipcMain.handle("native-audio-connect", async () => {
    await appState.connectNativeAudio();
    return { success: true };
  });

  ipcMain.handle("native-audio-disconnect", async () => {
    appState.disconnectNativeAudio();
    return { success: true };
  });

  ipcMain.handle("native-audio-pause", async () => {
    appState.pauseNativeAudio();
    return { success: true };
  });

  ipcMain.handle("native-audio-resume", async () => {
    appState.resumeNativeAudio();
    return { success: true };
  });

  ipcMain.handle("native-audio-status", async () => {
    return { connected: appState.isNativeAudioConnected() };
  });

  // ==========================================
  // Meeting Lifecycle Handlers
  // ==========================================

  ipcMain.handle("start-meeting", async (event, metadata?: any) => {
    try {
      await appState.startMeeting(metadata);
      return { success: true };
    } catch (error: any) {
      console.error("Error starting meeting:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("end-meeting", async () => {
    try {
      await appState.endMeeting();
      return { success: true };
    } catch (error: any) {
      console.error("Error ending meeting:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-recent-meetings", async () => {
    // Fetch from SQLite (limit 50)
    return DatabaseManager.getInstance().getRecentMeetings(50);
  });

  ipcMain.handle("get-meeting-details", async (event, id) => {
    // Helper to fetch full details
    return DatabaseManager.getInstance().getMeetingDetails(id);
  });

  ipcMain.handle("seed-demo", async () => {
    DatabaseManager.getInstance().seedDemoMeeting();
    return { success: true };
  });

  ipcMain.handle("open-external", async (event, url: string) => {
    await shell.openExternal(url);
  });

  // ==========================================
  // Intelligence Mode Handlers
  // ==========================================

  // MODE 1: Assist (Passive observation)
  ipcMain.handle("generate-assist", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const insight = await intelligenceManager.runAssistMode();
      return { insight };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 2: What Should I Say (Primary auto-answer)
  ipcMain.handle("generate-what-to-say", async (_, question?: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      // Question is now optional - IntelligenceManager infers from transcript
      const answer = await intelligenceManager.runWhatShouldISay(question);
      return { answer, question: question || 'inferred from context' };
    } catch (error: any) {
      // Return graceful fallback instead of throwing
      return {
        answer: "Could you repeat that? I want to make sure I address your question properly.",
        question: question || 'unknown'
      };
    }
  });

  // MODE 3: Follow-Up (Refinement)
  ipcMain.handle("generate-follow-up", async (_, intent: string, userRequest?: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const refined = await intelligenceManager.runFollowUp(intent, userRequest);
      return { refined, intent };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 4: Recap (Summary)
  ipcMain.handle("generate-recap", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const summary = await intelligenceManager.runRecap();
      return { summary };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 6: Follow-Up Questions
  ipcMain.handle("generate-follow-up-questions", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const questions = await intelligenceManager.runFollowUpQuestions();
      return { questions };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 5: Manual Answer (Fallback)
  ipcMain.handle("submit-manual-question", async (_, question: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const answer = await intelligenceManager.runManualAnswer(question);
      return { answer, question };
    } catch (error: any) {
      throw error;
    }
  });

  // Get current intelligence context
  ipcMain.handle("get-intelligence-context", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      return {
        context: intelligenceManager.getFormattedContext(),
        lastAssistantMessage: intelligenceManager.getLastAssistantMessage(),
        activeMode: intelligenceManager.getActiveMode()
      };
    } catch (error: any) {
      throw error;
    }
  });

  // Reset intelligence state
  ipcMain.handle("reset-intelligence", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.reset();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });


  // Service Account Selection
  ipcMain.handle("select-service-account", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      const filePath = result.filePaths[0];

      // Update backend state immediately
      appState.updateGoogleCredentials(filePath);

      return { success: true, path: filePath };
    } catch (error: any) {
      console.error("Error selecting service account:", error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Theme System Handlers
  // ==========================================

  ipcMain.handle("theme:get-mode", () => {
    const tm = appState.getThemeManager();
    return {
      mode: tm.getMode(),
      resolved: tm.getResolvedTheme()
    };
  });

  ipcMain.handle("theme:set-mode", (_, mode: 'system' | 'light' | 'dark') => {
    appState.getThemeManager().setMode(mode);
    return { success: true };
  });

  // ==========================================
  // Calendar Integration Handlers
  // ==========================================

  ipcMain.handle("calendar-connect", async () => {
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      await CalendarManager.getInstance().startAuthFlow();
      return { success: true };
    } catch (error: any) {
      console.error("Calendar auth error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("calendar-disconnect", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    await CalendarManager.getInstance().disconnect();
    return { success: true };
  });

  ipcMain.handle("get-calendar-status", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    return CalendarManager.getInstance().getConnectionStatus();
  });

  ipcMain.handle("get-upcoming-events", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    return CalendarManager.getInstance().getUpcomingEvents();
  });

  ipcMain.handle("calendar-refresh", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    await CalendarManager.getInstance().refreshState();
    return { success: true };
  });
}
