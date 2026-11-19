# MultiSource BitChord

A multi-source BitChord music addon for searching tracks and returning playable audio streams from several independent providers. It combines high-resolution and lossless sources, compares available audio metadata, and uses fallback providers when primary sources are unavailable.

## What it provides

- Unified music search across multiple provider services.
- Concurrent searches within each provider tier.
- Duplicate-track cleanup, preferring the best reported audio resolution.
- Playback stream resolution with provider fallback.
- Lossless, Hi-Res, standard-quality and spatial-audio request preferences.
- BitChord-authenticated addon endpoints and a provider health endpoint.

## Providers

Primary providers are searched together:

| Provider | Source |
|---|---|
| prodpwh | Private BitChord addon; configured separately |
| Confih Hi-Res | Confih BitChord addon |
| Juanjo Monochrome / Tidal | Monochrome catalogue and stream source |
| Juanjo Qobuz | Qobuz search and stream source |
| Juanjo Netease | Netease catalogue/stream bridge |
| Juanjo Deezer | Deezer catalogue source; playback may resolve through another provider |

Fallback providers are searched together when the primary tier returns no usable matches or a primary provider group is unreachable:

| Provider | Source |
|---|---|
| Qobuz [Heisenberg] | Heisenberg BitChord addon |
| ReZenOnance · Monochrome | Monochrome FLAC source |
| ReZenOnance · Arcod | Arcod / Instable source |
| ReZenOnance · Qobuz-DL | Qobuz-DL-compatible API |
| ReZenOnance · LastBabe | LastBabe source |
| ReZenOnance · Deezer | Deezer-compatible remote addon |
| ReZenOnance · Eljohnzc | Eljohnzc remote addon |

The ReZenOnance project is integrated as its individual provider sources rather than queried as one separate ReZenOnance addon. Provider endpoints are external dependencies and may change, rate-limit requests, or become unavailable. The presence of an adapter is not a guarantee of current upstream availability. The ReZenOnance provider adapters are adapted from [KATx-dev/ReZenOnance](https://github.com/KATx-dev/ReZenOnance), licensed under GPL-3.0-or-later; the license text is included at LICENSES/ReZenOnance-GPL-3.0.txt.

## Audio quality

| App preference | Request value | Meaning |
|---|---|---|
| Maximum Lossless / Hi-Res | lossless | Requests the provider's best lossless rendition |
| High Lossless | high | Requests a high-quality rendition |
| Low / Data saver | low | Requests a lower-bandwidth rendition |
| Stereo | stereo | Requests stereo playback |
| Dolby Atmos when available | auto | Requests Atmos where a provider supports it |

Audio resolution is determined from metadata actually supplied by a provider, such as codec, bit depth, sample rate and bitrate. When duplicate versions are found, the addon prefers the highest reported resolution. A request setting is not a guarantee: the actual stream depends on the provider and the source recording. Missing metadata is treated as unknown. Dolby Atmos is reported as detected only when the upstream explicitly identifies it; selecting the Atmos preference does not guarantee an Atmos stream.

For reference, Hi-Res audio can reach 24-bit / 192 kHz where a provider genuinely supplies it. The addon does not upsample audio or convert a lossy source into lossless audio.

## API endpoints

| Method and path | Purpose |
|---|---|
| GET /manifest.json | Public BitChord addon manifest |
| GET /search?q=... | Search and return normalized track results |
| GET /stream/:id | Resolve a selected track to a playable stream |
| GET /health | Provider configuration and availability status |

The manifest enables BitChord authentication and sets checkValidLossless: 0. This disables the app-side lossless compatibility gate; it does not make an unsupported codec or stream playable. All routes except the manifest require valid BitChord hardware-backed request proof for the configured hostname.

## Run and deploy

Requirements: Node.js 20 or newer and npm.

    git clone https://github.com/Rupam006/MultiSource-BitChord.git
    cd MultiSource-BitChord
    npm install
    npm test
    npm start

The server listens on the port supplied through PORT (default: 10000) and binds to 0.0.0.0. It can be deployed as a standard Node.js service on any compatible hosting platform, virtual machine, or container. Set the platform's start command to npm start; no Render-specific deployment is required.

For local development, set BITCHORD_HOSTS=localhost. The manifest is available at http://localhost:10000/manifest.json. Search and stream requests still require valid BitChord credentials and proof.

## Configuration

Set environment variables in the deployment environment. Do not commit private URLs, access tokens, or credentials.

| Variable | Purpose |
|---|---|
| PORT | HTTP listening port |
| BITCHORD_HOSTS | Comma-separated allowed hostnames for BitChord proof validation |
| PRODPWH_ADDON_URL | Private prodpwh addon URL |
| CONFIH_URL | Optional Confih addon root |
| HEISENBERG_URL | Optional Heisenberg addon root |
| MONOCHROME_BASE_URL | ReZenOnance Monochrome source override |
| INSTABLE_BASE_URL | ReZenOnance Arcod source override |
| QOBUZ_DL_BASE_URL | ReZenOnance Qobuz-DL API override |
| LASTBABE_BASE_URL | ReZenOnance LastBabe source override |
| DEEZER_BASE_URL | ReZenOnance Deezer-compatible addon override |
| ELJOHNZC_BASE_URL | ReZenOnance Eljohnzc addon override |
| JUANJO_QOBUZ_UPSTREAM_URL | Optional Juanjo Qobuz upstream override |
| JUANJO_NETEASE_METING_URL | Optional Juanjo Netease endpoint override |

The hostname used for BitChord proof validation must match the public hostname used by the app. On hosting platforms that provide RENDER_EXTERNAL_HOSTNAME, it is used automatically when BITCHORD_HOSTS is not set. For other platforms, configure BITCHORD_HOSTS explicitly.

## Development notes

- npm test runs JavaScript syntax checks and the automated test suite.
- Keep provider URLs and credentials in environment variables.
- External provider APIs can change independently; verify search and playback after changing provider endpoints.
- Search and stream responses are cached briefly to reduce repeated upstream requests.
- The addon returns provider stream URLs directly; playback speed and buffering also depend on the upstream host, stream URL lifetime, network and player.
- The manifest currently enables downloads with allowDownloads: 1. Actual download support still depends on the selected provider returning a compatible, accessible media URL.

## Related source

- [ReZenOnance provider project](https://github.com/KATx-dev/ReZenOnance)
- [Juanjo Hi-Res addon](https://github.com/juanjoblol/bitchord-hires-addon)
