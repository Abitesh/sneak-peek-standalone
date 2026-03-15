## Summary

Version 2.0.5 delivers major reliability fixes to Stealth Mode and Process Disguise.

## Improvements

- **Stealth Mode UI**: The Process Disguise selector is now visually disabled and locked while Undetectable mode is active, preventing accidental state mismatches.
- **State Synchronization**: Greatly improved internal state synchronization across all application windows (Settings, Launcher, Overlay).

## Fixes

- **Infinite Feedback Loops**: Completely eliminated the bug where toggling Undetectable mode would sometimes cause the app to rapidly toggle itself on and off.
- **Delayed Dock Reappearance**: Fixed a regression where the macOS dock icon would mysteriously reappear several seconds after entering stealth mode if a disguise had recently been changed.
- **Initial State Loading**: Fixed an issue where the Settings UI would briefly show incorrect toggle states when first opened.
- **macOS OS-level Events**: Hardened the app against macOS `activate` events (like clicking the app in Finder) accidentally breaking stealth mode.

## Technical

- Refactored IPC (Inter-Process Communication) listeners for `SettingsPopup` and `SettingsOverlay` to use a strict one-way (receive-only) data binding pattern.
- Added strict management and cancellation of `forceUpdate` timeouts during stealth mode transitions.
- Added explicit type safety for the new getters in `electron.d.ts`.

## ⚠️macOS Installation (Unsigned Build)

Download the correct architecture .zip or .dmg file for your device (Apple Silicon or Intel).

If you see "App is damaged":

- **For .zip downloads:**
  1. Move the app to your Applications folder.
  2. Open Terminal and run: `xattr -cr /Applications/Natively.app`

- **For .dmg downloads:**
  1. Open Terminal and run:
     ```bash
     xattr -cr ~/Downloads/Natively-2.0.5-arm64.dmg
     # Or for Intel Macs:
     xattr -cr ~/Downloads/Natively-2.0.5-x64.dmg
     ```
  2. Install the natively.dmg
  3. Open Terminal and run: `xattr -cr /Applications/Natively.app`
