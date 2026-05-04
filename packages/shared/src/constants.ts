// Single home for gameplay tuning knobs. Imported by rules.ts, server,
// and (selectively) client. Values that derive from others are computed
// here, not hand-coded in two places.

export const TICK_RATE = 20;                    // Hz
export const SIM_DT_S = 1 / TICK_RATE;          // 0.05 s
// Fixed simulation step. The server runs setSimulationInterval at this dt,
// and the client's LocalPredictor advances the local player at this dt
// per input. They MUST agree exactly so reapplying unacknowledged inputs
// after a snapshot reproduces the server's authoritative position — see
// AD1 in docs/superpowers/specs/2026-05-04-sync-polish-design.md.

export const PLAYER_SPEED = 5;                  // world units/sec

export const ENEMY_SPEED = 2.0;                 // world units/sec
export const ENEMY_SPAWN_INTERVAL_S = 1.0;      // seconds between spawner ticks
export const ENEMY_SPAWN_RADIUS = 30;           // world units from a player
export const MAX_ENEMIES = 300;                 // hard cap; spawner stops here
