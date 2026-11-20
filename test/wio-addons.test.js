import test from "node:test";
import assert from "node:assert/strict";
import { wioAddonProviders } from "../src/providers/wio-addons.js";

test("WioLand sources are assigned to the requested primary and fallback tiers", () => {
  assert.deepEqual(wioAddonProviders.map(({ id, role }) => [id, role]), [
    ["eljohn-mono", "primary"],
    ["confih", "fallback"],
    ["qobuz-addon", "fallback"],
    ["gglos", "fallback"],
    ["lastbabe", "fallback"],
    ["tido", "fallback"]
  ]);
});

test("generic WioLand addon adapter reads manifest quality options and resolves secure streams", async () => {
  const provider = wioAddonProviders.find((item) => item.id === "confih");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const body = url.pathname === "/manifest.json"
      ? { id: "fixture", settings: [{ key: "quality", default: "lossless", options: [{ value: "hi_res_lossless" }, { value: "lossless" }] }] }
      : url.pathname === "/search"
        ? { tracks: [{ id: "song-1", title: "Test Song", artist: "Test Artist", duration: 180, format: "flac" }] }
        : { stream: { url: "https://cdn.example/song.flac", codec: "flac", sampleRate: 96000, bitDepth: 24, encrypted: false } };
    return { ok: true, status: 200, async json() { return body; } };
  };
  try {
    const tracks = await provider.search("Test Song", "lossless", "stereo");
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]._providerId, "confih");
    assert.equal(tracks[0]._upstreamId, "song-1");
    const stream = await provider.resolve("song-1", "lossless", "stereo");
    assert.equal(stream.url, "https://cdn.example/song.flac");
    assert.equal(stream.sampleRate, 96000);
    assert.equal(calls.find((url) => url.pathname === "/search").searchParams.get("quality"), "hi_res_lossless");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generic WioLand addon adapter rejects encrypted and non-HTTPS streams", async () => {
  const provider = wioAddonProviders.find((item) => item.id === "tido");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() {
    return { url: "http://cdn.example/song.flac", encrypted: true };
  } });
  try {
    assert.equal(await provider.resolve("song-1", "lossless"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
