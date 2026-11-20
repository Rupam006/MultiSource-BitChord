export function createProviderHealthTracker(
  providers,
  { failureThreshold = 3, baseCooldownMs = 30_000, maxCooldownMs = 300_000, now = Date.now } = {}
) {
  const states = new Map(providers.map((provider) => [provider.id, {
    consecutiveFailures: 0,
    totalRequests: 0,
    totalFailures: 0,
    avgLatencyMs: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    openUntil: 0,
    openCount: 0,
    halfOpenInFlight: false,
    state: provider.enabled ? "healthy" : "disabled"
  }]));

  function stateFor(providerOrId) {
    const id = typeof providerOrId === "string" ? providerOrId : providerOrId.id;
    if (!states.has(id)) states.set(id, {
      consecutiveFailures: 0, totalRequests: 0, totalFailures: 0,
      avgLatencyMs: 0, lastSuccessAt: null, lastFailureAt: null,
      lastError: null, openUntil: 0, openCount: 0,
      halfOpenInFlight: false, state: "healthy"
    });
    return states.get(id);
  }

  function isAvailable(providerOrId) {
    const state = stateFor(providerOrId);
    if (state.state === "disabled") return false;
    if (state.openUntil > now()) return false;
    return !state.halfOpenInFlight;
  }

  function wrap(provider, method) {
    const original = provider[method];
    if (typeof original !== "function" || original.__healthWrapped) return;
    const wrapped = async function (...args) {
      const state = stateFor(provider);
      const timestamp = now();
      if (state.openUntil > timestamp || state.halfOpenInFlight) {
        const error = new Error(`Provider circuit is open: ${provider.id}`);
        error.code = "PROVIDER_CIRCUIT_OPEN";
        throw error;
      }
      const isHalfOpenProbe = state.openUntil > 0 && state.openUntil <= timestamp;
      if (isHalfOpenProbe) state.halfOpenInFlight = true;
      const started = now();
      state.totalRequests += 1;
      try {
        const result = await original.apply(provider, args);
        const elapsed = Math.max(0, now() - started);
        state.avgLatencyMs = state.avgLatencyMs
          ? state.avgLatencyMs * 0.7 + elapsed * 0.3
          : elapsed;
        state.consecutiveFailures = 0;
        state.openUntil = 0;
        state.openCount = 0;
        state.lastError = null;
        state.lastSuccessAt = new Date(now()).toISOString();
        state.state = "healthy";
        return result;
      } catch (error) {
        state.totalFailures += 1;
        state.consecutiveFailures += 1;
        state.lastFailureAt = new Date(now()).toISOString();
        state.lastError = String(error?.message || error).slice(0, 180);
        state.state = "degraded";
        if (isHalfOpenProbe || state.consecutiveFailures >= failureThreshold) {
          state.openCount += 1;
          const cooldown = Math.min(maxCooldownMs, baseCooldownMs * (2 ** (state.openCount - 1)));
          state.openUntil = now() + cooldown;
          state.state = "circuit_open";
        }
        throw error;
      } finally {
        if (isHalfOpenProbe) state.halfOpenInFlight = false;
      }
    };
    wrapped.__healthWrapped = true;
    provider[method] = wrapped;
  }

  function status(provider) {
    const state = stateFor(provider);
    const timestamp = now();
    let circuitState = state.state;
    if (state.openUntil && state.openUntil <= timestamp) circuitState = "half_open";
    return {
      state: provider.enabled ? circuitState : "disabled",
      consecutiveFailures: state.consecutiveFailures,
      totalRequests: state.totalRequests,
      totalFailures: state.totalFailures,
      avgLatencyMs: Math.round(state.avgLatencyMs),
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastError: state.lastError,
      ...(state.openUntil > timestamp ? { circuitOpenUntil: new Date(state.openUntil).toISOString() } : {})
    };
  }

  return { wrap, isAvailable, status };
}
