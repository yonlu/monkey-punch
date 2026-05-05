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
