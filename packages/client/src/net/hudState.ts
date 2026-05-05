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
  // M4 additions:
  xp: number;                  // local player only (mirrored from state.players[me].xp)
  cooldownFrac: number;        // local player; 0..1 (1 = ready, 0 = just fired)
  serverTimeOffsetMs: number;  // debug
  projectileCount: number;     // active projectiles this frame (from ProjectileSwarm)
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
  xp: 0,
  cooldownFrac: 1,
  serverTimeOffsetMs: 0,
  projectileCount: 0,
  visible: false,
};
