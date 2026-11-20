import { allProviders } from "../src/providers/index.js";

const args = process.argv.slice(2);
const queryIndex = args.indexOf("--query");
const queries = queryIndex >= 0 && args[queryIndex + 1]
  ? [args[queryIndex + 1]]
  : String(process.env.SMOKE_QUERIES || "Daft Punk Get Lucky;The Weeknd Blinding Lights")
      .split(";").map((value) => value.trim()).filter(Boolean);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 10_000);
const catalogueOnly = new Set(["juanjo-deezer"]);

async function probeStream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "audio/*, application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream, */*",
        range: "bytes=0-2047",
        "user-agent": "MultiSource-BitChord-provider-smoke/1.0"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok && response.status !== 206) {
      return { ok: false, status: response.status, reason: "http_status" };
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.startsWith("text/html") || contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: response.status, contentType, reason: "non_media_content_type" };
    }
    if (!response.body) return { ok: false, status: response.status, reason: "empty_body" };
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => {});
    const bytesRead = first.value?.byteLength || 0;
    return bytesRead > 0
      ? { ok: true, status: response.status, contentType: contentType || "unknown", bytesRead }
      : { ok: false, status: response.status, contentType: contentType || "unknown", reason: "empty_body" };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timeout" : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkProvider(provider) {
  if (!provider.enabled || !provider.baseUrl) {
    return { provider: provider.id, state: "disabled", playable: false };
  }
  if (catalogueOnly.has(provider.id)) {
    let found = false;
    for (const query of queries) {
      try {
        const rows = await provider.search(query, "lossless", "stereo", {});
        if (rows.length) { found = true; break; }
      } catch {}
    }
    return { provider: provider.id, state: found ? "catalogue_search_ok_playback_mirror_only" : "search_failed_or_empty", playable: false };
  }

  const errors = [];
  for (const query of queries) {
    let rows;
    try {
      rows = await provider.search(query, "lossless", "stereo", {});
    } catch (error) {
      errors.push(`search: ${String(error?.message || error)}`);
      continue;
    }
    for (const row of rows.slice(0, 5)) {
      try {
        const stream = await provider.resolve(row._upstreamId, "lossless", "stereo", {});
        if (!stream?.url || new URL(stream.url).protocol !== "https:") continue;
        const probe = await probeStream(stream.url);
        if (probe.ok) {
          return {
            provider: provider.id,
            state: "playable",
            playable: true,
            matchedTrack: `${row.artist} - ${row.title}`,
            probe
          };
        }
        errors.push(`stream probe: ${probe.reason || probe.status}`);
      } catch (error) {
        errors.push(`resolve: ${String(error?.message || error)}`);
      }
    }
  }
  return { provider: provider.id, state: "not_verified", playable: false, errors: errors.slice(-5) };
}

const providers = allProviders.filter((provider) => provider.id !== "juanjo-deezer");
const results = await Promise.all(providers.map(checkProvider));
for (const result of results) console.log(JSON.stringify(result));
const checked = results.filter((result) => result.state !== "disabled");
const passed = checked.filter((result) => result.playable).length;
console.log(`\\nProvider playback smoke: ${passed}/${checked.length} verified`);
if (passed === 0) process.exitCode = 1;
