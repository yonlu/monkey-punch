import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { LocalPredictor } from "../net/prediction.js";

const KEYS = { w: false, a: false, s: false, d: false };

const CODE_TO_KEY: Record<string, "w" | "a" | "s" | "d"> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
};

const STEP_INTERVAL_MS = 50; // 20 Hz; must equal server TICK_INTERVAL_MS

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
