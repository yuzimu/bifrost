# Resilience Runtime

## Public Contract

`New(Config, schemas.Logger, ...Option) (*Runtime, error)` creates one process-local
runtime. `Cleanup` stops the five-second worker and frees attempt leases.
`UpdateConfig` validates and atomically replaces owned configuration;
`ChangeConfig` serializes read/modify/persist/apply management operations.
`DecodeConfig` supplies default-on direction/key selection. Management PUT uses
`AdaptiveConfig` directly: omitted switches become false.

`FilterProviders(ctx, eligible, model)` and `SelectProvider(ctx, eligible, model)`
accept only candidates already authorized and budget-filtered by governance.
They never enumerate additional providers, models or keys.
`FilterKeys(ctx, provider, model, keys)` returns a subset of the caller's eligible
pool. Hard exclusions and a closed Runtime return an empty slice with nil error,
so a core filter adapter cannot restore the original pool on error.
The resulting empty pool requires a hard 503 in the core adapter.
`SelectKey(ctx, keys, provider, model)` matches `schemas.KeySelector`.

`BeginAttempt(ctx, provider, model, keyID, requestType)` creates the lease for one
actual upstream attempt. `ObserveAttempt(id, Observation)` consumes its result
once; `CancelAttempt(id)` releases it without recording provider failure.
`ObservationFromResponse` reuses core failure classification and excludes
recognized guardrail signals. Supply `AccountQuota` only for explicit
account-level quota signals. Supply the actual attempt's response headers,
latency and token usage, not the total retry chain.

Every fixed-key path, pinned-key path and same-key retry needs this lifecycle,
not only the multi-key selector. Streaming records one final observation per
attempt, never one request per chunk. `Plugin` supplies per-attempt pre/post
hooks, while the core adapter must account for internal retries separately.
When the adapter settles an attempt, its later plugin post-hook is a no-op.

`Plugin.EligibleTargets` supplies already authorized provider/model/key targets for
`ApplyCircuitPolicies`. An unchanged target retains its full key pin. Explicit
request key-ID/name pins, routing-rule pins and fallback key-ID pins are not
released by a circuit policy: the existing hard-open gate rejects them rather
than selecting a different credential. An unpinned redirect uses the authorized
destination's own key scope, never the original provider's key. Header policy
chains stop at the last new target on a cycle. Fallbacks are stably deduplicated
by provider/model/key ID, excluding the identical resolved primary; different
key IDs remain separate attempts.
`Plugin.EligibleProviders` supplies governance-filtered candidates to
`RouteRequest`; `Plugin.RefineModel` supplies the existing catalog normalizer.
Direction-off leaves provider/model/fallback untouched. Pinned primaries stay
unchanged by default; opt-in append, failed-direction reroute and fallback
pruning are implemented by that method. It never adds a generated fallback
chain or adaptive pinned reroute to image/video creation requests.
No hook replays a completed request. Existing media job retrieval/download and
batch retrieval/result/cancel/list operations bypass adaptive routing and gates.
The host must register the `resilience` observation hook exactly once. Adaptive
routing and circuit breaker are feature/configuration aliases of that runtime,
not two registrations of the same Plugin. Aliases must share one cleanup owner.

`InvalidateKey(provider, keyID)` must run on edit/rotation/delete to clear hold
state and invalidate old attempt epochs. `GetSnapshot`, `ClearHeldKeys` and
`ResetCircuit` expose runtime state without key secrets.
Each attempt freezes both model-key and global-key hold revisions. Success and
failure can settle holds only when both revisions still match. Manual clear
advances revisions even for matching inflight scopes without a current hold;
future claims use the new revision and may hold again. Model-specific clear
does not release a global-key hold or invalidate unrelated models. Revision
tombstones remain while a hold or inflight attempt references their scope.
`InvalidateProvider` removes deleted-provider state.
`SetProviderModelKeys(provider, model, keys)` supplies the full configured
model-capable key pool as ID-only metadata, not a request-scoped subset. This
allows wildcard candidates and provider Failed state to account for cold keys.
Refresh that view during configuration changes or before provider selection;
stale views expire after one hour.
Empty `ProviderCandidate.KeyIDs`, including nil, authorize no configured key;
only `["*"]` permits the complete configured pool. The nil/unrestricted result
of `Access.KeysForModel` is a different contract and must not be substituted.
Governance publishes `ProviderKeylessContextKey` from its existing configured
provider map during pre-request processing and before load balancing: only explicit `IsKeyLess` custom providers
(excluding Bedrock) bypass key-pool admission. Dynamic/direct credentials do not
grant provider-pool access. Keyless attempts record direction metrics once.

## HTTP Integration

`NewResilienceHandler(resolve, persist)` resolves the active runtime per request.
The persister must write the existing TablePlugin configuration; updates are
published only after that callback succeeds. The server owns management auth
and resource permissions, lifecycle registration and schema registration.

Public management paths:

- GET/PUT `/api/load-balancer-config`
- POST `/api/load-balancer-config/conditions/clear`
- GET/POST `/api/circuit-breaker/policies`
- PUT/DELETE `/api/circuit-breaker/policies/{name}`
- GET `/api/circuit-breaker/state`

GET `/api/adaptive-routing` is a fork-defined statistics endpoint. Its schema is
the exported `Snapshot` type. Policy cooldown writes accept Go duration strings
or integer nanoseconds within the signed 64-bit duration range. Integer values
normalize to Go duration strings internally; fractional numbers, overflow,
negative integers, null, booleans, unknown fields, and trailing JSON are rejected.
Both input forms allow explicit zero, preserving a zero waiting period under the
existing circuit/probe lifecycle. Zero is not replaced with the default; only an
omitted or empty string uses the 30-second default.
Policy reads and circuit state cooldowns use nanoseconds. CB conditions contain
only public response-header signals, not CEL or rolling error thresholds.

## Adaptive Formula

Metrics and weights are local to this process. Every five seconds, recent
request failures and token throughput decay with a 30-second time constant.
Latency is milliseconds per max(1, tokens/100), with EWMA alpha 0.2 and successful
baseline alpha 0.05. Peer latency and throughput are compared within a model
for providers, and within provider/model for keys.

The factor is
`max(0.02, exp(-5*errorRate) / max(1, peerLatencyRatio, baselineRatio) / max(1, throughputRatio))`.
Recovering routes discount the historical error term by 0.2. Base weights are
multiplied by the factor; a zero-base route is excluded while positive-weight
peers exist. Entirely zero-weight key pools retain the existing uniform random
behavior, and explicit key pins are not overridden. A new route's factor is 1.
Error rate >= 0.15 or relative latency > 2 marks Degraded; >= 0.6 with at least
three decayed observations marks Failed. A successful Failed route enters
Recovering; three successes with discounted error rate < 0.1 return Healthy.
Health labels do not independently gate traffic: held keys and header circuits
own admission, and viable low-scoring routes retain exploration weight.

Held keys use documented model/global scope, wait caps, a 30-second doubling
ladder with +/-10% jitter, and provider hints bounded to 10 seconds..5 minutes.
Only a failed check increases its rung. A released route reuses its rung for
ten minutes. Operator release and key edits clear its ladder.
All-held pools permit one real checking request; CB hard-open exclusions and
occupied probe slots are never resurrected. Cancelled or unreported probes
release their slot, with a five-minute maximum lease.

## Boundaries

This is an independently defined public-behavior implementation, not the private
enterprise algorithm. No ten-microsecond latency claim is made.
`append_fallbacks_to_pinned`, `reroute_failed_directions` and
`prune_failed_fallbacks` are live switches implemented by `RouteRequest`.
The host supplies its authorized candidate resolver and model normalizer;
without `Plugin.EligibleProviders`, only governance's injected selection is
adaptive and these optional pinned behaviors are not invoked.
Without `SetProviderModelKeys`, wildcard candidate key scopes stay optimistic because provider selection cannot
infer a complete configured model-key pool from a previously restricted request.
The integration needs an authoritative eligible key-pool input to exclude such
directions when every actual configured key is unavailable.

`WithKVStore(store, processOwnedNamespace)` restores and writes secret-free held
metadata every 30 seconds with a one-hour TTL. It does not create a database or
provide a distributed probe lock. Store durability is supplied by the existing
implementation; the default in-memory KV is not restart-durable. The current KV
interface has no compare-and-swap/compare-delete, so fleet-wide TPM coordination,
cross-node hold release and global epoch fencing are not implemented.
No cluster consensus or cross-node parity is claimed.

Build acceptance covers `go build ./resilience` in framework and `go build .`
in governance. Core/server wiring, authenticated API calls and live provider
behavior require integration acceptance; compilation is not runtime verification.
