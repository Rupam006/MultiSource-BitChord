# MultiSource BitChord

An aggregate BitChord addon for Render, built with Node.js 20+.

## Routes

- `GET /manifest.json` — public manifest; declares `bitchordAuth: true` and disables the device lossless-validation gate with `checkValidLossless: 0`.
- `GET /search?q=...` — searches primary providers first, then fans out to every fallback backend when primary matches are absent or a primary group is unreachable; results are ranked by reported audio resolution.
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

- prodpwh, Confih, and all Juanjo provider adapters are the primary tier and start searching concurrently. If no primary match is returned, or either primary group is unreachable, every fallback provider is searched concurrently.
- Duplicate tracks are compared using reported bit depth, sample rate, bitrate, codec and quality metadata; the highest reported resolution is kept. Missing metadata is treated as unknown, never invented.
- When resolving playback, playable primary streams are compared first and the best reported resolution is selected. Fallback backends are searched together only if no primary stream can be resolved.
- Provider searches run concurrently with a bounded per-provider timeout, so one offline source does not hold up every other source indefinitely.
- Stream resolution compares playable candidates in the active tier and selects the highest reported resolution; the next tier is tried only when no stream in the active tier is playable.
- Search results are cached for 3 minutes. Resolved stream URLs are cached for 45 seconds to reduce stale signed-link failures.
- The addon returns the provider's direct HTTPS stream URL. It does not relay audio bytes, rewrite signed URLs, or proxy range requests. Playback buffering caused by a slow upstream CDN, an expiring source URL, or the listener's connection cannot be fully fixed by aggregator-side search/failover tuning.

## Deploy to Render

1. Create a Render Web Service from this repository.
2. Runtime: Node; build command: `npm install`; start command: `npm start`.
3. Render's `RENDER_EXTERNAL_HOSTNAME` is used automatically for BitChord proof checks. Set `BITCHORD_HOSTS` only if you add a custom domain or need multiple hostnames.
4. Add any provider-specific environment variables below.
5. Deploy, then add the HTTPS service URL in the official BitChord Android app.

## Provider configuration and status

The Juanjo Hi-Res repository is integrated as direct upstream adapters rather than as a single addon dependency. Its own `/search` and `/stream` routes require hardware-bound BitChord proofs for its configured hostname, so this service does not proxy those protected routes.

| Tier | Provider | Default / configuration | Integration status |
|---|---|---|
| Primary | prodpwh | `PRODPWH_ADDON_URL` | Private personalized addon; enabled only when configured. Keep its URL in Render environment variables, never in Git. |
| Primary | Confih Hi-Res | `CONFIH_URL` (default preset URL) | Generic BitChord route adapter; upstream auth/availability still needs live validation. |
| Fallback | Qobuz [Heisenberg] | `HEISENBERG_URL` (default ends in `/a`) | Generic adapter; preset endpoint was previously observed unavailable and needs live validation. |
| Fallback | ReZenOnance (Monochrome / Arcod) | `REZENONANCE_URL` (defaults to `https://rezenonance.onrender.com`) | Existing generic adapter; retained as a separate upstream. |
| Primary (Juanjo) | Monochrome / Tidal | Monochrome instance registry and `tracks.monochrome.st` | Direct search and FLAC stream probing. Tidal uses the same Monochrome index here, so it is represented as one source rather than duplicate search requests. |
| Primary (Juanjo) | Qobuz (Juanjo upstream) | `JUANJO_QOBUZ_UPSTREAM_URL` (public default) | Direct search/stream adapter; availability depends on the upstream service. |
| Primary (Juanjo) | Netease | Meting public endpoint; optional `JUANJO_NETEASE_METING_URL` override | Direct catalogue lookup and redirect-to-FLAC validation. The source repository's private/tokenized bridge URL was deliberately not copied. |
| Primary (Juanjo) | Deezer catalogue | `api.deezer.com` | Search/catalogue only; selected tracks are resolved through the aggregator's other playable providers. |

The direct adapters validate returned URLs and reject encrypted or unverified audio where applicable. Provider presence does not guarantee that its upstream is currently online or that every result can be streamed.

## Environment variables

- `BITCHORD_HOSTS` — comma-separated service hostnames, required if Render's hostname variable is not available.
- `PRODPWH_ADDON_URL` — your private personalized addon URL; store only in Render environment variables.
- `CONFIH_URL` — optional Confih addon root.
- `HEISENBERG_URL` — optional Heisenberg addon root.
- `REZENONANCE_URL` — optional override for the ReZenOnance addon root (defaults to `https://rezenonance.onrender.com`).
- `JUANJO_QOBUZ_UPSTREAM_URL` — optional Qobuz upstream override.
- `JUANJO_NETEASE_METING_URL` — optional Netease Meting endpoint override.

Never commit personal provider URLs or tokens.

## Local development

```sh
npm install
BITCHORD_HOSTS=localhost npm start
```

The manifest can be checked without authentication at `http://localhost:10000/manifest.json`. Search and stream require genuine BitChord credentials for the configured hostname; local curl requests are expected to receive 401.
