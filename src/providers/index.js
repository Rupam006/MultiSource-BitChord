import { normalizeTrack } from "../normalize.js";

const definitions = [
  { id: "pencarimusic", name: "PencariMusic", baseUrl: process.env.PENCARIMUSIC_URL || "https://stream.pencarimovie.com/66ff097863dedb7ccd8401d5ffe616f3/music", enabled: true },
  { id: "prodpwh", name: "prodpwh", baseUrl: process.env.PRODPWH_ADDON_URL || "", enabled: Boolean(process.env.PRODPWH_ADDON_URL) },
  { id: "confih", name: "Confih Hi-Res", baseUrl: process.env.CONFIH_URL || "https://bitchord.confih.tech", enabled: true },
  { id: "heisenberg", name: "Qobuz [Heisenberg]", baseUrl: process.env.HEISENBERG_URL || "https://heisenbergbackaaahh.de.deplexo.com/a", enabled: true },
  { id: "juanjob", name: "juanjob hi res", baseUrl: process.env.JUANJOB_URL || "https://bitchord-hires-addon.de.deplexo.com", enabled: false, note: "Requires device-bound BitChord proof; cannot be proxied server-to-server." }
];

const providers = definitions.map((definition) => ({
  ...definition,
  baseUrl: definition.baseUrl.replace(/\/+$/, ""),
  async request(path, timeoutMs = 9000) {
    if (!this.enabled || !this.baseUrl) throw new Error("provider is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json", "user-agent": "MultiSource-BitChord/1.0" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  },
  async search(query, quality) {
    const payload = await this.request(`/search?q=${encodeURIComponent(query)}&quality=${encodeURIComponent(quality || "lossless")}`);
    const rows = Array.isArray(payload) ? payload : (payload.tracks || payload.results || payload.data || []);
    return rows.map((row) => normalizeTrack(row, this.id)).filter(Boolean);
  },
  async resolve(upstreamId, quality) {
    const payload = await this.request(`/stream/${encodeURIComponent(upstreamId)}?quality=${encodeURIComponent(quality || "lossless")}`, 12000);
    const url = payload.url || payload.streamURL || payload.streamUrl;
    if (!url || !/^https:\/\//i.test(url) || payload.encrypted === true) return null;
    return {
      url,
      codec: payload.codec || payload.format || "flac",
      container: payload.container || payload.format || "flac",
      manifest: payload.manifest || "none",
      encrypted: false,
      ...(payload.sampleRate ? { sampleRate: Number(payload.sampleRate) } : {}),
      ...(payload.bitDepth ? { bitDepth: Number(payload.bitDepth) } : {}),
      ...(payload.bitrate ? { bitrate: Number(payload.bitrate) } : {}),
      quality: payload.quality || payload.audioQuality || "LOSSLESS",
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
