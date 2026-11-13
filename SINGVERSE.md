# Nightingale for SingVerse karaoke rooms

This is a fork of [Nightingale](https://github.com/rzru/nightingale) (GPL-3.0-or-later), based on v1.4.1. It adds a **SingVerse mode**. In this mode the self-hosted server becomes the screen of SingVerse karaoke rooms.

- **SingVerse** (Laravel) holds the accounts, the song catalogue, the rooms and their queues. People join a room from their phone with a code or QR and queue songs from the catalogue.
- **This server** is the room's screen, opened on a TV or laptop:
  - It downloads each queued song's pre-analyzed `.nge`.
  - It plays the song with Nightingale's own playback screen and pitch scoring, using that device's microphone.
  - It sends the score back to SingVerse, which saves it on the profile of the person who queued the song.

Everything else is closed in SingVerse mode: the library, sources, the analyzer and its ML downloads, profiles, and the LAN phone remote. No GPU is needed.

## How it fits together

```
phones ──(SingVerse session)──► SingVerse ◄──(signed API, polled)── this server ◄──(room session)── TV / laptop
```

1. The host taps **Open the screen** in their SingVerse room. SingVerse redirects to `https://KARAOKE_DOMAIN/room/{room}?token=…`. The token is an HS256 JWT signed with the shared secret and valid for 2 minutes.
2. This server checks the token and swaps it for an HttpOnly session cookie tied to that room. Every API, media and WebSocket request requires that cookie. `/api/cmd` only accepts the playback commands.
3. While the screen is open, it asks this server for the room every 2 seconds. This server refreshes the room from `GET {SINGVERSE_URL}/api/nightingale/rooms/{room}` at most every 2.5 seconds. Each request is signed with HMAC-SHA256 over `timestamp.METHOD.path.body`.
4. The song on stage and the next two are downloaded into `NIGHTINGALE_LIBRARY_PATH`, one at a time. MEGA links are decrypted on the fly; links to the SingVerse CDN and Pixeldrain are plain HTTPS. Each bundle is registered in the library without a rescan. The folder is kept under `SINGVERSE_CACHE_MB` by deleting the least recently sung songs first.
5. The screen introduces the singer, then calls `start`. When the song ends it calls `finish` with the score (0–1000). SingVerse only accepts a score once, and only after 30% of the song has played.

## Code

| Where | What |
|---|---|
| `client/src-server/src/singverse/` | Configuration, JWT and session cookie (`auth.rs`), SingVerse API client (`client.rs`), room mirror (`rooms.rs`), downloads and cache (`fetch.rs`), MEGA (`mega.rs`), routes and command allow-list (`http.rs`) |
| `app-core/src/singverse.rs` | Register or forget a single `.nge` in the library, and draw the join QR |
| `client/src/features/singverse-room/` | The room screen: lobby with the QR, the next-singer card, playback and reporting the result |
| `client/src/features/playback/…` | Small hooks so that in a room, "exit" and "next" go back to the lobby and the score goes to SingVerse (`room-playback-context.ts`) |

Outside SingVerse mode (when `SINGVERSE_URL` is not set), the server behaves exactly like upstream Nightingale.

## Running it with Dokploy

Dokploy's Traefik already handles HTTPS, so use `docker/compose.dokploy.yaml` (no Caddy):

1. Create a **Compose** service from this repository, branch `singverse`, compose path `./docker/compose.dokploy.yaml`.
2. Under **Environment**, set `SINGVERSE_URL` and `SINGVERSE_SECRET` (and optionally `SINGVERSE_CACHE_MB`).
3. Under **Domains**, add the karaoke domain for service `nightingale`, container port `8080`, HTTPS with Let's Encrypt. Point the domain's DNS at the server first.
4. Deploy. The first build compiles Rust and takes several minutes.

## Running it (Docker + Caddy, without Dokploy)

```sh
cp docker/singverse.env.example docker/singverse.env   # fill it in
docker compose -f docker/compose.singverse.yaml --env-file docker/singverse.env up -d --build
```

Then, in SingVerse's `.env`:

```
NIGHTINGALE_URL=https://karaoke.example.com
NIGHTINGALE_SECRET=<the same SINGVERSE_SECRET>
```

| Variable | Meaning |
|---|---|
| `SINGVERSE_URL` | SingVerse's public URL. Setting it turns SingVerse mode on. |
| `SINGVERSE_SECRET` | Shared with SingVerse's `NIGHTINGALE_SECRET`. Must be at least 32 characters. |
| `NIGHTINGALE_LIBRARY_PATH` | Where downloaded songs live. Required in SingVerse mode (`/data/songs` in the compose files, inside the data volume the non-root user owns). |
| `SINGVERSE_CACHE_MB` | Disk cap for downloaded songs. Default 4096. |
| `SINGVERSE_INSECURE_COOKIES=1` | Only for local plain-HTTP testing: drops the cookie's `Secure` flag. |

The microphone needs HTTPS, which Caddy provides in the compose file.

## Local development

```sh
cd client && pnpm install && pnpm build && cd ..
SINGVERSE_URL=http://127.0.0.1:8000 SINGVERSE_SECRET=<32+ chars> \
NIGHTINGALE_DATA_PATH=/tmp/ng-data NIGHTINGALE_LIBRARY_PATH=/tmp/ng-songs \
NIGHTINGALE_BIND=127.0.0.1:8080 SINGVERSE_INSECURE_COOKIES=1 cargo run -p server
```

In SingVerse, set `NIGHTINGALE_URL=http://127.0.0.1:8080` and the same secret. Browsers allow the microphone on `localhost`/`127.0.0.1` even over plain HTTP.

## License

Nightingale is GPL-3.0-or-later, and so is this fork. The server sends its web frontend to browsers. This fork's source code is published at <https://github.com/Akkudrak/nightingale>, and the room screen links to it (`SOURCE_URL` in `client/src/features/singverse-room/room-page.tsx`). Keep that repository public and up to date with what runs in production, and keep `LICENSE` and the copyright notices.
