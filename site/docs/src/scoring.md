# Pitch Scoring

Nightingale includes real-time pitch scoring to gamify the karaoke experience.

## How It Works

1. **Microphone input** — select a microphone for solo playback, or assign one microphone to each singer in multiplayer
2. **Pitch detection** — each active microphone's vocal pitch is analyzed in real time
3. **Comparison** — your pitch is compared against the reference vocal track (or the original mix for songs analyzed without stem separation, where scoring is less accurate)
4. **Scoring** — accuracy is tracked throughout the song

## Star Ratings

At the end of each song, every singer receives a star rating based on overall pitch accuracy. Ratings assigned to saved profiles are added to those profiles' scoreboards.

<!-- TODO: screenshot of the end-of-song results screen with star rating -->
![Star rating](images/stars.png)

## Results

For solo playback, the results screen appears whenever your score is above 0. The active profile's result is saved to the song leaderboard.

Multiplayer always shows ranked results, highest score first. Results assigned to saved profiles are stored; **Guest** results appear for the current round but are not added to a profile. During queue playback, choose **Next Song** to keep the lineup or **Change players** before continuing.

## Microphone Selection

- Press `M` to toggle the microphone on/off
- Press `N` to cycle through available microphones
- Press `R` to toggle mic monitoring during playback
- Select a preferred microphone in **Settings → General**
- The active microphone is shown in the HUD during playback

In multiplayer, microphones are assigned during player setup. Each singer needs a different connected microphone, so the `M` and `N` solo shortcuts are disabled.

## Latency Calibration

Use **Settings → General → Mic latency** to compensate for speaker-to-microphone delay. The test plays a short beep, listens for it through the selected microphone, and saves `mic_latency_compensation_sec`. You can also adjust the value manually if your room or audio device needs extra tuning.

## Per-Song Scoreboards

Each song maintains a scoreboard of past performances. Solo scores use the active profile; multiplayer scores use the profile selected for each singer. See [Multiplayer](./multiplayer.md) for setup and queue behavior.
