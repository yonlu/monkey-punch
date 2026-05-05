# Local-Player Jitter Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate visible jitter on the local player's cube by adding render-time extrapolation (between 20Hz prediction steps) and exponentially-decayed reconciliation smoothing — without changing server logic or the AD1 fixed-dt prediction contract.

**Architecture:** All client-only. The simulation layer (`LocalPredictor.step` + `reconcile`) keeps its existing tick-aligned math but additionally records a `lastStepTime` and an additive `renderOffset`. The render layer (`PlayerCube.useFrame`) reads predicted position, adds a live-input extrapolation (`liveDir * speed * tSinceStep`, clamped to one step), and adds the offset (which it exponentially decays per frame using the R3F-provided `delta`).

**Tech Stack:** TypeScript strict, pnpm workspaces, Vite + React + React Three Fiber 8.x, Three.js 0.164, Vitest 1.6.

**Spec:** `docs/superpowers/specs/2026-05-04-local-jitter-fix-design.md` — read it before starting; it contains the architectural decisions (AD1–AD5) that this plan implements.

**Discipline reminders (CLAUDE.md):**
- This change is client-only. Server, shared schema, shared rules, and shared messages are untouched.
- Don't change `step()` or `reconcile()`'s existing math — only add side effects (`lastStepTime` write, `renderOffset` accumulate). The AD1 bit-identical contract with the server depends on the unchanged math.
- No new shared-package dependencies. `PLAYER_SPEED` is already exported from `@mp/shared`.

**Test commands:**
- `pnpm --filter @mp/client test` — runs all client Vitest tests
- `pnpm --filter @mp/client test prediction` — runs only `prediction.test.ts`
- `pnpm typecheck` — `tsc -b` over the whole solution
- `pnpm dev` — boots server + client for manual verification

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/client/src/net/prediction.ts` | MODIFY | Add `STEP_INTERVAL_MS`, `SMOOTHING_TAU_S` constants. Add `lastStepTime` + `renderOffset` fields to `LocalPredictor`. Update `step()` to record `lastStepTime`. Update `reconcile()` to additively write `renderOffset`. |
| `packages/client/src/net/prediction.test.ts` | MODIFY | Three new tests: `step` advances `lastStepTime`; `reconcile` writes `renderOffset` on mismatch and not on match; multiple `reconcile` calls compose additively. |
| `packages/client/src/game/input.ts` | MODIFY | Replace local `STEP_INTERVAL_MS` with import from `prediction.ts`. Export `getLiveInputDir()` for the render layer. |
| `packages/client/src/game/PlayerCube.tsx` | MODIFY | Switch `useFrame(() => …)` to `useFrame((_state, delta) => …)`. In the `if (predictor)` branch, replace direct `predictedX/Z` reads with the render formula. Mirror in `useEffect` initial-position with `delta = 0`. |

**Phasing:** Phase 1 (Tasks 1–4) is predictor-only — the renderer still reads `predictedX/Z` directly, so no visible behavior changes until Phase 3. Phase 2 (Task 5) extends `input.ts`. Phase 3 (Tasks 6) wires the renderer. Phase 4 (Task 7) is manual verification with the dev server. Tests must be green at the end of every phase before starting the next.

---

## Phase 1 — Predictor changes

### Task 1: Add constants, fields, and constructor init (no behavior change)

**Files:**
- Modify: `packages/client/src/net/prediction.ts`

This task adds the constants, fields, and constructor init. Existing tests must stay green afterward — we add side-effect-free state but do not yet mutate it from `step()` or `reconcile()`.

- [ ] **Step 1: Open `packages/client/src/net/prediction.ts` and replace the file contents with:**

```ts
import { PLAYER_SPEED, SIM_DT_S } from "@mp/shared";
import type { InputMessage } from "@mp/shared";

type UnackedInput = {
  seq: number;
  dir: { x: number; z: number };
};

export type SendInput = (msg: InputMessage) => void;

/**
 * Cadence of predictor.step() calls — must equal server TICK_INTERVAL_MS
 * (50ms / 20Hz). Hoisted here from input.ts so PlayerCube's render formula
 * can clamp `tSinceStep` to a single step's worth of extrapolation.
 */
export const STEP_INTERVAL_MS = 50;

/**
 * Time constant (seconds) for exponential decay of LocalPredictor.renderOffset
 * in the render loop. 100ms ≈ 95% decay over 300ms — fast enough to feel
 * responsive, slow enough to be invisible. See AD4.
 */
export const SMOOTHING_TAU_S = 0.1;

/**
 * Owns the local player's predicted state. The network layer calls step()
 * once per 20 Hz client tick (sending the current input + advancing the
 * prediction), and calls reconcile() each time an authoritative snapshot
 * arrives for the local player. Both sides must use the same SIM_DT_S
 * (imported from @mp/shared) so per-input displacement is bit-identical
 * — see AD1 in the M2 design doc.
 *
 * The render layer reads `predictedX/Z` (authoritative simulation value)
 * plus `lastStepTime` (for inter-step extrapolation) plus `renderOffset`
 * (a decaying visual catch-up that absorbs reconciliation snaps). See
 * AD1–AD5 in 2026-05-04-local-jitter-fix-design.md.
 */
export class LocalPredictor {
  predictedX = 0;
  predictedZ = 0;
  lastReconErr = 0;

  // performance.now() at the most recent step(). Render layer extrapolates
  // (now - lastStepTime) ms of motion past predictedX/Z using live input.
  // Initialized in constructor so first paint extrapolates 0 ms, not 50.
  lastStepTime: number;

  // Visual catch-up offset, mutated additively by reconcile() and decayed
  // exponentially in the render loop. Keeping it on the predictor (not the
  // renderer) keeps the simulation/render contract in one place.
  renderOffset = { x: 0, z: 0 };

  private seq = 0;
  private unacked: UnackedInput[] = [];

  constructor() {
    this.lastStepTime = performance.now();
  }

  /**
   * Advance one prediction tick: increment seq, send the input, queue it
   * for later reconciliation, and locally apply dir * speed * dt.
   */
  step(dir: { x: number; z: number }, send: SendInput): void {
    this.seq += 1;
    const msg = { type: "input" as const, seq: this.seq, dir: { x: dir.x, z: dir.z } };
    send(msg);
    this.unacked.push({ seq: this.seq, dir: msg.dir });
    this.predictedX += dir.x * PLAYER_SPEED * SIM_DT_S;
    this.predictedZ += dir.z * PLAYER_SPEED * SIM_DT_S;
  }

  /**
   * Apply an authoritative snapshot for the local player. Drops acked
   * inputs from the queue, recomputes predicted pos by replaying any
   * remaining queued inputs onto the server position, and records the
   * magnitude of the correction in lastReconErr.
   */
  reconcile(serverX: number, serverZ: number, lastProcessedInput: number): void {
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= lastProcessedInput) {
      this.unacked.shift();
    }

    let nextX = serverX;
    let nextZ = serverZ;
    for (const u of this.unacked) {
      nextX += u.dir.x * PLAYER_SPEED * SIM_DT_S;
      nextZ += u.dir.z * PLAYER_SPEED * SIM_DT_S;
    }

    const dx = nextX - this.predictedX;
    const dz = nextZ - this.predictedZ;
    this.lastReconErr = Math.hypot(dx, dz);
    this.predictedX = nextX;
    this.predictedZ = nextZ;
  }
}
```

- [ ] **Step 2: Run client tests — confirm existing tests still pass**

Run: `pnpm --filter @mp/client test prediction`
Expected: All 6 existing tests pass. (No new tests yet.)

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/net/prediction.ts
git commit -m "feat(client): add lastStepTime + renderOffset fields to LocalPredictor

Constants (STEP_INTERVAL_MS, SMOOTHING_TAU_S) and fields (lastStepTime,
renderOffset) are added with init values but not yet mutated by step()
or reconcile(). Renderer still reads predictedX/Z directly. Behavior
unchanged.

Setup for the local-jitter-fix design (2026-05-04-local-jitter-fix-design.md)."
```

---

### Task 2: TDD — `step()` updates `lastStepTime`

**Files:**
- Modify: `packages/client/src/net/prediction.test.ts`
- Modify: `packages/client/src/net/prediction.ts:81` (inside `step()`)

- [ ] **Step 1: Add the failing test to `packages/client/src/net/prediction.test.ts`**

At the top of the file, change the import line to include `vi`:

```ts
import { describe, it, expect, vi } from "vitest";
```

Add this test inside the `describe("LocalPredictor", …)` block, after the existing `step` test:

```ts
  it("step() updates lastStepTime to the current performance.now()", () => {
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValue(1000);
    const p = new LocalPredictor();
    expect(p.lastStepTime).toBe(1000);

    nowSpy.mockReturnValue(1050);
    p.step({ x: 0, z: 0 }, () => {});
    expect(p.lastStepTime).toBe(1050);

    nowSpy.mockReturnValue(1100);
    p.step({ x: 0, z: 0 }, () => {});
    expect(p.lastStepTime).toBe(1100);

    nowSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `pnpm --filter @mp/client test prediction`
Expected: FAIL on the new test. Message similar to `expected 1000 to be 1050` (constructor sets `lastStepTime = 1000`, but `step()` doesn't update it yet).

- [ ] **Step 3: Update `step()` in `packages/client/src/net/prediction.ts`**

Replace the existing `step()` method body with:

```ts
  step(dir: { x: number; z: number }, send: SendInput): void {
    this.seq += 1;
    const msg = { type: "input" as const, seq: this.seq, dir: { x: dir.x, z: dir.z } };
    send(msg);
    this.unacked.push({ seq: this.seq, dir: msg.dir });
    this.predictedX += dir.x * PLAYER_SPEED * SIM_DT_S;
    this.predictedZ += dir.z * PLAYER_SPEED * SIM_DT_S;
    this.lastStepTime = performance.now();
  }
```

The only added line is `this.lastStepTime = performance.now();` at the end.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `pnpm --filter @mp/client test prediction`
Expected: All tests pass (7 total).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/net/prediction.ts packages/client/src/net/prediction.test.ts
git commit -m "feat(client): step() records lastStepTime for render extrapolation

Render layer will use (now - lastStepTime) to extrapolate the local
player's position between 20Hz prediction steps."
```

---

### Task 3: TDD — `reconcile()` writes `renderOffset` on mismatch

**Files:**
- Modify: `packages/client/src/net/prediction.test.ts`
- Modify: `packages/client/src/net/prediction.ts` (`reconcile()` method)

This task adds two related tests (no-error case and mismatch case) and the single line in `reconcile()` that satisfies both.

- [ ] **Step 1: Add two failing tests to `packages/client/src/net/prediction.test.ts`**

Add these two tests inside the `describe("LocalPredictor", …)` block, after the existing reconcile tests:

```ts
  it("reconcile() with no prediction error leaves renderOffset at zero", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {});
    // server confirms exactly what we predicted, ack drains the queue
    p.reconcile(PLAYER_SPEED * SIM_DT_S, 0, 1);
    expect(p.renderOffset.x).toBeCloseTo(0);
    expect(p.renderOffset.z).toBeCloseTo(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile() snap-back records compensating renderOffset", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {});
    // server says we're still at origin (input was lost / collapsed),
    // but acks our seq so the unacked queue drains
    p.reconcile(0, 0, 1);
    expect(p.predictedX).toBe(0);
    // Offset compensates for the snap-back: predictedX moved -0.25,
    // so renderOffset.x = +0.25 keeps the visible cube where it was.
    expect(p.renderOffset.x).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
    expect(p.renderOffset.z).toBeCloseTo(0);
  });
```

- [ ] **Step 2: Run the tests — confirm both fail**

Run: `pnpm --filter @mp/client test prediction`
Expected: FAIL on `snap-back records compensating renderOffset`. Message similar to `expected 0 to be close to 0.25`. The no-error test happens to pass already because `renderOffset` is initialized to zero and never mutated, but it's still load-bearing — it will catch a future bug where `reconcile()` mistakenly writes a nonzero offset on the no-error path.

- [ ] **Step 3: Update `reconcile()` in `packages/client/src/net/prediction.ts`**

Replace the existing `reconcile()` method body with:

```ts
  reconcile(serverX: number, serverZ: number, lastProcessedInput: number): void {
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= lastProcessedInput) {
      this.unacked.shift();
    }

    let nextX = serverX;
    let nextZ = serverZ;
    for (const u of this.unacked) {
      nextX += u.dir.x * PLAYER_SPEED * SIM_DT_S;
      nextZ += u.dir.z * PLAYER_SPEED * SIM_DT_S;
    }

    const prevX = this.predictedX;
    const prevZ = this.predictedZ;
    const dx = nextX - prevX;
    const dz = nextZ - prevZ;
    this.lastReconErr = Math.hypot(dx, dz);
    this.predictedX = nextX;
    this.predictedZ = nextZ;

    // Visual catch-up: keep the rendered cube where it WAS, then let the
    // render layer's exponential decay walk the offset toward zero. See
    // AD4 in 2026-05-04-local-jitter-fix-design.md.
    this.renderOffset.x += prevX - nextX;
    this.renderOffset.z += prevZ - nextZ;
  }
```

The added lines: `prevX/prevZ` capture, and the two `renderOffset` accumulations at the end. The `dx/dz/lastReconErr` math is unchanged in meaning — just rewritten to reuse `prevX/prevZ`.

- [ ] **Step 4: Run all client tests — confirm they all pass**

Run: `pnpm --filter @mp/client test prediction`
Expected: All tests pass (9 total — the 6 originals plus 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/net/prediction.ts packages/client/src/net/prediction.test.ts
git commit -m "feat(client): reconcile() additively writes renderOffset on snap

Captures prev predicted position before mutation; offset = prev - new.
Render layer will exponentially decay this offset toward zero, so
reconciliation snaps become smooth visual catch-ups instead of jumps."
```

---

### Task 4: TDD — `renderOffset` composes additively across reconciliations (AD4 regression)

**Files:**
- Modify: `packages/client/src/net/prediction.test.ts`

This is purely a regression test for AD4: if a future change accidentally switches `+=` to `=`, this catches it.

- [ ] **Step 1: Add the failing test to `packages/client/src/net/prediction.test.ts`**

Add this test inside the `describe("LocalPredictor", …)` block, after the snap-back test:

```ts
  it("renderOffset accumulates additively across multiple reconciliations", () => {
    const p = new LocalPredictor();
    const oneStep = PLAYER_SPEED * SIM_DT_S;

    p.step({ x: 1, z: 0 }, () => {});
    p.reconcile(0, 0, 1);
    expect(p.renderOffset.x).toBeCloseTo(oneStep);

    // After the first reconcile predictedX is 0. Step again and snap again.
    p.step({ x: 1, z: 0 }, () => {});
    p.reconcile(0, 0, 2);
    // Each reconcile contributes +oneStep; total should be 2 * oneStep,
    // NOT oneStep (which would mean the second reconcile overwrote the
    // first instead of adding to it).
    expect(p.renderOffset.x).toBeCloseTo(2 * oneStep);
  });
```

- [ ] **Step 2: Run the test — confirm it passes**

Run: `pnpm --filter @mp/client test prediction`
Expected: All tests pass (10 total). The test passes immediately because Task 3 already implemented `+=`. This test exists to catch future regressions.

- [ ] **Step 3: Run typecheck and full client test suite**

Run: `pnpm typecheck && pnpm --filter @mp/client test`
Expected: No type errors. All client tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/net/prediction.test.ts
git commit -m "test(client): regression test for renderOffset additive composition

Catches the obvious refactor bug where += becomes =. Two snaps in
succession must produce 2*correction, not the most-recent correction."
```

---

## Phase 2 — input.ts: hoisted constant + live-input accessor

### Task 5: Hoist `STEP_INTERVAL_MS` and export `getLiveInputDir()`

**Files:**
- Modify: `packages/client/src/game/input.ts`

`STEP_INTERVAL_MS` is now declared in `prediction.ts` (Task 1). This task switches `input.ts` to import it instead of declaring its own copy, and adds a `getLiveInputDir()` accessor for the render layer.

- [ ] **Step 1: Replace `packages/client/src/game/input.ts` with:**

```ts
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { LocalPredictor, STEP_INTERVAL_MS } from "../net/prediction.js";

const KEYS = { w: false, a: false, s: false, d: false };

const CODE_TO_KEY: Record<string, "w" | "a" | "s" | "d"> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
};

function computeDir(): { x: number; z: number } {
  let x = 0, z = 0;
  if (KEYS.w) z -= 1;
  if (KEYS.s) z += 1;
  if (KEYS.a) x -= 1;
  if (KEYS.d) x += 1;
  const len = Math.hypot(x, z);
  if (len > 0) { x /= len; z /= len; }
  return { x, z };
}

/**
 * Read the current keyboard direction without sending an input message or
 * advancing the predictor. Used by the render layer to extrapolate the
 * local player's visible position between 20Hz prediction steps using
 * the freshest possible input — see AD2 in
 * 2026-05-04-local-jitter-fix-design.md.
 *
 * Allocates a fresh object per call (60 small allocations/sec at 60fps;
 * negligible). Don't store the returned reference; treat as read-once.
 */
export function getLiveInputDir(): { x: number; z: number } {
  return computeDir();
}

/**
 * Owns keyboard listeners and a 20 Hz step loop that drives the predictor
 * and sends one input message per step. Caller is responsible for
 * disposing via the returned function on unmount.
 */
export function attachInput(room: Room<RoomState>, predictor: LocalPredictor): () => void {
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === down) return;
    KEYS[k] = down;
  };

  const downHandler = onKey(true);
  const upHandler = onKey(false);
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);

  const send = (msg: { type: "input"; seq: number; dir: { x: number; z: number } }) => {
    room.send("input", msg);
  };

  const stepTimer = window.setInterval(() => {
    predictor.step(computeDir(), send);
  }, STEP_INTERVAL_MS);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.clearInterval(stepTimer);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
  };
}
```

Changes from the previous file:
- Import line at top now also imports `STEP_INTERVAL_MS` from prediction.ts.
- Removed the local `const STEP_INTERVAL_MS = 50;` declaration and its comment.
- Added `getLiveInputDir()` export.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors. (No tests cover input.ts directly; the typecheck is the gate here.)

- [ ] **Step 3: Run full client test suite — confirm nothing regressed**

Run: `pnpm --filter @mp/client test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/input.ts
git commit -m "feat(client): hoist STEP_INTERVAL_MS to prediction.ts; export getLiveInputDir

Render layer needs both: STEP_INTERVAL_MS to clamp inter-step
extrapolation, and getLiveInputDir() to extrapolate using the freshest
keyboard state (not the last-sent input — see AD2)."
```

---

## Phase 3 — Renderer: extrapolation + offset

### Task 6: Apply the render formula in `PlayerCube.tsx`

**Files:**
- Modify: `packages/client/src/game/PlayerCube.tsx`

This is the only render-layer change. After this task, the local cube is no longer driven by direct `predictedX/Z` reads — it's `predictedX + extrapolation + decayedOffset`.

- [ ] **Step 1: Replace `packages/client/src/game/PlayerCube.tsx` with:**

```tsx
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import { PLAYER_SPEED } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import {
  STEP_INTERVAL_MS,
  SMOOTHING_TAU_S,
  type LocalPredictor,
} from "../net/prediction.js";
import { getLiveInputDir } from "./input.js";

const STEP_INTERVAL_S = STEP_INTERVAL_MS / 1000;
const RENDER_Y = 0.5;

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export type PlayerCubeProps = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
  predictor?: LocalPredictor; // present iff this is the local player
};

/**
 * Compute the visible position for the local player from authoritative
 * predicted state plus two render-only contributions:
 *  1. Live-input extrapolation: predictedX/Z is updated only every
 *     STEP_INTERVAL_MS (20Hz), but render runs at ~60Hz. Between steps,
 *     extrapolate using the *current* keyboard direction (not the last
 *     sent input — see AD2) so key release stops the cube immediately.
 *     Clamped to one step's worth (AD3) so a stalled main thread can't
 *     catapult the cube.
 *  2. Decaying renderOffset: each reconcile() snap is captured as a
 *     compensating offset (AD4), then exponentially decayed here so the
 *     visible cube smoothly catches up to authoritative truth.
 */
function localPlayerRenderPos(
  predictor: LocalPredictor,
  delta: number,
): { x: number; z: number } {
  const decay = Math.exp(-delta / SMOOTHING_TAU_S);
  predictor.renderOffset.x *= decay;
  predictor.renderOffset.z *= decay;

  const tSinceStep = Math.min(
    (performance.now() - predictor.lastStepTime) / 1000,
    STEP_INTERVAL_S,
  );
  const liveDir = getLiveInputDir();

  return {
    x: predictor.predictedX + liveDir.x * PLAYER_SPEED * tSinceStep + predictor.renderOffset.x,
    z: predictor.predictedZ + liveDir.z * PLAYER_SPEED * tSinceStep + predictor.renderOffset.z,
  };
}

export function PlayerCube({ sessionId, buffer, predictor }: PlayerCubeProps) {
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => colorFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!ref.current) return;
    if (predictor) {
      // First paint: delta=0 makes decay a no-op, and renderOffset is 0
      // post-construction, so position is exactly predictedX/Z.
      const pos = localPlayerRenderPos(predictor, 0);
      ref.current.position.set(pos.x, RENDER_Y, pos.z);
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
    if (sample) ref.current.position.set(sample.x, RENDER_Y, sample.z);
  }, [buffer, predictor]);

  useFrame((_state, delta) => {
    if (!ref.current) return;
    if (predictor) {
      const pos = localPlayerRenderPos(predictor, delta);
      ref.current.position.x = pos.x;
      ref.current.position.z = pos.z;
      ref.current.position.y = RENDER_Y;
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
    if (!sample) return;
    ref.current.position.x = sample.x;
    ref.current.position.z = sample.z;
    ref.current.position.y = RENDER_Y;
  });

  return (
    <mesh ref={ref} castShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
```

Changes summary (vs. the previous file):
- New imports: `PLAYER_SPEED` from `@mp/shared`, `STEP_INTERVAL_MS` and `SMOOTHING_TAU_S` from `prediction.js`, `getLiveInputDir` from `./input.js`.
- New module-local constants: `STEP_INTERVAL_S` and `RENDER_Y` (the latter just deduplicates the literal `0.5` previously written four times).
- New private helper `localPlayerRenderPos()` containing the formula.
- `useFrame` signature changed from `() => {…}` to `(_state, delta) => {…}`.
- Local-player branches in `useEffect` and `useFrame` call the helper instead of reading `predictor.predictedX/Z` directly.
- Remote-player branches (the `buffer.sample(…)` paths) are functionally unchanged; only the inline `0.5` got replaced with `RENDER_Y`.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Run full client test suite**

Run: `pnpm --filter @mp/client test`
Expected: All tests pass. PlayerCube has no unit tests (render layer); the gate is typecheck plus the next phase's manual verification.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/PlayerCube.tsx
git commit -m "feat(client): render local player with extrapolation + decayed offset

useFrame now reads predictor.predictedX/Z and adds two render-only
contributions: live-input extrapolation (smooths the 20Hz->60Hz
stair-step) and exponentially-decayed renderOffset (smooths the
reconciliation snap-back on input collapse). Remote players unchanged.

Implements 2026-05-04-local-jitter-fix-design.md."
```

---

## Phase 4 — Manual verification

### Task 7: Boot dev server, verify smoothness + HUD

**Files:** none

The unit tests gate the simulation-layer math but can't gate the visual outcome. This task is the manual smoke test against a running session.

- [ ] **Step 1: Boot the dev server**

Run: `pnpm dev`
Expected: Server logs a join code; Vite dev server URL prints (typically `http://localhost:5173`).

- [ ] **Step 2: Open the URL in two separate browser tabs**

In tab 1: create a room (the landing page should give a "Create" option), and copy the join code from the banner. In tab 2: open the same URL and use the join code to enter the same room. You should see two cubes.

- [ ] **Step 3: Press F3 in tab 1 to enable the debug HUD**

Expected: HUD appears in the corner showing ping, server tick, snapshots/sec, recon error, fps, etc.

- [ ] **Step 4: Move tab 1's cube with WASD; observe the LOCAL cube (your own)**

Expected:
- Movement is smooth at 60fps. No visible 20Hz stair-step. (Compare to the remote cube in tab 2 — they should look equally smooth.)
- On rapid direction changes (e.g. press W then immediately A), the cube does not visibly snap; any reconciliation correction is absorbed within ~200-300ms by the decaying offset.
- Key release stops the cube immediately, with no perceptible glide.

- [ ] **Step 5: Watch the HUD's `recon err` line during direction changes**

Expected: Same behavior as before — steady-state 0, occasional spikes to 0.2–0.5 on direction changes, returns to 0. The HUD reports raw simulation error, not visible error; the spikes themselves are unchanged. The point is they are no longer visually perceptible.

- [ ] **Step 6: Switch to tab 2 and confirm the remote cube (tab 1's player) still looks smooth**

Expected: Remote interpolation path is untouched, so this should look identical to before. If anything looks different here, investigate — only the `if (predictor)` branch should have changed.

- [ ] **Step 7: Stop the dev server (Ctrl+C in the terminal)**

- [ ] **Step 8: Run final test + typecheck pass**

Run: `pnpm typecheck && pnpm test`
Expected: Everything green across all packages.

- [ ] **Step 9: Commit verification notes (if anything new was learned, e.g. needed tuning)**

If verification surfaced no issues, no commit is needed — the previous commits stand. If you tuned `SMOOTHING_TAU_S` or fixed a bug found during verification, commit those changes with a clear message tying the change to what the manual test revealed.

If verification surfaced a problem you can't fix in-scope (e.g., visible jitter persists despite the formula being correct), STOP and report rather than committing a partial fix. Possible explanations to investigate before declaring the design wrong:
- `useFrame` not firing every frame (check fps in HUD — should be ~60).
- `getLiveInputDir()` returning stale data (verify by adding a temporary `console.log` in the function).
- Reading the wrong predictor instance (verify with a `console.log` of `ref.current.uuid` and `predictor` on every frame).

---

## Self-review checklist (post-write)

- ✅ **Spec coverage:**
  - AD1 (sim layer unchanged, smoothing in render) — Task 1 leaves math intact; Task 6 owns render formula.
  - AD2 (live-input extrapolation) — Task 5 exposes `getLiveInputDir()`; Task 6 uses it.
  - AD3 (clamp `tSinceStep` to 50ms) — Task 6 formula uses `Math.min(…, STEP_INTERVAL_S)`.
  - AD4 (additive `renderOffset` + exponential decay) — Task 3 implements `+=`; Task 4 regression-tests it; Task 6 implements decay.
  - AD5 (constructor inits `lastStepTime`) — Task 1 constructor.
  - All four spec tests covered: lastStepTime test (Task 2), no-error renderOffset test (Task 3), snap-back renderOffset test (Task 3), additive composition test (Task 4).

- ✅ **Placeholders:** none — every code block is complete.

- ✅ **Type/method consistency:** `STEP_INTERVAL_MS`, `SMOOTHING_TAU_S`, `lastStepTime`, `renderOffset`, `getLiveInputDir`, `localPlayerRenderPos`, `RENDER_Y` all spelled the same in every task they appear in. `LocalPredictor` field types match between Task 1's class def and the render-side reads in Task 6.

- ✅ **Phasing safety:** Phase 1 doesn't change visible behavior (Tasks 1–4 all complete with the renderer still reading nothing new). Phase 2 is a refactor + addition that doesn't change behavior. Phase 3 lights up the change. Phase 4 is verification. Tests stay green at every phase boundary.
