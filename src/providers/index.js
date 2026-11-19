import { normalizeTrack } from "../normalize.js";

const DEFAULT_TIMEOUT_MS = 6500;
const QUALITY_LEVELS = new Set(["lossless", "high", "low"]);

const definitions = [
  { id: "pencarimusic", name: "PencariMusic", baseUrl: process.env.PENCARIMUSIC_URL || "https://stream.pencarimovie.com/66ff097863dedb7ccd8401d5ffe616f3/music", enabled: true },
  { id: "prodpwh", name: "prodpwh", baseUrl: process.env.PRODPWH_ADDON_URL || "", enabled: Boolean(process.env.PRODPWH_ADDON_URL) },
  { id: "confih", name: "Confih Hi-Res", baseUrl: process.env.CONFIH_URL || "https://bitchord.confih.tech", enabled: true },
  { id: "heisenberg", name: "Qobuz [Heisenberg]", baseUrl: process.env.HEISENBERG_URL || "https://heisenbergbackaaahh.de.deplexo.com/a", enabled: true },
  { id: "juanjob", name: "Hi-res (Qobuz / Tidal / Monochrome / Netease)", baseUrl: process.env.JUANJOB_URL || "https://hiress.onrender.com", enabled: true, note: "Forwards the verified BitChord request proof; upstream must allow the aggregator hostname." }
];

function normalizeQuality(value) {
  const quality = String(value || "lossless").toLowerCase();
  return QUALITY_LEVELS.has(quality) ? quality : "lossless";
}

function qualityLabel(value) {
  return ({ lossless: "Maximum Lossless / Hi-Res", high: "High Lossless", low: "Low / Data saver" })[normalizeQuality(value)];
}

const providers = definitions.map((definition) => ({
  ...definition,
  baseUrl: definition.baseUrl.replace(/\/manifest\.json$/i, "").replace(/\/+$/, ""),
  async request(path, timeoutMs = DEFAULT_TIMEOUT_MS, forwardedAuth = {}) {
    if (!this.enabled || !this.baseUrl) throw new Error("provider is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json", "user-agent": "MultiSource-BitChord/1.1", ...forwardedAuth },
        signal: controller.signal,
        redirect: "follow"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  },
  async search(query, quality, atmos = "stereo", authHeaders = {}) {
    const params = new URLSearchParams({
      q: query,
      quality: normalizeQuality(quality),
      atmos: atmos === "auto" ? "auto" : "stereo"
    });
    const payload = await this.request(`/search?${params}`, DEFAULT_TIMEOUT_MS, this.id === "juanjob" ? authHeaders : {});
    const candidateRows = Array.isArray(payload)
      ? payload
      : (payload?.tracks || payload?.results || payload?.data?.tracks || payload?.data || []);
    const rows = Array.isArray(candidateRows) ? candidateRows : [];
    return rows.map((row) => normalizeTrack(row, this.id, normalizeQuality(quality))).filter(Boolean);
  },
  async resolve(upstreamId, quality, atmos = "stereo", authHeaders = {}) {
    const params = new URLSearchParams({
      quality: normalizeQuality(quality),
      atmos: atmos === "auto" ? "auto" : "stereo"
    });
    const payload = await this.request(`/stream/${encodeURIComponent(upstreamId)}?${params}`, 8500, this.id === "juanjob" ? authHeaders : {});
    if (!payload || typeof payload !== "object") return null;
    const streamData = payload.stream && typeof payload.stream === "object" ? payload.stream : payload;
    const url = streamData.url || streamData.streamURL || streamData.streamUrl || streamData.downloadUrl;
    if (!url || !/^https:\/\//i.test(url) || streamData.encrypted === true) return null;
    const sampleRate = Number(streamData.sampleRate ?? streamData.sample_rate);
    const bitDepth = Number(streamData.bitDepth ?? streamData.bit_depth);
    const bitrate = Number(streamData.bitrate);
    const resolution = Number.isFinite(bitDepth) && bitDepth > 0 && Number.isFinite(sampleRate) && sampleRate > 0
      ? `${bitDepth}-bit / ${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`
      : undefined;
    return {
      url,
      qualityTier: qualityLabel(quality),
      ...(resolution ? { resolution } : {}),
      codec: streamData.codec || streamData.format || "unknown",
      container: streamData.container || streamData.format || "unknown",
      manifest: streamData.manifest || "none",
      encrypted: false,
      ...(Number.isFinite(sampleRate) && sampleRate > 0 ? { sampleRate } : {}),
      ...(Number.isFinite(bitDepth) && bitDepth > 0 ? { bitDepth } : {}),
      ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {}),
      ...(streamData.quality || streamData.audioQuality ? { quality: streamData.quality || streamData.audioQuality } : {}),
      ...(streamData.codec || streamData.format ? { format: String(streamData.codec || streamData.format).toLowerCase() } : {}),
      ...(streamData.atmos ? { atmos: streamData.atmos } : {}),
      provider: this.name
    };
  }
}));

export const allProviders = providers;
export function providerStatus() {
  return providers.map(({ id, name, enabled, baseUrl, note }) => ({
    id, name, enabled: Boolean(enabled && baseUrl), ...(note ? { note } : {})
  }));
}
export function findProvider(id) { return providers.find((provider) => provider.id === id); }
