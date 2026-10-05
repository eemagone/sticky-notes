# Note — local sticky notes for Windows

Small personal sticky-note app. Fully local: no accounts, no network calls, no telemetry.
Electron with plain HTML/CSS/JS.

## Run (development)

```
npm install
npm start
```

Dev mode never registers auto-start (it would point at the dev `electron.exe`).

## Build and install

```
npm run dist
```

Creates `dist\Note Setup <version>.exe`. Run it (or `"dist\Note Setup 0.1.0.exe" /S` for silent).
It installs per-user into `%LOCALAPPDATA%\Programs\note` (no admin), adds Start Menu and desktop
shortcuts named **Note** (so typing "note" in Start finds it), and on first start registers
"Start with PC" (`HKCU\...\Run`, launched with `--hidden`, so it starts quietly in the tray).

`npm run pack` builds only the unpacked app in `dist\win-unpacked` (no installer).
`npm run icon` regenerates `build\icon.png`. `npm test` runs the storage, task-file and archive checks.

## Using it

- **Tray icon**: New note, Hide/Show all notes, open notes (click to bring forward), Reopen last closed note,
  Archived notes, Open txt folder, Open data folder, Start with PC, Quit. Left-click opens the launcher.
- **Note**: click a task to strike it through, double-click to edit (Enter = save + new task, Escape = cancel),
  Backspace on an empty task deletes it, paste several lines for several tasks, drag the grip to reorder,
  click the dot to cycle priority, `>` opens the task's .txt file.
- **Pin button**: *pinned* = stuck to the desktop (other windows cover it, locked in place, clicking it doesn't
  raise it, survives Win+D). *Unpinned* = floats above all windows, movable and resizable.
- **Right-click** a note: Change colour, Recently deleted tasks (restore), Delete note.
- **Close / Delete note** archive the note into a zip. Quitting or shutting down never archives anything.

## Where data lives (`%APPDATA%\Note`)

| Path | What |
| --- | --- |
| `data.json` | everything: notes, tasks, positions, pinned state, task-to-file links |
| `data.json.bak`, `backups\data-YYYY-MM-DD.json` | previous save + one daily backup (last 7 days) |
| `tasks\` | one `.txt` per task, named after the task title; never deleted by the app |
| `archive\` | `Title_YYYY-MM-DD_HH-mm.zip` per closed/deleted note (note.json + its txt files) |

If `data.json` is missing or damaged the app restores the newest valid backup and shows a notification.

## How pinning works (Windows) and its limits

Pinned notes are made *owned by the desktop window* (`Progman`) and `WM_WINDOWPOSCHANGING` is intercepted so
activation never changes their z-order. This uses `koffi` (prebuilt FFI, no compiling, no admin).

- A pinned note gets keyboard focus when you click it (needed for typing), but stays behind other windows.
- Survives Win+D / Show desktop.
- If Explorer restarts, Windows destroys desktop-owned windows; the app reopens them automatically.
- "Show on all virtual desktops" has no public Windows API; not guaranteed.
- Txt files are renamed to match a renamed task lazily (next `>` click or next launch), so Notepad never
  ends up saving to a filename that no longer exists.

## Files

`main.js` app/windows/IPC · `storage.js` JSON persistence · `taskfiles.js` task .txt files ·
`archive.js` zip archive/restore · `pinning.js` desktop layer · `tray.js` tray menu · `icon.js` generated icons ·
`preload.js` renderer bridge · `note/` note window · `launcher/` launcher + new-note dialog · `fonts/` Caveat + Inter (SIL OFL).
