# MultiSource BitChord

An aggregate BitChord addon for Render, built with Node.js 20+.

## Routes

- `GET /manifest.json` — public manifest; declares `bitchordAuth: true` and disables the device lossless-validation gate with `checkValidLossless: 0`.
- `GET /search?q=...` — concurrent provider search, normalization and deduplication.
- `GET /stream/:id` — resolves a selected provider track and races eligible mirror streams for the first playable result.
- `GET /health` — authenticated provider configuration status.

All routes except the manifest require BitChord hardware-backed request proof. Configure the exact public hostname in `BITCHORD_HOSTS`; for Render, `RENDER_EXTERNAL_HOSTNAME` is used if the explicit variable is empty. Add custom domains as comma-separated hostnames (no scheme, port or path).

## Audio quality settings

The manifest exposes the quality modes supported by the supplied community addon contracts:

| App label | Request value | Intended ceiling (only when upstream supplies it) |
|---|---|---|
| Maximum Lossless / Hi-Res | `lossless` | Up to 24-bit / 192 kHz |
| High Lossless | `high` | Up to 24-bit / 96 kHz |
| Low / Data saver | `low` | Reduced bandwidth |
| Stereo only | `stereo` | Atmos disabled |
| Dolby Atmos when available | `auto` | Atmos requested where upstream supports it |

These are request preferences, not guarantees. The selected spatial-audio preference is also appended to the returned `qualityTier` label (for example, `Lossless / Hi-Res · Stereo` or `Lossless / Hi-Res · Dolby Atmos (when available)`). The addon reports detected `spatialAudio: Dolby Atmos` or `spatialAudio: Stereo` only when upstream metadata explicitly confirms it; selecting Atmos does not prove the provider returned an Atmos stream. The actual codec, bit depth, sample rate and bitrate are included in normalized track/stream metadata only when the provider returns those values. The addon does not label an unknown stream as FLAC or lossless.

## Performance and buffering

- Provider searches run concurrently with a bounded per-provider timeout, so one offline source does not hold up every other source indefinitely.
- Stream failover starts the preferred source and mirror discovery concurrently; eligible mirrors resolve in parallel and the first playable result wins.
- Search results are cached for 3 minutes. Resolved stream URLs are cached for 45 seconds to reduce stale signed-link failures.
- The addon returns the provider's direct HTTPS stream URL. It does not relay audio bytes, rewrite signed URLs, or proxy range requests. Playback buffering caused by a slow upstream CDN, an expiring source URL, or the listener's connection cannot be fully fixed by aggregator-side search/failover tuning.

## Deploy to Render

1. Create a Render Web Service from this repository.
2. Runtime: Node; build command: `npm install`; start command: `npm start`.
3. Render's `RENDER_EXTERNAL_HOSTNAME` is used automatically for BitChord proof checks. Set `BITCHORD_HOSTS` only if you add a custom domain or need multiple hostnames.
4. Add any provider-specific environment variables below.
5. Deploy, then add the HTTPS service URL in the official BitChord Android app.

## Provider configuration and status

Most community sources originate from SudinChord's addon presets; ReZenOnance is an additional independent upstream. These URLs do not all represent public, anonymous, stable APIs.

| Provider | Default / configuration | Integration status |
|---|---|---|
| prodpwh | `PRODPWH_ADDON_URL` | Disabled until you provide your private session URL. Add it as a Render secret later; never commit it. |
| Confih Hi-Res | `CONFIH_URL` (default preset URL) | Generic BitChord route adapter; upstream auth/availability still needs live validation. |
| Qobuz [Heisenberg] | `HEISENBERG_URL` (default ends in `/a`) | Generic adapter; preset endpoint was previously observed unavailable and needs live validation. |
| ReZenOnance (Monochrome / Arcod) | `REZENONANCE_URL` (defaults to `https://rezenonance.onrender.com`) | Integrated through its documented `/search` and `/stream/:id` API using the existing generic provider adapter. Its upstream manifest is playback-only (`allowDownloads: 0`); live availability and stream compatibility still need validation. |

The generic adapter does not forge device proofs or invent undocumented endpoints. An upstream that is offline, returns a different API shape, or requires unsupported authentication will be skipped rather than returning fabricated tracks.

## Environment variables

- `BITCHORD_HOSTS` — comma-separated service hostnames, required if Render's hostname variable is not available.
- `PRODPWH_ADDON_URL` — your private personalized addon URL; store only in Render environment variables.
- `CONFIH_URL` — optional Confih addon root.
- `HEISENBERG_URL` — optional Heisenberg addon root.
- `REZENONANCE_URL` — optional override for the ReZenOnance addon root (defaults to `https://rezenonance.onrender.com`).

Never commit personal provider URLs or tokens.

## Local development

```sh
npm install
BITCHORD_HOSTS=localhost npm start
```

The manifest can be checked without authentication at `http://localhost:10000/manifest.json`. Search and stream require genuine BitChord credentials for the configured hostname; local curl requests are expected to receive 401.
