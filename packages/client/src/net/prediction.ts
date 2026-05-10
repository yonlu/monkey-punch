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
 * AD1–AD6 in 2026-05-04-local-jitter-fix-design.md.
 */
export class LocalPredictor {
  predictedX = 0;
  predictedZ = 0;
  lastReconErr = 0;

  // Render-smoothed local-player position, written by PlayerCube each
  // frame after applying the live-input extrapolation + renderOffset
  // decay (see localPlayerRenderPos in PlayerCube.tsx). Other render-
  // time consumers (OrbitSwarm, hit-flash anchoring, etc.) should read
  // these instead of predictedX/Z when they want a 60 fps-smooth attach
  // point — predictedX/Z only updates at the 20 Hz step() cadence.
  // Initialized to 0 so the very first OrbitSwarm frame, before
  // PlayerCube's first useFrame, sees the same value predictedX/Z had.
  renderX = 0;
  renderZ = 0;

  // performance.now() at the most recent step(). Render layer extrapolates
  // (now - lastStepTime) ms of motion past predictedX/Z using live input.
  // Initialized in constructor so first paint extrapolates 0 ms, not 50.
  lastStepTime: number;

  // Visual catch-up offset, mutated additively by reconcile() and decayed
  // exponentially in the render loop. Keeping it on the predictor (not the
  // renderer) keeps the simulation/render contract in one place.
  renderOffset = { x: 0, z: 0 };

  // Last liveDir read by the render layer. Used to detect input-direction
  // changes between render frames and absorb the resulting extrapolation
  // jump into renderOffset (same AD4 pattern used for reconcile snaps).
  // NaN sentinel = first frame; no prior liveDir to diff against.
  lastLiveDirX = NaN;
  lastLiveDirZ = NaN;

  private seq = 0;
  private unacked: UnackedInput[] = [];

  constructor() {
    this.lastStepTime = performance.now();
  }

  /**
   * Advance one prediction tick: increment seq, send the input, queue it
   * for later reconciliation, and locally apply dir * speed * dt.
   */
  step(dir: { x: number; z: number }, jump: boolean, send: SendInput): void {
    this.seq += 1;
    const msg = {
      type: "input" as const,
      seq: this.seq,
      dir: { x: dir.x, z: dir.z },
      jump,
    };
    send(msg);
    this.unacked.push({ seq: this.seq, dir: msg.dir });
    this.predictedX += dir.x * PLAYER_SPEED * SIM_DT_S;
    this.predictedZ += dir.z * PLAYER_SPEED * SIM_DT_S;
    this.lastStepTime = performance.now();
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
}
