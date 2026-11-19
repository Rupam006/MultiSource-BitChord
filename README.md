# MultiSource BitChord

An aggregate BitChord addon for Render, built with Node.js 20+.

## Routes

- `GET /manifest.json` — public manifest; declares `bitchordAuth: true`.
- `GET /search?q=...` — parallel provider search, normalization and deduplication.
- `GET /stream/:id` — resolves a selected provider track.
- `GET /health` — authenticated provider configuration status.

All routes except the manifest require the official BitChord hardware-backed request proof. The verifier uses the BitChord public JWKS and WebCrypto. Configure the exact public hostname in `BITCHORD_HOSTS`; for Render, `RENDER_EXTERNAL_HOSTNAME` is used if the explicit variable is empty. Add custom domains as comma-separated hostnames (no scheme, port or path).

## Deploy to Render

1. Create a Render Web Service from this repository.
2. Runtime: Node; build command: `npm install`; start command: `npm start`.
3. Render's `RENDER_EXTERNAL_HOSTNAME` is used automatically for BitChord proof checks. Set `BITCHORD_HOSTS` only if you add a custom domain or need multiple hostnames.
4. Add any provider-specific environment variables below.
5. Deploy, then add the HTTPS service URL in the official BitChord Android app.

## Provider configuration and known limitations

The community list was taken from SudinChord's community addon presets. Their URLs do not all represent public, anonymous, stable APIs.

| Provider | Default / configuration | Current integration status |
|---|---|---|
| PencariMusic | `PENCARIMUSIC_URL` (default preset URL) | Adapter uses the BitChord `/search` and `/stream/:id` contract; must be live-tested against the upstream. |
| prodpwh | `PRODPWH_ADDON_URL` | Requires your personal session URL from its Discord sign-in page. Do not publish that URL; set it as a Render secret. |
| Confih Hi-Res | `CONFIH_URL` (default preset URL) | Adapter uses the BitChord route contract; upstream auth/availability must be live-tested. |
| Qobuz [Heisenberg] | `HEISENBERG_URL` (default ends in `/a`) | Preset manifest was previously observed as unavailable; verify upstream before relying on it. |
| juanjob hi res | `JUANJOB_URL` | Disabled as a server-side addon proxy: its public manifest advertises BitChord hardware proof, which is bound to the upstream hostname and cannot be forwarded from this server. A native provider integration requires a separately licensed implementation or documented upstream API. |

The generic adapter deliberately does not invent upstream API endpoints or forge BitChord device proofs. A provider that is offline, returns a different API shape, or requires unsupported authentication will be skipped rather than returning fabricated tracks.

## Environment variables

- `BITCHORD_HOSTS` — comma-separated service hostnames, required if Render's hostname variable is not available.
- `PENCARIMUSIC_URL` — optional PencariMusic addon root.
- `PRODPWH_ADDON_URL` — your private personalized addon URL; store only in Render environment variables.
- `CONFIH_URL` — optional Confih addon root.
- `HEISENBERG_URL` — optional Heisenberg addon root.
- `JUANJOB_URL` — optional override; still disabled for server-to-server proxying unless its authentication model changes.

Never commit personal provider URLs or tokens.

## Local development

```sh
npm install
BITCHORD_HOSTS=localhost npm start
``

The manifest can be checked without authentication at `http://localhost:10000/manifest.json`. Search and stream require a genuine BitChord proof for the configured hostname; local curl requests are expected to receive 401.
