// Mutable singleton read by DebugHud each requestAnimationFrame, mutated in
// place by the network/prediction code. Avoids React state churn on the
// hot loop. Treat this as a debugging surface, not an API.

export type HudState = {
  pingMs: number;
  serverTick: number;
  snapshotsPerSec: number;
  interpDelayMs: number;
  playerCount: number;
  reconErr: number;
  fps: number;                 // smoothed render fps (DebugHud rAF tick)
  enemyCount: number;          // active enemies
  enemyDrawCalls: number;      // gl.info.render.calls — proxy for "instancing working"
  lastSnapshotBytes: number;   // best-effort client-side; authoritative number is in server log
  visible: boolean;
};

export const hudState: HudState = {
  pingMs: 0,
  serverTick: 0,
  snapshotsPerSec: 0,
  interpDelayMs: 100,
  playerCount: 0,
  reconErr: 0,
  fps: 0,
  enemyCount: 0,
  enemyDrawCalls: 0,
  lastSnapshotBytes: 0,
  visible: false,
};
