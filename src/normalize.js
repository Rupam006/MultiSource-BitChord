const QUALITY_LABELS = {
  lossless: "Lossless / Hi-Res",
  high: "High quality",
  low: "Data saver"
};

function spatialPreferenceLabel(value) {
  return String(value || "stereo").toLowerCase() === "auto"
    ? "Dolby Atmos (when available)"
    : "Stereo";
}

function detectedSpatialAudio(track) {
  const raw = track.spatialAudio ?? track.spatial_audio ?? track.audioMode ?? track.audio_mode ?? track.atmos;
  if (raw === true) return "Dolby Atmos";
  if (raw === false || raw == null) return undefined;
  const value = String(raw).toLowerCase().replace(/[_-]+/g, " ").trim();
  if (value.includes("atmos")) return "Dolby Atmos";
  if (value === "stereo" || value.includes("2 channel") || value.includes("2.0")) return "Stereo";
  return undefined;
}

export function normalizeSearchText(value) {
  return String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(feat|ft)\.?\b/g, " ")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function searchRelevanceScore(track, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(track?.title);
  const artist = normalizeSearchText(track?.artist);
  const album = normalizeSearchText(track?.album);
  if (!q || !title) return 0;
  const qTokens = q.split(" ").filter(Boolean);
  const titleTokens = new Set(title.split(" "));
  const artistTokens = new Set(artist.split(" "));
  const albumTokens = new Set(album.split(" "));
  const overlap = (tokens, set) => tokens.filter((token) => set.has(token)).length / Math.max(tokens.length, 1);
  const titleCoverage = overlap(qTokens, titleTokens);
  const allCoverage = qTokens.filter((token) => titleTokens.has(token) || artistTokens.has(token) || albumTokens.has(token)).length / qTokens.length;
  const exactTitle = title === q ? 1 : 0;
  const titleStarts = title.startsWith(q) ? 1 : 0;
  const compactTitle = title.replace(/\s/g, "");
  const compactQuery = q.replace(/\s/g, "");
  const compactExact = compactTitle === compactQuery ? 1 : 0;
  return exactTitle * 1000 + compactExact * 900 + titleStarts * 250 +
    titleCoverage * 150 + allCoverage * 100 + (title.includes(q) ? 100 : 0);
}

export function normalizeTrack(track, providerId, requestedQuality = "lossless", requestedAtmos = "stereo") {
  if (!track || typeof track !== "object" || !track.title) return null;
  const rawId = String(track.id ?? track.trackId ?? "");
  if (!rawId) return null;
  const id = Buffer.from(rawId).toString("base64url");
  const artistValue = track.artist ?? track.artists ?? "";
  const artist = Array.isArray(artistValue)
    ? artistValue.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean).join(", ")
    : String(artistValue);
  const rawDuration = Number(track.durationMs ?? track.duration ?? track.durationSeconds ?? 0);
  const duration = track.durationMs != null ? rawDuration / 1000 : rawDuration > 100000 ? rawDuration / 1000 : rawDuration;
  const sampleRate = Number(track.sampleRate ?? track.sample_rate);
  const bitDepth = Number(track.bitDepth ?? track.bit_depth);
  const bitrate = Number(track.bitrate);
  const format = String(track.format || track.codec || "unknown").toLowerCase();
  const quality = String(track.audioQuality || track.quality || (format === "flac" ? "LOSSLESS" : "UNKNOWN")).toUpperCase();
  const qualityTier = String(track.qualityTier || track.requestedQuality || requestedQuality || "lossless").toLowerCase();
  const spatialPreference = spatialPreferenceLabel(requestedAtmos);
  const detectedSpatial = detectedSpatialAudio(track);
  const resolution = Number.isFinite(bitDepth) && bitDepth > 0 && Number.isFinite(sampleRate) && sampleRate > 0
    ? `${bitDepth}-bit / ${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`
    : undefined;
  return {
    id: `${providerId}:${id}`,
    title: String(track.title).trim(),
    artist: artist.trim(),
    album: String(track.album ?? "").trim(),
    ...(Number.isFinite(duration) && duration > 0 ? { duration: Math.round(duration) } : {}),
    ...(track.artworkURL || track.artwork || track.cover ? { artworkURL: track.artworkURL || track.artwork || track.cover } : {}),
    format,
    audioQuality: quality,
    qualityTier: `${QUALITY_LABELS[qualityTier] || QUALITY_LABELS.lossless} · ${spatialPreference}`,
    spatialAudioPreference: spatialPreference,
    ...(detectedSpatial ? { spatialAudio: detectedSpatial } : {}),
    ...(resolution ? { resolution } : {}),
    ...(Number.isFinite(sampleRate) && sampleRate > 0 ? { sampleRate } : {}),
    ...(Number.isFinite(bitDepth) && bitDepth > 0 ? { bitDepth } : {}),
    ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {}),
    source: track.source || providerId,
    _providerId: providerId,
    _upstreamId: rawId
  };
}

export function audioResolutionScore(track = {}) {
  const bitDepth = Number(track.bitDepth ?? track.bit_depth) || 0;
  const sampleRate = Number(track.sampleRate ?? track.sample_rate) || 0;
  const bitrate = Number(track.bitrate) || 0;
  const quality = String(track.audioQuality ?? track.quality ?? track.qualityTier ?? "").toUpperCase();
  const format = String(track.format ?? track.codec ?? track.container ?? "").toLowerCase();
  let score = 0;
  if (bitDepth > 0 && sampleRate > 0) {
    score = 40_000_000_000 + bitDepth * 100_000_000 + sampleRate;
  } else if (/HI.?RES|HIGH.?RES|MQA|DSD/.test(quality)) {
    score = 30_000_000_000;
  } else if (/LOSSLESS|FLAC|ALAC|WAV/.test(quality)) {
    score = 20_000_000_000;
  } else if (bitrate > 0) {
    score = 10_000_000_000 + bitrate;
  } else if (["flac", "alac", "wav", "aiff"].includes(format)) {
    score = 5_000_000_000;
  }
  if (["flac", "alac", "wav", "aiff"].includes(format)) score += 100_000;
  if (bitrate > 0) score += Math.min(bitrate, 10_000_000);
  return score;
}

export function dedupeTracks(tracks, limit = 60) {
  const seen = new Set();
  const output = [];
  const ranked = tracks.map((track, index) => ({ track, index }))
    .sort((a, b) => audioResolutionScore(b.track) - audioResolutionScore(a.track) || a.index - b.index)
    .map(({ track }) => track);
  for (const track of ranked) {
    const title = normalizeSearchText(track.title);
    const artist = normalizeSearchText(track.artist);
    const duration = Number(track.duration) || 0;
    const key = `${title}|${artist}|${duration ? Math.round(duration / 3) * 3 : ""}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);
    const { _providerId, _upstreamId, ...publicTrack } = track;
    output.push(publicTrack);
    if (output.length >= limit) break;
  }
  return output;
}

export function unpackTrackId(value) {
  const [providerId, encoded] = String(value).split(":");
  if (!providerId || !encoded) return null;
  try { return { providerId, upstreamId: Buffer.from(encoded, "base64url").toString("utf8") }; }
  catch { return null; }
}


const DISTINCT_VERSION_MARKERS = [
  "live", "remix", "acoustic", "instrumental", "karaoke", "sped up",
  "slowed", "nightcore", "cover", "demo", "radio edit", "extended mix"
];

function versionMarkers(value) {
  const raw = String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const padded = ` ${raw} `;
  return DISTINCT_VERSION_MARKERS.filter((marker) => padded.includes(` ${marker} `));
}

function tokenSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = left.split(" ");
  const b = right.split(" ");
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = [...aSet].filter((token) => bSet.has(token)).length;
  const dice = (2 * intersection) / (aSet.size + bSet.size);
  const prefix = left.startsWith(right) || right.startsWith(left) ? 0.08 : 0;
  return Math.min(1, dice + prefix);
}

export function trackMatchScore(left, right) {
  const leftTitle = normalizeSearchText(left?.title);
  const rightTitle = normalizeSearchText(right?.title);
  if (!leftTitle || !rightTitle) return 0;

  const leftVersions = versionMarkers(left?.title);
  const rightVersions = versionMarkers(right?.title);
  if (leftVersions.join("|") !== rightVersions.join("|")) return 0;

  const titleScore = tokenSimilarity(leftTitle, rightTitle);
  if (titleScore < 0.55) return 0;

  const leftArtist = normalizeSearchText(left?.artist);
  const rightArtist = normalizeSearchText(right?.artist);
  const artistScore = leftArtist && rightArtist
    ? tokenSimilarity(leftArtist, rightArtist)
    : 0.5;
  return titleScore * 0.78 + artistScore * 0.22;
}
