# BandCue Songsterr Android Adapter

Native Android adapter for controlling Songsterr through BandCue.

## Build And Install Without Android Studio

From the repo root:

```powershell
npm run build:android
```

This bootstraps Gradle into `android/.gradle-bootstrap/`, uses the installed Android SDK, and writes:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

To run the Android JVM tests:

```powershell
npm run test:android
```

This project is intended for sideload/debug APK use first. It has no Play Store packaging flow yet.

## Phone Setup

1. Install Songsterr from Google Play. The expected package is `com.songsterr`.
2. Start the BandCue coordinator with `npm run dev`.
3. Install and open the Android adapter app.
4. Tap **Enable Notification Access** and allow BandCue Songsterr.
5. If Songsterr opens correctly but play/stop does not work, tap **Accessibility Fallback** and enable BandCue Songsterr in Android Accessibility settings.
6. Enter one of:
   - the full room URL printed by BandCue,
   - `host:port`, for example `192.168.1.23:4173`,
   - the room code,
   - the coordinator port.
7. Pick **My instrument** if this phone should open bass or drum tabs.
8. Tap **Connect**.

The host page should show the phone as a Songsterr desktop adapter. If the current BandCue song has a Songsterr URL, **Open Current Songsterr Song** launches it on Android. Explicit bass/drum Songsterr URLs in the setlist are used when this phone is set to that instrument; otherwise BandCue falls back to Songsterr's usual bass/drum URL slug.

## Control Path

The adapter tries Android media sessions first through a `NotificationListenerService`, then falls back to explicit accessibility control when enabled.

- `play` calls `MediaController.TransportControls.play()` on the active Songsterr media session.
- `stop` calls `MediaController.TransportControls.pause()` and reports playback as stopped.
- If no Songsterr media session is visible, the accessibility fallback only operates while Songsterr is the foreground app and taps visible play/pause controls.
- If Songsterr is missing or neither control path is enabled, the adapter reports a clear not-ready or failed-command state to the BandCue host.

The Accessibility fallback is explicit opt-in because Android treats it as a powerful permission.

## Install With ADB

If a device is connected with USB debugging enabled:

```powershell
%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe install -r android\app\build\outputs\apk\debug\app-debug.apk
```
