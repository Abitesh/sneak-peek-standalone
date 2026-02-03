import { globalShortcut, app, BrowserWindow } from "electron"
import { AppState } from "./main" // Adjust the import path if necessary

export class ShortcutsHelper {
  private appState: AppState

  constructor(appState: AppState) {
    this.appState = appState
  }

  public registerGlobalShortcuts(): void {
    // Add global shortcut to show/center window
    globalShortcut.register("CommandOrControl+Shift+Space", () => {
      // console.log("Show/Center window shortcut pressed...")
      this.appState.centerAndShowWindow()
    })

    globalShortcut.register("CommandOrControl+H", async () => {
      const mainWindow = this.appState.getMainWindow()
      if (mainWindow) {
        // console.log("Taking screenshot...")
        try {
          const screenshotPath = await this.appState.takeScreenshot()
          const preview = await this.appState.getImagePreview(screenshotPath)
          mainWindow.webContents.send("screenshot-taken", {
            path: screenshotPath,
            preview
          })
        } catch (error) {
          // console.error("Error capturing screenshot:", error)
        }
      }
    })

    // Selective screenshot (latent context)
    globalShortcut.register("CommandOrControl+Shift+H", async () => {
      const mainWindow = this.appState.getMainWindow()
      if (mainWindow) {
        try {
          const screenshotPath = await this.appState.takeSelectiveScreenshot()
          const preview = await this.appState.getImagePreview(screenshotPath)
          // Emitting 'screenshot-attached' means NO auto-analysis
          mainWindow.webContents.send("screenshot-attached", {
            path: screenshotPath,
            preview
          })
        } catch (error) {
          // console.error("Error capturing selective screenshot:", error)
        }
      }
    })

    globalShortcut.register("CommandOrControl+Enter", async () => {
      await this.appState.processingHelper.processScreenshots()
    })

    globalShortcut.register("CommandOrControl+R", () => {
      // console.log(
      //   "Command + R pressed. Canceling requests and resetting queues..."
      // )

      // Cancel ongoing API requests
      this.appState.processingHelper.cancelOngoingRequests()

      // Clear both screenshot queues
      this.appState.clearQueues()

      // console.log("Cleared queues.")

      // Update the view state to 'queue'
      this.appState.setView("queue")

      // Notify renderer process to switch view to 'queue'
      const mainWindow = this.appState.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view")
      }
    })

    // New shortcuts for moving the window
    globalShortcut.register("CommandOrControl+Left", () => {
      // console.log("Command/Ctrl + Left pressed. Moving window left.")
      this.appState.moveWindowLeft()
    })

    globalShortcut.register("CommandOrControl+Right", () => {
      // console.log("Command/Ctrl + Right pressed. Moving window right.")
      this.appState.moveWindowRight()
    })
    globalShortcut.register("CommandOrControl+Down", () => {
      // console.log("Command/Ctrl + down pressed. Moving window down.")
      this.appState.moveWindowDown()
    })
    globalShortcut.register("CommandOrControl+Up", () => {
      // console.log("Command/Ctrl + Up pressed. Moving window Up.")
      this.appState.moveWindowUp()
    })

    globalShortcut.register("CommandOrControl+B", () => {
      const windowHelper = this.appState.getWindowHelper()
      const overlayWindow = windowHelper.getOverlayWindow()
      const launcherWindow = windowHelper.getLauncherWindow()
      const currentMode = windowHelper.getCurrentWindowMode()
      const focusedWindow = BrowserWindow.getFocusedWindow()

      // console.log(`[Shortcuts] Cmd+B pressed. Mode: ${currentMode}, Focused: ${focusedWindow?.id}`)

      // 1. If Launcher is focused, always toggle Launcher (hide it)
      if (focusedWindow && launcherWindow && focusedWindow.id === launcherWindow.id) {
        // console.log('[Shortcuts] Launcher focused -> Hiding Launcher')
        launcherWindow.hide() // Focus lost implies next press will hit fallback logic
        return
      }

      // 2. If Overlay is focused/visible, always toggle Overlay (hide it)
      // Note: Overlay might be "focused" but transparent/click-through? 
      // Usually if user interacts it is focused.
      if (focusedWindow && overlayWindow && focusedWindow.id === overlayWindow.id) {
        // console.log('[Shortcuts] Overlay focused -> Toggling Expand (Hide)')
        overlayWindow.webContents.send('toggle-expand')
        return
      }

      // 3. Fallback: No window focused (or other app focused). 
      // Toggle based on Current Mode.
      if (currentMode === 'overlay' && overlayWindow) {
        // Toggle overlay visibility - send event to renderer to toggle expanded state
        overlayWindow.webContents.send('toggle-expand')
      } else {
        // Launcher mode - toggle launcher visibility
        // console.log(`[Shortcuts] Toggling launcher visibility (Fallback)`)
        if (launcherWindow) {
          if (launcherWindow.isVisible()) {
            launcherWindow.hide()
          } else {
            launcherWindow.show()
            launcherWindow.focus()
          }
        }
      }
    })

    // Unregister shortcuts when quitting
    app.on("will-quit", () => {
      globalShortcut.unregisterAll()
    })
  }
}
