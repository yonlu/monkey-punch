import { describe, it, expect, vi, beforeAll } from "vitest";
import { LocalPredictor, type ServerSnapshotState } from "./prediction.js";
import {
  GRAVITY,
  JUMP_VELOCITY,
  PLAYER_GROUND_OFFSET,
  PLAYER_SPEED,
  SIM_DT_S,
  TICK_RATE,
  initTerrain,
  terrainHeight,
} from "@mp/shared";

// terrainHeight throws until initTerrain is called. The predictor's
// applyTick now queries terrain on every step, so init once for all tests.
beforeAll(() => {
  initTerrain(0);
});

const groundedSnap = (x = 0, z = 0): ServerSnapshotState => ({
  x,
  y: terrainHeight(x, z) + PLAYER_GROUND_OFFSET,
  z,
  vy: 0,
  grounded: true,
  lastGroundedAt: 0,
  jumpBufferedAt: -1,
});

describe("LocalPredictor", () => {
  it("starts at origin grounded with seq=0", () => {
    const p = new LocalPredictor();
    expect(p.predictedX).toBe(0);
    expect(p.predictedZ).toBe(0);
    expect(p.predictedY).toBe(0);
    expect(p.predictedVY).toBe(0);
    expect(p.predictedGrounded).toBe(true);
    expect(p.predictedJumpBufferedAt).toBe(-1);
    expect(p.predictedTick).toBe(0);
    expect(p.lastReconErr).toBe(0);
  });

  it("step advances X by dir * speed * dt and queues input", () => {
    const p = new LocalPredictor();
    const sent: Array<{ seq: number; dir: { x: number; z: number }; jump: boolean }> = [];
    p.step({ x: 1, z: 0 }, false, (msg) => sent.push({ seq: msg.seq, dir: msg.dir, jump: msg.jump }));
    expect(p.predictedX).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
    expect(p.predictedZ).toBe(0);
    // Origin sits in the spawn-flat radius — terrainHeight ≈ 0, so phase 2
    // ground-snap immediately puts us back on terrain with vy=0.
    expect(p.predictedGrounded).toBe(true);
    expect(p.predictedVY).toBe(0);
    expect(p.predictedTick).toBe(1);
    expect(sent).toEqual([{ seq: 1, dir: { x: 1, z: 0 }, jump: false }]);
  });

  it("step() updates lastStepTime to the current performance.now()", () => {
    const nowSpy = vi.spyOn(performance, "now");
    try {
      nowSpy.mockReturnValue(1000);
      const p = new LocalPredictor();
      expect(p.lastStepTime).toBe(1000);

      nowSpy.mockReturnValue(1050);
      p.step({ x: 0, z: 0 }, false, () => {});
      expect(p.lastStepTime).toBe(1050);

      nowSpy.mockReturnValue(1100);
      p.step({ x: 0, z: 0 }, false, () => {});
      expect(p.lastStepTime).toBe(1100);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reconcile against acked seq drops queue and snaps to authoritative X", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    p.step({ x: 1, z: 0 }, false, () => {});
    p.step({ x: 1, z: 0 }, false, () => {});

    const expected = 3 * PLAYER_SPEED * SIM_DT_S;
    p.reconcile(groundedSnap(expected, 0), 3, 3);

    expect(p.predictedX).toBeCloseTo(expected);
    expect(p.predictedZ).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile re-applies unacked inputs after authoritative snapshot", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 2
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 3 — server has not yet processed

    const ackedX = 2 * PLAYER_SPEED * SIM_DT_S;
    p.reconcile(groundedSnap(ackedX, 0), 2, 2);

    expect(p.predictedX).toBeCloseTo(3 * PLAYER_SPEED * SIM_DT_S);
  });

  it("reconcile records the magnitude of the correction in lastReconErr", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    // server says we're still at origin (input was lost / collapsed).
    p.reconcile(groundedSnap(0, 0), 1, 1);
    expect(p.predictedX).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
  });

  it("ignores stale acks (lastProcessedInput < latest queued)", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 2

    p.reconcile(groundedSnap(PLAYER_SPEED * SIM_DT_S, 0), 1, 1);

    expect(p.predictedX).toBeCloseTo(2 * PLAYER_SPEED * SIM_DT_S);
  });

  it("reconcile() with no prediction error leaves renderOffset at zero", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    // server confirms exactly what we predicted.
    p.reconcile(groundedSnap(PLAYER_SPEED * SIM_DT_S, 0), 1, 1);
    expect(p.renderOffset.x).toBeCloseTo(0);
    expect(p.renderOffset.y).toBeCloseTo(0);
    expect(p.renderOffset.z).toBeCloseTo(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile() snap-back records compensating renderOffset", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    p.reconcile(groundedSnap(0, 0), 1, 1);
    expect(p.predictedX).toBe(0);
    expect(p.renderOffset.x).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
    expect(p.renderOffset.z).toBeCloseTo(0);
  });

  it("renderOffset accumulates additively across multiple reconciliations", () => {
    const p = new LocalPredictor();
    const oneStep = PLAYER_SPEED * SIM_DT_S;

    p.step({ x: 1, z: 0 }, false, () => {});
    p.reconcile(groundedSnap(0, 0), 1, 1);
    expect(p.renderOffset.x).toBeCloseTo(oneStep);

    p.step({ x: 1, z: 0 }, false, () => {});
    p.reconcile(groundedSnap(0, 0), 2, 2);
    expect(p.renderOffset.x).toBeCloseTo(2 * oneStep);
  });
});

describe("LocalPredictor — vertical physics (US-011)", () => {
  it("step with jump=true while grounded sets vy=JUMP_VELOCITY and grounded=false", () => {
    const p = new LocalPredictor();
    p.step({ x: 0, z: 0 }, true, () => {});
    // Phase 1 fires (grounded=true) → vy=JUMP_VELOCITY pre-gravity. Phase 2
    // applies gravity once and integrates Y. Phase 2's snap re-grounds only
    // if the integrated Y dipped to/below terrain — at apex of the very
    // first tick that's not the case (vy is still positive after gravity).
    expect(p.predictedVY).toBeCloseTo(JUMP_VELOCITY - GRAVITY * SIM_DT_S);
    expect(p.predictedGrounded).toBe(false);
    expect(p.predictedY).toBeGreaterThan(0);
  });

  it("step with jump=true while airborne (out of coyote) buffers the press", () => {
    const p = new LocalPredictor();
    // Inject "airborne, way out of coyote, falling" via reconcile so we
    // don't have to rely on the trajectory math. tick=110, lastGroundedAt=
    // 100 → 0.5s elapsed, well past COYOTE_TIME (0.1s). Y high enough that
    // gravity from this state cannot snap-land in one tick.
    p.reconcile(
      {
        x: 0,
        y: 5,
        z: 0,
        vy: -3,
        grounded: false,
        lastGroundedAt: 100,
        jumpBufferedAt: -1,
      },
      0,
      110,
    );

    // Press jump — out of coyote → must buffer, must NOT relaunch.
    const vyBefore = p.predictedVY;
    p.step({ x: 0, z: 0 }, true, () => {});
    expect(p.predictedJumpBufferedAt).toBe(p.predictedTick);
    // vy after this step is just one gravity tick from the pre-step value
    // (phase 1 took the buffer branch, did not touch vy).
    expect(p.predictedVY).toBeCloseTo(vyBefore - GRAVITY * SIM_DT_S);
    // Crucially: vy was NOT reset to JUMP_VELOCITY (would mean the jump
    // had fired despite being out of coyote).
    expect(p.predictedVY).not.toBe(JUMP_VELOCITY);
  });

  it("buffered jump fires automatically on landing if within JUMP_BUFFER", () => {
    const p = new LocalPredictor();
    // Inject "airborne, just about to land, out of coyote, no buffer".
    // y=0.05, vy=-2 — next tick gravity makes vy=-3.25, y=0.05-0.1625=
    // -0.1125 → snaps to ground. lastGroundedAt=100, tick=200 → far past
    // coyote.
    p.reconcile(
      {
        x: 0,
        y: 0.05,
        z: 0,
        vy: -2,
        grounded: false,
        lastGroundedAt: 100,
        jumpBufferedAt: -1,
      },
      0,
      200,
    );

    // Press jump on the next step — out of coyote, so the press buffers
    // at tick 201. Phase 2 then snaps us to ground (vy was negative
    // enough to dip below terrain after one gravity tick). Phase 3
    // anchors lastGroundedAt=201. Phase 4 sees jumpBufferedAt=201 ==
    // tick → 0 elapsed ≤ JUMP_BUFFER, canJump=true (just-grounded) →
    // fires the jump in the SAME tick.
    p.step({ x: 0, z: 0 }, true, () => {});
    expect(p.predictedJumpBufferedAt).toBe(-1);
    expect(p.predictedVY).toBeCloseTo(JUMP_VELOCITY);
    expect(p.predictedGrounded).toBe(false);
  });

  it("reconcile snaps Y/vy/grounded to server and replays unacked inputs", () => {
    const p = new LocalPredictor();
    // Local prediction: take off, then send 2 more inputs the server
    // hasn't yet acked.
    p.step({ x: 0, z: 0 }, true, () => {});  // seq 1
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 2
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 3

    const yBeforeReconcile = p.predictedY;

    // Server's view: ack only seq 1 (so seq 2 and 3 are unacked). Server
    // says it's at predictedY after one jump tick — same as the predictor.
    // Replay applies seq 2 and 3, mirroring the original step path.
    const t0Y = JUMP_VELOCITY * SIM_DT_S - 0.5 * GRAVITY * SIM_DT_S * SIM_DT_S;
    // Use semi-implicit (matches applyTick): vy_after = JUMP_VELOCITY -
    // GRAVITY*dt; y_after = 0 + vy_after * dt.
    const yAfterTick1 = (JUMP_VELOCITY - GRAVITY * SIM_DT_S) * SIM_DT_S;
    void t0Y;
    p.reconcile(
      {
        x: 0,
        y: yAfterTick1,
        z: 0,
        vy: JUMP_VELOCITY - GRAVITY * SIM_DT_S,
        grounded: false,
        lastGroundedAt: 0,
        jumpBufferedAt: -1,
      },
      1,
      1,
    );

    // After replay of seq 2 + 3, predictedY should match what the
    // original local sim produced (zero divergence path).
    expect(p.predictedY).toBeCloseTo(yBeforeReconcile, 5);
    expect(p.lastReconErr).toBeCloseTo(0, 5);
  });

  it("reconcile re-anchors predictedTick to serverTick + unacked count", () => {
    const p = new LocalPredictor();
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 1, predictedTick = 1
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 2, predictedTick = 2

    // Server is far ahead — jumped to tick 100 with seq 1 acked.
    p.reconcile(groundedSnap(0, 0), 1, 100);
    // After replay of seq 2, predictedTick should be 101 (server tick + 1).
    expect(p.predictedTick).toBe(101);
  });

  it("perfect-server reconcile during airborne flight produces zero correction", () => {
    const p = new LocalPredictor();
    // Take off and accumulate some unacked inputs.
    p.step({ x: 0, z: 0 }, true, () => {});  // seq 1
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 2
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 3
    p.step({ x: 0, z: 0 }, false, () => {}); // seq 4

    const xBefore = p.predictedX;
    const yBefore = p.predictedY;
    const zBefore = p.predictedZ;
    const vyBefore = p.predictedVY;
    const groundedBefore = p.predictedGrounded;

    // Reconcile with the same state we'd have produced after seq 1: the
    // predictor must replay seq 2..4 and arrive at the same state again.
    const yAfterT1 = (JUMP_VELOCITY - GRAVITY * SIM_DT_S) * SIM_DT_S;
    p.reconcile(
      {
        x: 0,
        y: yAfterT1,
        z: 0,
        vy: JUMP_VELOCITY - GRAVITY * SIM_DT_S,
        grounded: false,
        lastGroundedAt: 0,
        jumpBufferedAt: -1,
      },
      1,
      1,
    );

    expect(p.predictedX).toBeCloseTo(xBefore, 5);
    expect(p.predictedY).toBeCloseTo(yBefore, 5);
    expect(p.predictedZ).toBeCloseTo(zBefore, 5);
    expect(p.predictedVY).toBeCloseTo(vyBefore, 5);
    expect(p.predictedGrounded).toBe(groundedBefore);
    expect(p.lastReconErr).toBeCloseTo(0, 5);
    // The renderOffset Y/X/Z should also be near zero — no visible jump.
    expect(p.renderOffset.x).toBeCloseTo(0, 5);
    expect(p.renderOffset.y).toBeCloseTo(0, 5);
    expect(p.renderOffset.z).toBeCloseTo(0, 5);
  });

  it("coyote jump succeeds: walk off ledge tick, jump 1 tick later", () => {
    const p = new LocalPredictor();
    // Start airborne (just walked off): manually craft this state via
    // reconcile to a "just walked off" snapshot.
    p.reconcile(
      {
        x: 0,
        y: 5, // well above terrain at origin (terrainHeight(0,0) ≈ 0)
        z: 0,
        vy: 0,
        grounded: false,
        lastGroundedAt: 50,
        jumpBufferedAt: -1,
      },
      0,
      50,
    );
    // Jump 1 tick later — well within COYOTE_TIME (0.1s ≈ 2 ticks).
    p.step({ x: 0, z: 0 }, true, () => {});
    expect(p.predictedTick).toBe(51);
    // Phase 1 should have launched: vy starts at JUMP_VELOCITY, then
    // phase 2 applies gravity for one tick.
    expect(p.predictedVY).toBeCloseTo(JUMP_VELOCITY - GRAVITY * SIM_DT_S);
  });

  it("coyote jump fails after window: walk off ledge, jump > COYOTE_TIME later", () => {
    const p = new LocalPredictor();
    p.reconcile(
      {
        x: 0,
        y: 5,
        z: 0,
        vy: 0,
        grounded: false,
        lastGroundedAt: 50,
        jumpBufferedAt: -1,
      },
      0,
      50,
    );
    // Tick forward past coyote window (0.1s = 2 ticks) — but we need to
    // be careful that gravity doesn't snap us back to ground in those
    // ticks. The reconcile placed Y=5 with vy=0; gravity drops vy to
    // -GRAVITY*dt per tick. After 5 ticks, Y ≈ 5 + sum_{i=1..5}(-GRAVITY *
    // SIM_DT_S * i * SIM_DT_S) = 5 - 0.5 * 25 * 0.05 * 0.05 * 5 * 6 ≈
    // 4.81. Still above ground. Good.
    for (let i = 0; i < 5; i++) p.step({ x: 0, z: 0 }, false, () => {});

    // predictedTick = 55, lastGroundedAt = 50 → 5 ticks elapsed = 0.25s
    // > COYOTE_TIME = 0.1s. Jump intent is now out of coyote.
    expect(p.predictedTick).toBe(55);

    p.step({ x: 0, z: 0 }, true, () => {});
    // Should have buffered, not fired.
    expect(p.predictedJumpBufferedAt).toBe(56);
    // VY should be falling (gravity), not reset to JUMP_VELOCITY.
    expect(p.predictedVY).toBeLessThan(0);
  });

  it("predictedTick increments by 1 per step from initial 0", () => {
    const p = new LocalPredictor();
    expect(p.predictedTick).toBe(0);
    for (let i = 1; i <= 7; i++) {
      p.step({ x: 0, z: 0 }, false, () => {});
      expect(p.predictedTick).toBe(i);
    }
  });

  it("constants used by this predictor are still the values we expect", () => {
    // Sentinel: if these constants drift, every test in this suite needs
    // a fresh look. Asserting them explicitly here makes the dependency
    // visible in PR diffs.
    expect(GRAVITY).toBe(25);
    expect(JUMP_VELOCITY).toBe(9);
    expect(TICK_RATE).toBe(20);
    expect(SIM_DT_S).toBeCloseTo(0.05);
  });
});
