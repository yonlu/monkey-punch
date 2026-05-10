// Mouse-orbit camera state + pointer-lock controls.
//
// Owns the live yaw/pitch the local player is steering with their mouse,
// and the pointer-lock state machine that gates whether mouse movement
// affects them at all (only while locked). CameraRig reads yaw/pitch
// each frame and rebuilds the camera transform from the orbit math
// (US-005); ClickToPlayOverlay reads the lock state to render itself
// when unlocked. Future code (US-006) will read yaw to transform
// camera-space WASD into world-space movement.
//
// All tuning constants live here so the post-camera-review checkpoint
// (US-007) and polish-tuning pass (US-017) can move numbers without
// touching component code.
//
// ── Yaw direction convention ──────────────────────────────────────────
// Yaw is the angle (radians) of the camera around the player on the
// horizontal plane. With our mouse handler `_yaw -= movementX * sensX`,
// moving the mouse to the RIGHT decreases yaw → the camera "looks more
// to the right" in world space (standard FPS feel).
//
// The camera offset from the player at yaw `y` and pitch `p` is:
//   offsetX = DIST * sin(y) * cos(p)
//   offsetY = DIST * sin(p) + LOOK_HEIGHT
//   offsetZ = DIST * cos(y) * cos(p)
//
// At yaw=0 the camera sits directly behind the player at +Z and looks
// toward -Z; increasing yaw rotates the camera position COUNTER-
// clockwise as viewed from above (camera moves through +X). The unit
// "forward" direction the camera looks along on the XZ plane is
// therefore `(-sin(yaw), -cos(yaw))` — US-006 will use this to map
// camera-space WASD into world-space movement.
// ──────────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;

export const CAMERA_DISTANCE = 9;
export const CAMERA_LOOK_HEIGHT = 1.2;
export const CAMERA_PITCH_MIN = -10 * DEG;
export const CAMERA_PITCH_MAX = 60 * DEG;
export const CAMERA_PITCH_DEFAULT = 35 * DEG;
export const MOUSE_SENSITIVITY_X = 0.0025;
export const MOUSE_SENSITIVITY_Y = 0.0020;
// Frame-rate-independent follow rate (1/seconds): per-frame factor is
// `1 - exp(-CAMERA_FOLLOW_LERP * dt)`. Higher = snappier follow.
export const CAMERA_FOLLOW_LERP = 18;

let _yaw = 0;
let _pitch = CAMERA_PITCH_DEFAULT;
let _locked = false;
const lockListeners = new Set<(locked: boolean) => void>();

export function getYaw(): number { return _yaw; }
export function getPitch(): number { return _pitch; }
export function isPointerLocked(): boolean { return _locked; }

/**
 * Subscribe to pointer-lock state changes. Listener is called with the
 * new boolean immediately after the underlying pointerlockchange /
 * pointerlockerror event fires. Returns an unsubscribe function.
 */
export function subscribeLock(fn: (locked: boolean) => void): () => void {
  lockListeners.add(fn);
  return () => { lockListeners.delete(fn); };
}

function notifyLock(): void {
  lockListeners.forEach((fn) => fn(_locked));
}

/**
 * Wire pointer-lock + mousemove handlers to the given canvas. Call once
 * after the Canvas creates its DOM element; returns a detach function
 * that removes listeners and exits any held pointer lock.
 *
 * Resets yaw/pitch to default on attach so a re-mount (e.g. reconnect)
 * starts with a clean orientation rather than carrying stale rotation
 * from a prior session.
 */
export function attachCameraControls(canvas: HTMLCanvasElement): () => void {
  _yaw = 0;
  _pitch = CAMERA_PITCH_DEFAULT;
  _locked = document.pointerLockElement === canvas;

  const onPointerLockChange = (): void => {
    _locked = document.pointerLockElement === canvas;
    notifyLock();
  };
  const onPointerLockError = (): void => {
    _locked = false;
    notifyLock();
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!_locked) return;
    _yaw -= e.movementX * MOUSE_SENSITIVITY_X;
    _pitch -= e.movementY * MOUSE_SENSITIVITY_Y;
    if (_pitch < CAMERA_PITCH_MIN) _pitch = CAMERA_PITCH_MIN;
    if (_pitch > CAMERA_PITCH_MAX) _pitch = CAMERA_PITCH_MAX;
  };

  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("pointerlockerror", onPointerLockError);
  window.addEventListener("mousemove", onMouseMove);

  return () => {
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    document.removeEventListener("pointerlockerror", onPointerLockError);
    window.removeEventListener("mousemove", onMouseMove);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    _locked = false;
    lockListeners.clear();
  };
}

/**
 * Request pointer lock on the canvas. Must be called from inside a user
 * gesture handler (click, keydown). Browsers throttle re-requests after
 * a recent unlock — failures surface as `pointerlockerror`, leaving
 * `_locked` false so the overlay stays visible and the user can retry.
 */
export function requestCameraLock(canvas: HTMLCanvasElement): void {
  canvas.requestPointerLock();
}
