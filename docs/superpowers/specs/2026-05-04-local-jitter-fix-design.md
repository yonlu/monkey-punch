# Local-player jitter fix — render-time extrapolation + reconciliation smoothing

**Status:** Design — approved 2026-05-04. Ready for implementation plan.

## Goal

Eliminate visible jitter on the local player's cube. Movement should look as
smooth as remote players' interpolated movement, without sacrificing
input responsiveness or changing the AD1 fixed-dt prediction contract.

Two distinct jitter sources are in scope:

1. **Stair-step rendering.** The predictor advances `predictedX/Z` at 20 Hz
   inside a `setInterval`, but `useFrame` reads it at 60 Hz. Between
   prediction steps the value is constant, so the cube holds for ~3 frames
   then jumps `PLAYER_SPEED * SIM_DT_S = 0.25` units. Visible as continuous
   chop while moving.
2. **Reconciliation snap on input collapse.** When two input messages land
   in one server tick window (common on direction changes due to keyboard
   event timing + `setInterval` drift), the server overwrites `inputDir` and
   integrates only the latest input but acks both seqs via
   `lastProcessedInput`. The client locally integrated both as separate
   steps. On the next snapshot, `reconcile()` writes `predictedX` back by
   ~0.25–0.5 units. Visible as a one-shot jump on direction change.
   Confirmed via `hudState.reconErr`: steady-state 0, spikes to 0.2–0.5
   during direction changes, returns to 0.

Fix both. Both are small. Doing only one leaves obvious residual jitter.

## Non-goals

- **No server changes.** The input-collapse desync described above is the
  *root cause* of the spike, but fixing it requires server-side input
  queueing with new edge cases (queue overflow, ordering across clients).
  The smoothing layer makes the desync cosmetically invisible. Revisit if
  spike magnitudes ever exceed ~1u with future gameplay (knockback,
  abilities, weapons).
- **No predictor math changes.** `step()` and `reconcile()` keep their
  existing displacement math (`dir * PLAYER_SPEED * SIM_DT_S` per input).
  AD1's bit-identical contract with the server is preserved.
- **No remote-player changes.** `SnapshotBuffer.sample()` already
  interpolates remote players smoothly. Only the `if (predictor)` branch in
  `PlayerCube.tsx` changes.
- **No adaptive smoothing.** `SMOOTHING_TAU_S` is a constant. RTT-aware
  smoothing windows are easy to add later if needed.
- **No HUD visualization of `renderOffset`.** Could be added if it
  becomes a debugging need; not preemptive.
- **No physics, no extrapolation beyond movement.** The renderOffset
  abstraction generalizes to any scalar correction (knockback, server-pushed
  teleport) but no future hooks are wired in this milestone.

## Architectural decisions

**AD1: The simulation layer is unchanged. Smoothing lives in the render
layer.**
The predictor still owns `predictedX/Z` and steps them at 20 Hz with
`SIM_DT_S`. `reconcile()` still snaps `predictedX/Z` cleanly to
`server + replayedInputs`. What changes: the predictor *also* writes a
`renderOffset` (= old predicted − new predicted) that the render layer
decays toward zero. The mesh position is `extrapolated + renderOffset`,
not `predictedX/Z` directly.
Rationale: keeps the simulation testable as pure tick math. Render
smoothing has no effect on what `reconcile()` reports as `lastReconErr`
(which stays a true simulation diagnostic). Future gameplay code that
needs the predicted position (e.g. for projectile spawn) reads
`predictedX/Z` and gets the authoritative simulation value, not a
visually-smoothed one.

**AD2: Render extrapolation uses *live* keyboard input, not the
predictor's last-sent input.**
Each render frame: `extrapolatedX = predictedX + liveDir.x * PLAYER_SPEED *
tSinceStep`. `liveDir` comes from `getLiveInputDir()` in `input.ts`,
reading the module-local `KEYS` state.
Rationale: key release at `t = 10ms` should stop the cube immediately. If
extrapolation used the predictor's last-sent input, the cube would keep
gliding for up to 50ms after release — perceptible stick-in-mud feel.
Using `liveDir` means key release zeros the velocity term on the next
frame, even though the matching `step()` won't fire until up to 50ms
later. The "real" position the server will compute lags slightly behind
this visual, but the server catches up on the next tick boundary; error
is bounded by 50ms and never accumulates.

**AD3: `tSinceStep` is clamped to `STEP_INTERVAL_MS` (50ms).**
Formula: `tSinceStep = min(now - lastStepTime, 50ms) / 1000`.
Rationale: in the steady state `setInterval` fires within 50ms, so the
clamp is a no-op. But if the tab is backgrounded or the main thread
stalls, `now - lastStepTime` can grow to seconds, and unclamped
extrapolation would catapult the cube. Clamping bounds visible error to
one step's worth of displacement (0.25u). The next `step()` snaps the
predicted position to truth and the offset decay handles the residual.

**AD4: `renderOffset` accumulates additively across reconciliations, then
exponentially decays in render.**
- On `reconcile()`: `renderOffset.x += prevPredicted.x − newPredicted.x`
  (and similarly for z). Additive, not assignment.
- On each render frame: `renderOffset.x *= exp(-frameDt / SMOOTHING_TAU_S)`
  with `SMOOTHING_TAU_S = 0.1` (100ms time constant — ~95% decay over
  300ms).
Rationale: if a second snapshot arrives before the previous offset has
fully decayed, the new correction adds to the residual rather than
replacing it. The visible cube continuously chases truth without ever
snapping to it, even under repeated corrections. 100ms is the standard
"fast enough to feel responsive, slow enough to be invisible" window
used in shipped netcode (Source engine, Quake III).

**AD5: First-frame `lastStepTime` initialization.**
The predictor's constructor sets `lastStepTime = performance.now()`.
Rationale: without this, `lastStepTime = 0`, and `now - 0` clamps to
50ms — rendering the cube `0.25u` displaced from spawn before any input
arrives. Initializing in the constructor makes the formula yield exactly
zero displacement on first paint.

**AD6: liveDir-change jumps are absorbed into `renderOffset` (extension of AD4).**
The render formula's extrapolation term — `liveDir.x * PLAYER_SPEED * tSinceStep` —
is discontinuous when `liveDir` changes between render frames. At the moment of
change, the term jumps by `(liveDir_new − liveDir_old) * PLAYER_SPEED *
tSinceStep`. For a diagonal release at `tSinceStep = 25ms`, that's ~0.088u
visible snap. For a direction reversal (D→A), it's ~0.25u — clearly visible.
The fix extends AD4: `LocalPredictor` carries `lastLiveDirX/Z` fields (NaN
sentinel for first frame); the render helper compares this frame's `liveDir`
to last frame's, computes the jump, and additively writes the negation into
`renderOffset`. The exponential decay then walks the cube's visual momentum
toward the new authoritative trajectory over ~100ms — feels like physical
inertia rather than a snap.
Why on the predictor and not in render-local state: keeps all smoothing
state co-located on `LocalPredictor` (same as `lastStepTime` and
`renderOffset`). The renderer mutates the fields the same way it mutates
`renderOffset`, and the helper's JSDoc lists both as side effects.

## Files touched

All client-only.

- `packages/client/src/net/prediction.ts`
  - Add exported constants `STEP_INTERVAL_MS = 50` (hoisted from
    `input.ts`) and `SMOOTHING_TAU_S = 0.1`.
  - Add fields `lastStepTime: number` and `renderOffset: { x, z }` to
    `LocalPredictor`.
  - Initialize `lastStepTime = performance.now()` and `renderOffset = {x:0,
    z:0}` in the constructor (or as field initializers — match existing
    style).
  - In `step()`: at end, set `lastStepTime = performance.now()`.
  - In `reconcile()`: capture `prevX/Z` before mutation; after the existing
    drain+replay, `renderOffset.x += prevX − predictedX` and `renderOffset.z
    += prevZ − predictedZ`.

- `packages/client/src/game/input.ts`
  - Import the hoisted `STEP_INTERVAL_MS` from `prediction.ts` (replace the
    local `const`).
  - Export `getLiveInputDir(): { x: number; z: number }`. Returns the same
    `computeDir()` result the `setInterval` already computes. Allocates a
    new object per call (kept simple; render layer doesn't store the
    reference).

- `packages/client/src/game/PlayerCube.tsx`
  - Change `useFrame(() => { ... })` to `useFrame((_state, delta) => { ... })`.
    The second arg is R3F's per-frame seconds since last frame — the
    canonical source for `frameDtSeconds` in the formula. Don't reach for
    `state.clock.getDelta()` (it has caller-order caveats; the second arg
    is the safe choice).
  - In the `useFrame` body for the `if (predictor)` branch: replace the
    direct `position.x = predictor.predictedX` writes with the render
    formula below.
  - In the `useEffect` initial-position branch: use the formula with
    `frameDtSeconds = 0` (decay is a no-op on first paint, and the offset
    starts at 0 anyway).

- `packages/client/src/net/prediction.test.ts`
  - Add the four new tests listed under **Testing**.

## Math contract

**Render formula (in `useFrame((_state, delta) => ...)`):**

```
const STEP_INTERVAL_S = STEP_INTERVAL_MS / 1000

// Decay first, then read — order doesn't change the math but keeps the
// "offset is the value at this frame" mental model clean.
// `delta` is the second arg to useFrame: per-frame seconds since last frame.
const decay = Math.exp(-delta / SMOOTHING_TAU_S)
predictor.renderOffset.x *= decay
predictor.renderOffset.z *= decay

const tSinceStep = Math.min(
  (performance.now() - predictor.lastStepTime) / 1000,
  STEP_INTERVAL_S,
)
const liveDir = getLiveInputDir()

const renderX =
  predictor.predictedX +
  liveDir.x * PLAYER_SPEED * tSinceStep +
  predictor.renderOffset.x
const renderZ =
  predictor.predictedZ +
  liveDir.z * PLAYER_SPEED * tSinceStep +
  predictor.renderOffset.z

ref.current.position.set(renderX, 0.5, renderZ)
```

**Reconciliation delta (in `predictor.reconcile`):**

```ts
const prevX = this.predictedX
const prevZ = this.predictedZ

// existing drain-acked + replay-unacked math, mutates this.predictedX/Z
// (unchanged)

this.renderOffset.x += prevX - this.predictedX
this.renderOffset.z += prevZ - this.predictedZ
this.lastReconErr = Math.hypot(  // unchanged
  this.predictedX - prevX,
  this.predictedZ - prevZ,
)
```

Note: `lastReconErr` already computes the same magnitude (just with sign
flipped — `hypot` is unsigned). The existing line is fine; this snippet
reorders for clarity.

## Testing

In `packages/client/src/net/prediction.test.ts`:

1. **`step()` updates `lastStepTime`.** Use a stubbed `performance.now`
   (Vitest's `vi.spyOn(performance, 'now')`) to confirm the field
   advances after each step.
2. **`reconcile()` with no error: `renderOffset` unchanged.** Construct a
   predictor, call `step()` once, simulate the matching server snapshot
   arriving with `lastProcessedInput = 1` and `serverX/Z` matching the
   predicted value. Assert `renderOffset.{x,z} === 0` and
   `lastReconErr === 0`.
3. **`reconcile()` with a known mismatch records the correct offset.**
   Step once with `dir = (1, 0)`, then call `reconcile(0, 0,
   lastProcessed=1)`. The predictor previously had `predictedX = 0.25`;
   after reconcile `predictedX = 0` (server says 0, no unacked to
   replay). Assert `renderOffset.x === 0.25` (positive — offset
   compensates for the snap-back). `lastReconErr === 0.25`.
4. **Two `reconcile()` calls in succession compose additively.** Step,
   reconcile to a smaller-than-predicted server position, capture
   `renderOffset.x`. Step again, reconcile to another snap. Assert the
   new `renderOffset.x` equals the sum of both corrections, not just the
   second one.

The render-layer decay (`offset *= exp(-dt/tau)`) is a one-liner inside
`useFrame` and is not unit-tested. If it's extracted to a helper for any
reason during implementation, add a single test for the decay formula
(input: offset, dt; expected: offset * known-exp value).

## Edge cases

- **Tab visibility / large `frameDt` on resume.** `useFrame` doesn't fire
  while the tab is hidden, so the next frame after resume can have a
  large `frameDt`. `Math.exp(-largeDt / 0.1)` correctly converges to ~0,
  zeroing the offset — desirable. The `tSinceStep` clamp prevents the
  extrapolation term from doing anything weird in the same scenario.
- **Remote players are untouched.** The `if (predictor)` branch in
  `PlayerCube.useFrame` is the only render path that changes. Remote
  cubes still go through `buffer.sample()`.
- **`hudState.reconErr` semantics unchanged.** Still reports raw
  `lastReconErr` from `reconcile()` — a true simulation-error metric, not
  visible error. That's correct; the HUD is a diagnostic surface.
- **No state for `lastStepTime` on reconnect.** The predictor instance
  outlives a reconnect (it's a `useMemo` in `GameView`). `lastStepTime`
  carries forward, which is fine — the next `step()` after reconnect
  resets it.
- **`getLiveInputDir()` allocation per call.** Returns a fresh object
  each frame. At 60 Hz that's 60 small object allocations per second per
  local player (one). Negligible. If profiling ever flags it, swap to a
  module-local mutable singleton — trivial change.

## Out of scope (revisit later if needed)

- **Server-side input queueing** to eliminate input-collapse desync at
  its source. The visible jitter is killed by smoothing; only the
  underlying `reconErr` spike remains, and the HUD-visible spike is
  small and bounded.
- **Adaptive `SMOOTHING_TAU_S`** based on RTT. 100ms is fine for LAN/WiFi.
  A high-RTT player might want a longer window, but no evidence yet.
- **Visualizing `renderOffset` in the HUD.** Would help diagnose if
  smoothing ever fails to keep up. Add only if it becomes a debugging
  need.
- **Per-axis offset decay rates.** Pointless complexity right now;
  movement is symmetric on both axes.
