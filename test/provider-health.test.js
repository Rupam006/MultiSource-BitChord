import test from "node:test";
import assert from "node:assert/strict";
import { createProviderHealthTracker } from "../src/provider-health.js";

test("opens a provider circuit after consecutive failures and recovers on a half-open success", async () => {
  let clock = 1_000;
  let shouldFail = true;
  const provider = {
    id: "fixture",
    enabled: true,
    async search() {
      if (shouldFail) throw new Error("upstream unavailable");
      return [{ id: "ok" }];
    }
  };
  const health = createProviderHealthTracker([provider], {
    failureThreshold: 3,
    baseCooldownMs: 100,
    maxCooldownMs: 500,
    now: () => clock
  });
  health.wrap(provider, "search");

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(provider.search(), /upstream unavailable/);
  }
  assert.equal(health.isAvailable(provider), false);
  assert.equal(health.status(provider).state, "circuit_open");
  await assert.rejects(provider.search(), { code: "PROVIDER_CIRCUIT_OPEN" });

  clock += 101;
  assert.equal(health.status(provider).state, "half_open");
  shouldFail = false;
  assert.deepEqual(await provider.search(), [{ id: "ok" }]);
  assert.equal(health.isAvailable(provider), true);
  assert.equal(health.status(provider).state, "healthy");
  assert.equal(health.status(provider).consecutiveFailures, 0);
});

test("records latency and leaves healthy providers available", async () => {
  let clock = 50;
  const provider = { id: "fast", enabled: true, async resolve() { clock += 12; return { url: "https://audio.test/file" }; } };
  const health = createProviderHealthTracker([provider], { now: () => clock });
  health.wrap(provider, "resolve");
  const result = await provider.resolve();
  assert.equal(result.url, "https://audio.test/file");
  assert.equal(health.status(provider).avgLatencyMs, 12);
  assert.equal(health.status(provider).totalRequests, 1);
});
