// Provider adapters adapted from KATx-dev/ReZenOnance (GPL-3.0-or-later).
// Upstream: https://github.com/KATx-dev/ReZenOnance
import { createHash } from "node:crypto";
import { normalizeTrack } from "../normalize.js";

const DEFAULT_TIMEOUT_MS = 12000;
const cleanBase = (value) => String(value || "").replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const safeId = (value) => {
  const id = String(value ?? "");
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
};
const qualityId = (quality) => String(quality).toLowerCase() === "lossless" ? "27" : "5";

async function getJson(url, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "MultiSource-BitChord/1.2", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function withParams(base, path, params = {}) {
  const url = new URL(path.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}
function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.tracks)) return payload.tracks;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}
function makeProvider({ id, name, baseUrl, searchRows, resolveStream }) {
  const provider = {
    id, name, role: "primary", baseUrl: cleanBase(baseUrl), enabled: Boolean(baseUrl),
    async search(query, quality, atmos = "stereo") {
      if (!this.enabled || !this.baseUrl) throw new Error("provider is not configured");
      const rows = await searchRows(query, quality, atmos, this);
      return rows.map((row) => normalizeTrack(row, id, quality, atmos)).filter(Boolean);
    },
    async resolve(upstreamId, quality, atmos = "stereo") {
      if (!this.enabled || !this.baseUrl) throw new Error("provider is not configured");
      const stream = await resolveStream(upstreamId, quality, atmos, this);
      if (!stream || typeof stream.url !== "string" || !/^https:\/\//i.test(stream.url) || stream.encrypted === true) return null;
      return {
        url: stream.url,
        qualityTier: stream.qualityTier,
        codec: stream.codec || stream.format || "unknown",
        container: stream.container || stream.format || "unknown",
        manifest: stream.manifest || "none",
        encrypted: false,
        ...(Number(stream.sampleRate) > 0 ? { sampleRate: Number(stream.sampleRate) } : {}),
        ...(Number(stream.bitDepth) > 0 ? { bitDepth: Number(stream.bitDepth) } : {}),
        ...(Number(stream.bitrate) > 0 ? { bitrate: Number(stream.bitrate) } : {}),
        ...(stream.quality ? { quality: stream.quality } : {}),
        ...(stream.format ? { format: String(stream.format).toLowerCase() } : {}),
        provider: name
      };
    }
  };
  return provider;
}

const monochromeBase = process.env.MONOCHROME_BASE_URL || "https://tracks.monochrome.st";
const instableBase = process.env.INSTABLE_BASE_URL || "https://arcod.xyz";
const qobuzDlBase = process.env.QOBUZ_DL_BASE_URL || "https://qobuz-dll.foreyou.workers.dev";
const lastBabeBase = process.env.LASTBABE_BASE_URL || "https://lastbabe.velixir.run";
const deezerBase = process.env.DEEZER_BASE_URL || "https://dzr.tabs-vs-spaces.wtf";
const eljohnzcBase = process.env.ELJOHNZC_BASE_URL || "https://eljohnzc-addon.de.deplexo.com/59efe06a96";

const monochrome = makeProvider({
  id: "rz-monochrome", name: "ReZenOnance · Monochrome", baseUrl: monochromeBase,
  async searchRows(query, _quality, _atmos, self) {
    const body = await getJson(withParams(self.baseUrl, "/search/tracks", { q: query, limit: 10 }), 12000, {
      "accept-language": "en-US,en;q=0.9", referer: "https://monochrome.st/", origin: "https://monochrome.st"
    });
    return (Array.isArray(body?.tracks) ? body.tracks : []).filter(isRecord).map((raw) => ({
      id: raw.id ?? raw.trackId, title: raw.title,
      artist: Array.isArray(raw.artistNames) ? raw.artistNames.join(", ") : "",
      artwork: raw.artwork,
      duration: Number(raw.duration) > 3600 ? Number(raw.duration) / 1000 : raw.duration,
      format: "flac", audioQuality: "LOSSLESS"
    }));
  },
  async resolveStream(id, _quality, _atmos, self) {
    const clean = safeId(id);
    return clean ? { url: new URL(`/track/${encodeURIComponent(clean)}`, self.baseUrl).toString(), format: "flac", quality: "LOSSLESS" } : null;
  }
});

const instable = makeProvider({
  id: "rz-arcod", name: "ReZenOnance · Arcod", baseUrl: instableBase,
  async searchRows(query, _quality, _atmos, self) {
    const body = await getJson(withParams(self.baseUrl, "/api/search", { q: query }));
    const items = body?.data?.tracks?.items;
    return (Array.isArray(items) ? items : []).filter(isRecord).map((raw) => ({
      id: raw.id, title: raw.title, artist: raw.performer?.name, album: raw.album?.title,
      artwork: raw.album?.image?.large, duration: raw.duration,
      ...(Number(raw.maximum_bit_depth) > 0 ? { bitDepth: Number(raw.maximum_bit_depth), format: "flac", audioQuality: "LOSSLESS" } : {})
    }));
  },
  async resolveStream(id, quality, _atmos, self) {
    const clean = safeId(id);
    if (!clean) return null;
    const body = await getJson(withParams(self.baseUrl, `/api/player/stream/${encodeURIComponent(clean)}`, { quality: qualityId(quality) }), 18000);
    if (!isRecord(body) || typeof body.url !== "string") return null;
    return { url: body.url, format: text(body.mimeType)?.split("/").pop() || "flac", quality: body.quality };
  }
});

const qobuzDl = makeProvider({
  id: "rz-qobuzdl", name: "ReZenOnance · Qobuz-DL", baseUrl: qobuzDlBase,
  async searchRows(query, _quality, _atmos, self) {
    const body = await getJson(withParams(self.baseUrl, "/api/get-music", { q: query, offset: 0 }));
    const items = body?.data?.tracks?.items;
    return (Array.isArray(items) ? items : []).filter(isRecord).map((raw) => ({
      id: raw.id, title: raw.title, artist: raw.performer?.name, album: raw.album?.title,
      artwork: raw.album?.image?.large, duration: raw.duration,
      ...(Number(raw.maximum_bit_depth) > 0 ? { bitDepth: Number(raw.maximum_bit_depth), format: "flac", audioQuality: "LOSSLESS" } : {})
    }));
  },
  async resolveStream(id, quality, _atmos, self) {
    const clean = safeId(id);
    if (!clean) return null;
    const body = await getJson(withParams(self.baseUrl, "/api/download-music", { track_id: clean, quality: qualityId(quality) }), 18000);
    const url = body?.data?.url;
    return typeof url === "string" ? { url } : null;
  }
});

let lastBabeResolvedBase = "";
let lastBabeExpiresAt = 0;
let lastBabeResolving;
async function resolveLastBabeBase() {
  if (!lastBabeBase.includes("lastbabe.velixir.run") || /\/e\/[^/]+\/[^/]+/.test(lastBabeBase)) return cleanBase(lastBabeBase);
  if (lastBabeResolvedBase && Date.now() < lastBabeExpiresAt - 60000) return lastBabeResolvedBase;
  if (lastBabeResolving) return lastBabeResolving;
  lastBabeResolving = (async () => {
    const root = lastBabeBase.endsWith("/") ? lastBabeBase : `${lastBabeBase}/`;
    const challenge = await getJson(new URL("challenge", root), 18000);
    if (typeof challenge?.challenge !== "string") throw new Error("LastBabe challenge response was invalid");
    const difficulty = Number.isInteger(challenge.difficulty) && challenge.difficulty >= 1 && challenge.difficulty <= 8 ? challenge.difficulty : 4;
    const prefix = "0".repeat(difficulty);
    let nonce = 0;
    let found;
    while (!found) {
      for (let i = 0; i < 20000; i++) {
        nonce++;
        if (createHash("sha256").update(challenge.challenge + String(nonce)).digest("hex").startsWith(prefix)) { found = String(nonce); break; }
      }
      if (!found) await new Promise((resolve) => setImmediate(resolve));
    }
    const response = await fetch(new URL("mint", root), {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ challenge: challenge.challenge, nonce: found }), signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(`LastBabe mint HTTP ${response.status}`);
    const minted = await response.json();
    const manifestUrl = minted?.manifestUrl || minted?.addonUrl;
    if (typeof manifestUrl !== "string" || !/^https:\/\//i.test(manifestUrl)) throw new Error("LastBabe mint response was invalid");
    lastBabeResolvedBase = cleanBase(manifestUrl.replace(/\/manifest\.json$/i, ""));
    lastBabeExpiresAt = Number(minted.expiresAt) > 0 ? Number(minted.expiresAt) * 1000 : Date.now() + 48 * 60 * 60 * 1000;
    return lastBabeResolvedBase;
  })().finally(() => { lastBabeResolving = undefined; });
  return lastBabeResolving;
}
const lastBabe = makeProvider({
  id: "rz-lastbabe", name: "ReZenOnance · LastBabe", baseUrl: lastBabeBase,
  async searchRows(query, _quality, _atmos) {
    const base = await resolveLastBabeBase();
    const body = await getJson(withParams(base, "/search", { q: query }));
    return rowsFrom(body).filter(isRecord).map((raw) => ({
      id: raw.trackId ?? raw.id, title: raw.title, artist: raw.artist ?? raw.artists,
      album: raw.album, duration: raw.duration, artwork: raw.artwork ?? raw.artworkURL,
      format: raw.format, audioQuality: raw.audioQuality
    }));
  },
  async resolveStream(id, quality) {
    const clean = safeId(id);
    if (!clean) return null;
    const base = await resolveLastBabeBase();
    const body = await getJson(withParams(base, `/stream/${encodeURIComponent(clean)}`, { quality }));
    return isRecord(body) ? body : null;
  }
});

function remoteAddon(id, name, baseUrl) {
  return makeProvider({
    id, name, baseUrl,
    async searchRows(query, quality, atmos, self) {
      const body = await getJson(withParams(self.baseUrl, "/search", { q: query, quality, atmos }));
      return rowsFrom(body).filter(isRecord).map((raw) => ({
        id: raw.id ?? raw.upstreamId ?? raw.trackId, title: raw.title,
        artist: typeof raw.artist === "object" ? raw.artist?.name : raw.artist ?? raw.artists,
        album: typeof raw.album === "object" ? raw.album?.title : raw.album,
        duration: raw.duration, artwork: raw.artworkURL ?? raw.artwork,
        format: raw.format, audioQuality: raw.audioQuality ?? raw.quality,
        sampleRate: raw.sampleRate, bitDepth: raw.bitDepth, bitrate: raw.bitrate
      }));
    },
    async resolveStream(idValue, quality, atmos, self) {
      const clean = safeId(idValue);
      if (!clean) return null;
      const body = await getJson(withParams(self.baseUrl, `/stream/${encodeURIComponent(clean)}`, { quality, atmos }), 18000);
      if (!isRecord(body) || typeof body.url !== "string") return null;
      return body;
    }
  });
}

export const rezenonanceProviders = [
  monochrome,
  instable,
  qobuzDl,
  lastBabe,
  remoteAddon("rz-deezer", "ReZenOnance · Deezer", deezerBase),
  remoteAddon("rz-eljohnzc", "ReZenOnance · Eljohnzc", eljohnzcBase)
];
