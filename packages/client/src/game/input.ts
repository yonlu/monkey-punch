import type { Room } from "@colyseus/sdk";
import type { RoomState } from "@mp/shared";
import { LocalPredictor, STEP_INTERVAL_MS } from "../net/prediction.js";
import { getYaw } from "../camera.js";

const KEYS = { w: false, a: false, s: false, d: false };

const CODE_TO_KEY: Record<string, "w" | "a" | "s" | "d"> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
};

// M7 US-009: edge-triggered jump intent. Space key-down sets this true;
// the next predictor.step() reads + clears it so jump fires on exactly
// one input message. Holding Space does NOT auto-rejump — the keydown
// handler ignores repeats while the key is already physically down
// (browsers fire keydown repeatedly while held; we drop those).
let jumpQueued = false;
let spaceDown = false;

/**
 * Camera-space WASD vector before world-space transform: W=-Z, S=+Z,
 * A=-X, D=+X (per US-006). Diagonals are normalized so a held W+D produces
 * a unit vector, not a 1.41x boost. Returns (0,0) when no keys held.
 */
function computeCameraDir(): { x: number; z: number } {
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
 * Transform a camera-space WASD vector into world-space using the camera's
 * yaw only (NOT pitch — vertical aim must not affect movement). The
 * camera.ts yaw convention: yaw=0 places the camera behind the player at
 * +Z, looking -Z, with Forward=(-sin(yaw), -cos(yaw)) and
 * Right=(cos(yaw), -sin(yaw)) on the XZ plane (see camera.ts comment).
 *
 * Camera input convention: W=-Z (forward), D=+X (right). World output:
 *   worldDir = (-inputZ) * Forward + inputX * Right
 *
 * Expanding gives:
 *   worldX =  inputX * cos(yaw) + inputZ * sin(yaw)
 *   worldZ = -inputX * sin(yaw) + inputZ * cos(yaw)
 *
 * The PRD's literal AC formula uses the opposite sign convention for the
 * cross terms, which corresponds to a yaw definition where positive yaw
 * is clockwise (camera-forward angle from +Z). camera.ts locked in the
 * counter-clockwise convention during US-005 so this transform expresses
 * the same behavior under our yaw sign.
 */
function transformToWorld(
  cameraDir: { x: number; z: number },
  yaw: number,
): { x: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x:  cameraDir.x * c + cameraDir.z * s,
    z: -cameraDir.x * s + cameraDir.z * c,
  };
}

/**
 * Live world-space movement direction (post-yaw transform). Read by the
 * render layer for local-player extrapolation and body-facing rotation,
 * and by the input step loop for the dir field of the input message.
 */
export function getLiveInputDir(): { x: number; z: number } {
  return transformToWorld(computeCameraDir(), getYaw());
}

export function attachInput(
  room: Room<RoomState>,
  predictor: LocalPredictor,
): () => void {
  const downHandler = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      // Edge-trigger: only on the first keydown (browsers auto-repeat
      // while the key is held). spaceDown gates this.
      if (!spaceDown) {
        spaceDown = true;
        jumpQueued = true;
      }
      return;
    }
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === true) return;
    KEYS[k] = true;
  };
  const upHandler = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      spaceDown = false;
      return;
    }
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === false) return;
    KEYS[k] = false;
  };
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);

  const send = (msg: {
    type: "input"; seq: number;
    dir: { x: number; z: number };
    jump: boolean;
  }) => { room.send("input", msg); };

  const stepTimer = window.setInterval(() => {
    // Read + clear jumpQueued atomically per step so jump fires on exactly
    // one input message, even if the player tapped multiple times within a
    // 50ms window (the latest tap wins; intermediate taps that fired and
    // released before the step are lost — acceptable for a single-jump
    // mechanic).
    const jump = jumpQueued;
    jumpQueued = false;
    predictor.step(getLiveInputDir(), jump, send);
  }, STEP_INTERVAL_MS);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.clearInterval(stepTimer);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
    jumpQueued = false;
    spaceDown = false;
  };
}
