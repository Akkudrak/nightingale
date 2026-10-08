# Profiles

Nightingale supports multiple player profiles for tracking solo and multiplayer scores across different singers.

## Creating Profiles

Create a new profile from the main menu. Each profile stores:

- Player name
- Per-song pitch scores and star ratings
- Score history

## Switching Profiles

Switch between profiles from the sidebar. The active profile is shown in the UI and receives new solo scores.

## Multiplayer Profiles

During [multiplayer](./multiplayer.md) setup, assign each singer a saved profile or **Guest**. A saved profile can only be assigned to one singer in the lineup. Scores are saved to the assigned profiles; guest scores appear in the round's ranked results but are not stored.

## Score Tracking

Scores are stored in `profiles.json` inside your selected data folder (default `~/.nightingale/profiles.json`, or `<your-data-folder>/profiles.json` if you picked a custom location during setup). Each profile maintains separate scoreboards for every song, so multiple singers can compete on the same library.
