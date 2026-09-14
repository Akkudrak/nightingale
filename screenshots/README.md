# Screenshots

These images are referenced from the top-level [`README.md`](../README.md).

| File        | What it shows                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.png` | Screenshot of the **Party Mode host UI** — the manage-this-instance page that runs in `server.exe` (now-playing controls, library, queue). Captured on Windows. |
| `guest.png`  | Screenshot of the **`/guest` page** — the mobile-first view guests open from a phone or laptop on the same network (profile chip, search, song rows, queue drawer trigger). |

## Replacing the placeholders

`server.png` and `guest.png` ship as 1×1 placeholder pixels so GitHub renders the README without broken-image icons on a fresh checkout. Drop full-resolution screenshots in their place before publishing a release — keep the same filenames so the README links stay stable.

Tips for consistent captures:

- Capture at the same browser zoom (`Ctrl+0` to reset, then `Ctrl+=` a couple of times on Windows for 125%) and the same window width so the two images line up visually.
- For `server.png`, use the desktop layout (≥ 1280 px wide). For `guest.png`, capture a phone-shaped viewport (≈ 390 × 844 px) or take a real-device screenshot.
- Strip identifying info: the queue may contain tracks tied to your music library; blur or pick a neutral demo song before committing.
