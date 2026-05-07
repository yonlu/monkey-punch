import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Raycaster, Vector2, Vector3, Plane, type PerspectiveCamera } from "three";
import { LocalPredictor, STEP_INTERVAL_MS } from "../net/prediction.js";

const KEYS = { w: false, a: false, s: false, d: false };

const CODE_TO_KEY: Record<string, "w" | "a" | "s" | "d"> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
};

// Mouse NDC, updated by a window mousemove listener.
let mouseNdcX = 0;
let mouseNdcY = 0;
let mouseEverMoved = false;

// Re-used to avoid per-frame allocations.
const _ray = new Raycaster();
const _ndc = new Vector2();
const _hit = new Vector3();
const _plane = new Plane(new Vector3(0, 1, 0), 0);   // y=0 ground plane

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

export function getLiveInputDir(): { x: number; z: number } {
  return computeDir();
}

/**
 * Compute facing as a unit vector from `(playerX, playerZ)` toward the
 * mouse-raycast point on the y=0 plane. Returns `(0, 1)` if the mouse
 * has never moved or the ray fails to intersect.
 */
export function getLiveFacing(
  camera: PerspectiveCamera,
  playerX: number,
  playerZ: number,
): { x: number; z: number } {
  if (!mouseEverMoved) return { x: 0, z: 1 };
  _ndc.set(mouseNdcX, mouseNdcY);
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return { x: 0, z: 1 };
  const dx = _hit.x - playerX;
  const dz = _hit.z - playerZ;
  const len = Math.hypot(dx, dz);
  if (len === 0) return { x: 0, z: 1 };
  return { x: dx / len, z: dz / len };
}

/**
 * Most-recent mouse-raycast ground point, or null if the mouse has never
 * moved. Used by Crosshair to position the in-world reticle.
 */
export function getLiveCrosshairPoint(camera: PerspectiveCamera): { x: number; z: number } | null {
  if (!mouseEverMoved) return null;
  _ndc.set(mouseNdcX, mouseNdcY);
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
  return { x: _hit.x, z: _hit.z };
}

export function attachInput(
  room: Room<RoomState>,
  predictor: LocalPredictor,
  getCamera: () => PerspectiveCamera | null,
  getLocalPos: () => { x: number; z: number },
): () => void {
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === down) return;
    KEYS[k] = down;
  };
  const onMouseMove = (e: MouseEvent) => {
    mouseNdcX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseNdcY = -((e.clientY / window.innerHeight) * 2 - 1);
    mouseEverMoved = true;
  };

  const downHandler = onKey(true);
  const upHandler = onKey(false);
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);
  window.addEventListener("mousemove", onMouseMove);

  const send = (msg: {
    type: "input"; seq: number;
    dir: { x: number; z: number };
    facing: { x: number; z: number };
  }) => { room.send("input", msg); };

  const stepTimer = window.setInterval(() => {
    const cam = getCamera();
    const pos = getLocalPos();
    const facing = cam
      ? getLiveFacing(cam, pos.x, pos.z)
      : { x: 0, z: 1 };
    predictor.step(computeDir(), (msgWithoutFacing) => {
      send({ ...msgWithoutFacing, facing });
    });
  }, STEP_INTERVAL_MS);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.removeEventListener("mousemove", onMouseMove);
    window.clearInterval(stepTimer);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
    mouseEverMoved = false;
  };
}
