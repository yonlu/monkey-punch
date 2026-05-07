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

// M4 — combat
export const ENEMY_HP = 30;                 // 3 Bolt hits @ 10 dmg
export const ENEMY_RADIUS = 0.5;            // matches the cone visual in EnemySwarm
export const GEM_PICKUP_RADIUS = 1.5;
export const GEM_VALUE = 1;
export const PROJECTILE_MAX_CAPACITY = 256; // server cap + client InstancedMesh capacity
export const TARGETING_MAX_RANGE = 20;

// M5 — XP / level-up
/**
 * XP required to advance from `level` to `level + 1`.
 * Canonical formula: level*5 + level² → 6, 14, 24, 36, 50, ...
 * Tests assert monotonicity, not specific values, so retuning is free.
 */
export function xpForLevel(level: number): number {
  return level * 5 + level * level;
}

/** 10 seconds at 20Hz = 200 ticks. The window before auto-pick fires. */
export const LEVEL_UP_DEADLINE_TICKS = 10 * TICK_RATE;

// M5 — orbit rendering
/**
 * Upper bound on simultaneous orbs across all weapon levels in WEAPON_KINDS.
 * Sets the InstancedMesh capacity on the client and is asserted at module
 * load (see the bare module-load block in `shared/index.ts`). Bumping
 * this is safe; lowering it past the actual data trips the assertion at
 * import time.
 */
export const MAX_ORB_COUNT_EVER = 6;

// M6 — playability pass
export const MAP_RADIUS = 60;                  // world units
export const PLAYER_RADIUS = 0.5;              // matches cube half-extent
export const PLAYER_MAX_HP = 100;
export const ENEMY_CONTACT_DAMAGE = 5;         // hp per contact
export const ENEMY_CONTACT_COOLDOWN_S = 0.5;   // per-(player, enemy) pair
export const ENEMY_DESPAWN_RADIUS = 50;        // beyond this from any non-downed player
export const PLAYER_NAME_MAX_LEN = 16;
