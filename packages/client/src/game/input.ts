import type { Room } from "colyseus.js";
import type { InputMessage, RoomState } from "@mp/shared";

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

export function attachInput(room: Room<RoomState>): () => void {
  let last = { x: 0, z: 0 };
  let seq = 0;

  const send = () => {
    const dir = computeDir();
    if (dir.x === last.x && dir.z === last.z) return;
    last = dir;
    const msg: InputMessage = { type: "input", seq: seq++, dir };
    room.send("input", msg);
  };

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === down) return;
    KEYS[k] = down;
    send();
  };

  const downHandler = onKey(true);
  const upHandler = onKey(false);
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);

  // Heartbeat: re-send current dir periodically while non-zero, in case a packet was lost.
  const heartbeat = window.setInterval(() => {
    const dir = computeDir();
    if (dir.x === 0 && dir.z === 0) return;
    const msg: InputMessage = { type: "input", seq: seq++, dir };
    room.send("input", msg);
  }, 200);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.clearInterval(heartbeat);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
  };
}
