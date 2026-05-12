import {
  GRAVITY,
  JUMP_BUFFER,
  JUMP_VELOCITY,
  MAP_RADIUS,
  PLAYER_GROUND_OFFSET,
  PLAYER_SPEED,
  SIM_DT_S,
  TERMINAL_FALL_SPEED,
  TICK_RATE,
  canJump,
  terrainHeight,
} from "@mp/shared";
import type { InputMessage } from "@mp/shared";

type UnackedInput = {
  seq: number;
  dir: { x: number; z: number };
  jump: boolean;
};

export type SendInput = (msg: InputMessage) => void;

/**
 * Authoritative server state for the local player at a snapshot. Reconcile
 * resets the predictor to this and replays unacked inputs on top.
 */
export type ServerSnapshotState = {
  x: number;
  y: number;
  z: number;
  vy: number;
  grounded: boolean;
  lastGroundedAt: number;
  jumpBufferedAt: number;
};

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
 * M7 US-011: the predictor now owns the full vertical physics state
 * (`y, vy, grounded, lastGroundedAt, jumpBufferedAt`) plus a tick counter.
 * Each step mirrors `tickPlayers` in shared/rules.ts for the local player:
 * X/Z integration + boundary clamp, then the four-phase jump pipeline
 * (intent → gravity/integrate/snap → anchor lastGroundedAt → consume
 * buffered jump). The replay path inside reconcile reuses the same single-
 * tick simulation by walking the unacked queue, so a snapshot that lands
 * mid-jump produces zero correction in the common case (no rubber-band).
 *
 * The render layer reads `predictedX/Y/Z` (authoritative simulation value)
 * plus `lastStepTime` (for inter-step extrapolation of X/Z based on live
 * input direction) plus `renderOffset` (a decaying visual catch-up that
 * absorbs reconciliation snaps). See AD1–AD6 in
 * 2026-05-04-local-jitter-fix-design.md.
 */
export class LocalPredictor {
  predictedX = 0;
  predictedZ = 0;
  // Cached `speed_mult` from the most recent reconcile. Multiplies
  // PLAYER_SPEED in applyTick so Sleipnir (and any future speed_mult
  // items) takes effect in prediction — without this, picking
  // Sleipnir produces ~5–25% rubber-band per snapshot. Set externally
  // via setSpeedMult before reconcile so the replay re-applies
  // unacked inputs at the up-to-date rate. Default 1.0 (no items)
  // keeps existing predictor tests bit-identical.
  predictedSpeedMult = 1.0;
  // M7 US-011 — vertical predicted state. Mirrors Player.y/vy/grounded/
  // lastGroundedAt/jumpBufferedAt fields one-for-one. Initial values
  // match Player schema ctor (grounded=true, jumpBufferedAt=-1).
  predictedY = 0;
  predictedVY = 0;
  predictedGrounded = true;
  predictedLastGroundedAt = 0;
  predictedJumpBufferedAt = -1;
  // Predictor's simulation tick counter. Bumps by 1 per step() and is
  // re-anchored to the server's tick on each reconcile. canJump's coyote
  // arm and the buffered-jump window check both use tick differences,
  // never absolute values — so re-anchoring on reconcile is safe.
  predictedTick = 0;
  lastReconErr = 0;

  // Render-smoothed local-player position, written by PlayerCube each
  // frame after applying the live-input extrapolation + renderOffset
  // decay (see localPlayerRenderPos in PlayerCube.tsx). Other render-
  // time consumers (OrbitSwarm, CameraRig, hit-flash anchoring, etc.)
  // should read these instead of predictedX/Y/Z when they want a 60 fps-
  // smooth attach point — predictedX/Y/Z only update at the 20 Hz step()
  // cadence. Initialized to 0 so the very first OrbitSwarm/CameraRig
  // frame, before PlayerCube's first useFrame, sees the same value
  // predictedX/Y/Z had.
  renderX = 0;
  renderY = 0;
  renderZ = 0;

  // performance.now() at the most recent step(). Render layer extrapolates
  // (now - lastStepTime) ms of motion past predictedX/Z using live input.
  // Initialized in constructor so first paint extrapolates 0 ms, not 50.
  lastStepTime: number;

  // Visual catch-up offset, mutated additively by reconcile() and decayed
  // exponentially in the render loop. Y mirrors X/Z — a reconcile that
  // moves predictedY upward (e.g. server snapped to terrain that the
  // predictor thought was lower) compensates with a negative renderOffset.y
  // so the rendered cube stays put visually while it walks toward zero.
  renderOffset = { x: 0, y: 0, z: 0 };

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
   * for later reconciliation, and locally apply one server-equivalent
   * tickPlayers pass for this player.
   */
  step(dir: { x: number; z: number }, jump: boolean, send: SendInput): void {
    this.seq += 1;
    const msg: InputMessage = {
      type: "input",
      seq: this.seq,
      dir: { x: dir.x, z: dir.z },
      jump,
    };
    send(msg);
    this.unacked.push({ seq: this.seq, dir: msg.dir, jump });
    this.predictedTick += 1;
    this.applyTick(dir, jump);
    this.lastStepTime = performance.now();
  }

  /**
   * Apply an authoritative snapshot for the local player. Drops acked
   * inputs from the queue, snaps internal state to the server's
   * authoritative state at `serverTick`, then replays any remaining
   * queued inputs on top — each one bumping predictedTick by 1, since
   * those inputs will be processed by the server on serverTick+1, +2, …
   *
   * Records the magnitude of the X/Y/Z correction in lastReconErr and
   * compensates the visual position via renderOffset (AD4) so the
   * rendered cube does not visibly jump when the predictor's state is
   * adjusted.
   */
  reconcile(server: ServerSnapshotState, lastProcessedInput: number, serverTick: number): void {
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= lastProcessedInput) {
      this.unacked.shift();
    }

    const prevX = this.predictedX;
    const prevY = this.predictedY;
    const prevZ = this.predictedZ;

    this.predictedX = server.x;
    this.predictedY = server.y;
    this.predictedZ = server.z;
    this.predictedVY = server.vy;
    this.predictedGrounded = server.grounded;
    this.predictedLastGroundedAt = server.lastGroundedAt;
    this.predictedJumpBufferedAt = server.jumpBufferedAt;
    this.predictedTick = serverTick;

    for (const u of this.unacked) {
      this.predictedTick += 1;
      this.applyTick(u.dir, u.jump);
    }

    const dx = this.predictedX - prevX;
    const dy = this.predictedY - prevY;
    const dz = this.predictedZ - prevZ;
    this.lastReconErr = Math.hypot(dx, dy, dz);

    // Visual catch-up: keep the rendered cube where it WAS, then let the
    // render layer's exponential decay walk the offset toward zero. See
    // AD4 in 2026-05-04-local-jitter-fix-design.md.
    this.renderOffset.x += prevX - this.predictedX;
    this.renderOffset.y += prevY - this.predictedY;
    this.renderOffset.z += prevZ - this.predictedZ;
  }

  /**
   * Single-tick simulation. Mirrors tickPlayers in shared/rules.ts for
   * one player, line-for-line. Imports the same physics constants and
   * the same terrainHeight function the server uses, so given identical
   * (state, dir, jump) the predictor produces an identical post-tick
   * state — that is what makes the reconcile replay rubber-band-free
   * (US-011 AC).
   *
   * If tickPlayers' ordering changes (CLAUDE.md rule 11 phase ordering
   * inside the player loop), this function MUST change in lockstep.
   */
  private applyTick(dir: { x: number; z: number }, jump: boolean): void {
    this.predictedX += dir.x * PLAYER_SPEED * this.predictedSpeedMult * SIM_DT_S;
    this.predictedZ += dir.z * PLAYER_SPEED * this.predictedSpeedMult * SIM_DT_S;

    const r2 = this.predictedX * this.predictedX + this.predictedZ * this.predictedZ;
    if (r2 > MAP_RADIUS * MAP_RADIUS) {
      const scale = MAP_RADIUS / Math.sqrt(r2);
      this.predictedX *= scale;
      this.predictedZ *= scale;
    }

    // Phase 1 — direct jump intent.
    if (jump) {
      if (canJump({ grounded: this.predictedGrounded, lastGroundedAt: this.predictedLastGroundedAt }, this.predictedTick)) {
        this.predictedVY = JUMP_VELOCITY;
        this.predictedGrounded = false;
        this.predictedJumpBufferedAt = -1;
      } else {
        this.predictedJumpBufferedAt = this.predictedTick;
      }
    }

    // Phase 2 — gravity, integrate Y, ground-snap.
    this.predictedVY = Math.max(this.predictedVY - GRAVITY * SIM_DT_S, -TERMINAL_FALL_SPEED);
    this.predictedY += this.predictedVY * SIM_DT_S;
    const groundY = terrainHeight(this.predictedX, this.predictedZ) + PLAYER_GROUND_OFFSET;
    if (this.predictedY <= groundY) {
      this.predictedY = groundY;
      this.predictedVY = 0;
      this.predictedGrounded = true;
    } else {
      this.predictedGrounded = false;
    }

    // Phase 3 — anchor lastGroundedAt.
    if (this.predictedGrounded) this.predictedLastGroundedAt = this.predictedTick;

    // Phase 4 — consume buffered jump.
    if (
      this.predictedJumpBufferedAt !== -1 &&
      canJump({ grounded: this.predictedGrounded, lastGroundedAt: this.predictedLastGroundedAt }, this.predictedTick) &&
      (this.predictedTick - this.predictedJumpBufferedAt) * (1 / TICK_RATE) <= JUMP_BUFFER
    ) {
      this.predictedVY = JUMP_VELOCITY;
      this.predictedGrounded = false;
      this.predictedJumpBufferedAt = -1;
    }
  }
}
