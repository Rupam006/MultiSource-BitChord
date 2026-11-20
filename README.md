# MultiSource BitChord

A multi-source BitChord music addon that searches independent music providers, compares reported audio quality, and resolves playable streams.

## Features

- Searches Netease, Official Monochrome and PencariMusic as primary sources first; fallback providers top up small primary result sets.
- Ranks results by title/artist relevance, then reported audio resolution; normalizes accents and common title variants for duplicate detection.
- Compares duplicate tracks and prefers the highest reported audio resolution.
- Tries other primary providers first for playback mirrors, then fallback providers if no primary mirror resolves.
- Supports lossless, high-quality, data-saver and spatial-audio request preferences.
- Provides BitChord-authenticated endpoints and provider health status.

## Providers

| Provider | Source |
|---|---|
| PencariMusic | PencariMovie Telegram music addon |
| prodpwh | Private BitChord addon; configured separately |
| Official Monochrome | Official Monochrome Tracks API and direct FLAC streaming |
| SoundCloud | Publicly playable full-length SoundCloud tracks; progressive and HLS streams |
| Juanjo Qobuz | Qobuz search and stream source |
| Juanjo Netease | Netease catalogue/stream bridge |
| Juanjo Deezer | Deezer catalogue source; playback may resolve through another provider |

Primary providers are Netease, Official Monochrome and PencariMusic. Fallback providers are Qobuz, Deezer catalogue, SoundCloud and prodpwh (when configured). Search checks all primary providers concurrently and searches fallback providers when fewer than 12 unique primary results are available, then ranks the combined results by relevance and reported resolution. Playback resolution tries the selected provider and other primary mirrors first; fallback mirrors are tried only when no primary mirror can resolve the track. Duplicate-track selection and audio-resolution scoring are unchanged.

Provider endpoints are external dependencies and may change, rate-limit requests, or become unavailable. A configured adapter is not a guarantee of upstream availability.

## Audio quality

| App preference | Request value | Meaning |
|---|---|---|
| Maximum Lossless / Hi-Res | lossless | Requests the provider's best lossless rendition |
| High Lossless | high | Requests a high-quality rendition |
| Low / Data saver | low | Requests a lower-bandwidth rendition |
| Stereo | stereo | Requests stereo playback |
| Dolby Atmos when available | auto | Requests Atmos where a provider supports it |

Audio resolution is determined from metadata actually supplied by a provider, such as codec, bit depth, sample rate and bitrate. When duplicate versions are found, the addon prefers the highest reported resolution. A request setting is not a guarantee: the actual stream depends on the provider and source recording. Missing metadata is treated as unknown. Dolby Atmos is reported as detected only when the upstream explicitly identifies it; selecting the Atmos preference does not guarantee an Atmos stream.

SoundCloud is included only when a track is marked playable and exposes a non-preview full-length stream. SoundCloud streams are lossy (for example MP3, AAC or Opus); they are not presented as lossless. The addon does not upsample audio or convert a lossy source into lossless audio. `checkValidLossless: 0` disables the app-side lossless compatibility gate; it does not make an unsupported codec or stream playable.

## API endpoints

| Method and path | Purpose |
|---|---|
| GET /manifest.json | Public BitChord addon manifest |
| GET /search?q=... | Search primary providers, then fallback providers if needed |
| GET /stream/:id | Resolve a selected track to a playable stream |
| GET /health | Provider configuration and availability status |

All routes except the manifest require valid BitChord hardware-backed request proof for the configured hostname.

## Run and deploy

Requirements: Node.js 20 or newer and npm.

```sh
git clone https://github.com/Rupam006/MultiSource-BitChord.git
cd MultiSource-BitChord
npm install
npm test
npm start
```

The server listens on the port supplied through `PORT` (default: `10000`) and binds to `0.0.0.0`. Set the platform start command to `npm start`.

## Configuration

Set environment variables in the deployment environment. Do not commit private URLs, access tokens, or credentials.

| Variable | Purpose |
|---|---|
| PORT | HTTP listening port |
| BITCHORD_HOSTS | Comma-separated allowed hostnames for BitChord proof validation |
| PRODPWH_ADDON_URL | Private prodpwh addon URL |
| JUANJO_QOBUZ_UPSTREAM_URL | Optional Juanjo Qobuz upstream override |
| JUANJO_NETEASE_METING_URL | Optional Juanjo Netease endpoint override |

The hostname used for BitChord proof validation must match the public hostname used by the app. On Render, `RENDER_EXTERNAL_HOSTNAME` is used automatically when `BITCHORD_HOSTS` is not set. For other platforms, configure `BITCHORD_HOSTS` explicitly.

## Development notes

- `npm test` runs JavaScript syntax checks and the automated test suite.
- Keep provider URLs and credentials in environment variables.
- External provider APIs can change independently; verify search and playback after changing provider endpoints.
- Search and stream responses are cached briefly to reduce repeated upstream requests. Search results are capped at 60 tracks, query length is limited to 200 characters, and per-track metadata cache size is bounded.
- The addon returns provider stream URLs directly; playback speed and buffering also depend on the upstream host, stream URL lifetime, network and player.
- The manifest currently enables downloads with `allowDownloads: 1`. Actual download support depends on the selected provider returning a compatible, accessible media URL.

## Related source

- [Juanjo Hi-Res addon](https://github.com/juanjoblol/bitchord-hires-addon)
