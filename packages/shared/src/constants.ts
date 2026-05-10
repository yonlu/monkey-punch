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

// M7 — verticality
/**
 * Vertical offset from the terrain surface to the player's reported `y`.
 * Starts at 0 because the current cube mesh has its origin at the cube
 * center and the renderer offsets visually for now (see PRD Q2 — revisit
 * if a future mesh has its origin at the feet, then this becomes
 * meshHeight / 2). Server-side code adds this to `terrainHeight(x, z)`
 * when snapping the player to the ground.
 */
export const PLAYER_GROUND_OFFSET = 0;

/**
 * Side length (world units) of the rendered terrain mesh on the client.
 * Larger than `MAP_RADIUS * 2` so the visible ground extends well past
 * the playable boundary; once US-016 lands fog with `far = MAP_RADIUS *
 * 1.5`, the extra width is what gives the horizon its smooth fade
 * instead of a hard edge. Server gameplay does not consume this — the
 * pure `terrainHeight(x, z)` is queried by coordinate, not constrained
 * by mesh extents.
 */
export const TERRAIN_SIZE = 200;

// M7 US-009: jump physics constants. All in shared/ so client prediction
// (US-011) and server simulation read the same values — any mismatch
// produces visible jump desync.
//
// Default tuning is a starting point; US-017 polish-pass may revise.
// Peak height with these values: JUMP_VELOCITY^2 / (2 * GRAVITY)
// = 81 / 50 = 1.62 world units (~1.6× the cube's half-extent).
// Air time to apex: JUMP_VELOCITY / GRAVITY = 0.36s.
export const GRAVITY = 25;                  // world units / s² (positive magnitude; applied as -GRAVITY * dt to vy)
export const JUMP_VELOCITY = 9;             // world units / s — initial vy on jump
export const TERMINAL_FALL_SPEED = 30;      // world units / s — clamp on |vy| while falling

// M7 US-010: jump forgiveness windows. Both expressed in seconds; converted to
// "ticks elapsed" via 1/TICK_RATE inside canJump and the buffered-jump check.
//
// COYOTE_TIME — after walking off a ledge, the player can still jump for this
// many seconds (a "grace window" that hides the moment-of-leave). 0.1s = 2
// ticks at 20Hz. Inclusive at the boundary: elapsed == COYOTE_TIME still
// allows a jump.
//
// JUMP_BUFFER — if the player presses jump airborne (and out of coyote), the
// press is remembered for this many seconds; the jump fires automatically on
// the next tick the player can jump (i.e. they land or re-enter coyote). 0.1s
// = 2 ticks. Inclusive at the boundary: elapsed == JUMP_BUFFER still fires.
export const COYOTE_TIME = 0.1;
export const JUMP_BUFFER = 0.1;
