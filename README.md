# MultiSource BitChord

A BitChord music-streaming addon that brings multiple independent music sources into one manifest. Search once, compare available versions, and resolve playback from the best compatible source.

## Features

- **Multi-source manifest:** Combines independent catalogues and streaming providers in one BitChord addon, with primary and fallback routing.
- **Resolution selection:** Supports maximum lossless/Hi-Res, high-lossless and low-bandwidth preferences, based on the selected provider's available stream.
- Track matching across sources using title, artist, duration and version information.
- Duplicate detection and ranking by relevance and reported audio resolution.
- Primary-first playback resolution, with fallback mirrors when primary sources cannot resolve a track.
- Provider health monitoring and circuit breakers to isolate failing upstreams.
- Short-lived response caching and bounded search results.

## Providers

| Source | Role | Highest quality level | Source / note |
|---|---|---|---|
| Netease (Meting) | Primary | Lossless (provider/catalogue dependent) | Existing Juanjo Netease upstream adapter |
| Official Monochrome | Primary | Lossless / Hi-Res where available | Existing Monochrome adapter; validates FLAC stream metadata |
| Eljohnzc Monochrome | Primary | Lossless / Hi-Res where available | WioLand source module |
| Confih Hi-Res | Fallback | Hi-Res lossless where available | WioLand Confih source module |
| Qobuz Addon | Fallback | Hi-Res lossless where available | WioLand Qobuz Addon module |
| Juanjo Qobuz | Fallback | Hi-Res lossless where available | Existing direct Juanjo Qobuz upstream adapter |
| gglos | Fallback | Lossless / Hi-Res where available | WioLand source module |
| LastBabe | Fallback | Lossless / Hi-Res where available | WioLand source module |
| Tido | Fallback | Lossless / Hi-Res where available | WioLand source module |
| Deezer catalogue | Fallback | Lossless catalogue metadata; playback resolved by another source | Existing Juanjo Deezer catalogue adapter; not an independent stream resolver |
| prodpwh | Fallback | Depends on configured addon | Optional private addon, enabled through environment |

*Quality levels describe the highest level a source may offer, not a guarantee for every track. Actual stream quality depends on the recording, provider response and available metadata.*

## Audio quality

| App preference | Audio resolution |
|---|---|
| Maximum Lossless / Hi-Res | Requests the highest lossless or Hi-Res option available from the selected source |
| High Lossless | Requests a high-quality lossless option where supported |
| Low / Data Saver | Requests a lower-bandwidth stream where supported |

The addon reports resolution using provider metadata such as codec, sample rate, bit depth and bitrate. It does not upsample or turn a lossy recording into lossless audio. The delivered quality is determined by the stream the provider actually returns.

## API endpoints

| Method and path | Purpose |
|---|---|
| GET /manifest.json | Serves the BitChord manifest and addon capabilities. |
| GET /search?q=... | Finds tracks across primary sources and tops up results from fallbacks when needed. |
| GET /stream/:id | Resolves a selected track to a playable stream, checking preferred sources and mirrors. |
| GET /health | Reports provider availability, circuit-breaker state and request health metrics. |

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

## Environment

Set environment variables in the deployment environment. Keep private URLs, access tokens and credentials out of source control.

| Variable | Purpose |
|---|---|
| PORT | HTTP listening port |
| BITCHORD_HOSTS | Comma-separated allowed hostnames for BitChord proof validation |
| PRODPWH_ADDON_URL | Private prodpwh addon URL |
| JUANJO_QOBUZ_UPSTREAM_URL | Optional Juanjo Qobuz upstream override |
| JUANJO_NETEASE_METING_URL | Optional Juanjo Netease endpoint override |

The hostname used for BitChord proof validation must match the public hostname. On Render, `RENDER_EXTERNAL_HOSTNAME` is used automatically when `BITCHORD_HOSTS` is not set; on other platforms, set `BITCHORD_HOSTS` explicitly.

## Deployment notes

- Deploy with `npm start`; configure the platform's `PORT` and public hostname.
- Run `npm test` before deployment. Use `npm run smoke:providers` or the GitHub Actions provider-smoke workflow to check live upstreams.
- Provider availability and returned stream quality depend on external services and can change independently.
- A successful short media-range probe confirms an accessible response, not uninterrupted full-track playback.

## Related source

- [WioLand source collection](https://github.com/Wiojelt/WioLand)
- [Juanjo Hi-Res addon](https://github.com/juanjoblol/bitchord-hires-addon)
