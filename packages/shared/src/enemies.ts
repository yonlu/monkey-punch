// M10: pure data table for enemy kinds. No Schema, no methods, no side
// effects on import. Adding an enemy means adding a row here under an
// existing capability shape — NEVER a new branch in tickEnemies,
// tickSpawner, tickContactDamage, or the client renderers (rule 12).
//
// Parallel structure to WEAPON_KINDS in weapons.ts and ITEM_KINDS in
// items.ts: single source of truth, generic dispatch by kind index,
// never by `name`.
//
// Per-kind dispatch reads through `enemyDefAt(kind)` — never via direct
// indexing or via `def.name === "..."`.

export type EnemyDef = {
  name: string;
  baseHp: number;
  speedMultiplier: number;   // multiplied by ENEMY_SPEED (slime baseline = 1.0)
  contactDamage: number;     // hp per touch (overrides ENEMY_CONTACT_DAMAGE)
  radius: number;            // hit + contact radius (overrides ENEMY_RADIUS)
  gemDropCount: number;      // gems spawned in a fan around death point
  spawnWeight: number;       // relative odds in tickSpawner; 0 for bosses
  minSpawnTick: number;      // earliest state.tick at which kind may spawn
  flying: boolean;           // true = tickEnemies skips terrain Y-snap and uses FLYING_ENEMY_ALTITUDE
  isBoss: boolean;           // bosses spawned by tickBossSpawner, not tickSpawner
  // Boss-only fields. Read only when isBoss === true; ignored (and
  // zeroed) for non-boss rows.
  bossAbilityCooldownTicks: number;
  bossAbilityWindupTicks: number;
  bossAbilityRadius: number;
  bossAbilityDamage: number;
};

// Kind index ordering is the wire identifier. Stable across releases —
// new kinds append at the end. Reordering would break save/replay
// determinism the same way reordering WEAPON_KINDS would.
export const ENEMY_KINDS: readonly EnemyDef[] = [
  // 0: Slime — preserves current behavior. Always spawnable.
  { name: "Slime",    baseHp: 30,   speedMultiplier: 1.0, contactDamage: 5,
    radius: 0.5, gemDropCount: 1,  spawnWeight: 60, minSpawnTick: 0,
    flying: false, isBoss: false,
    bossAbilityCooldownTicks: 0,  bossAbilityWindupTicks: 0,
    bossAbilityRadius: 0,         bossAbilityDamage: 0 },

  // 1: Bunny — fast trash; unlocks after 30s.
  { name: "Bunny",    baseHp: 10,   speedMultiplier: 1.5, contactDamage: 4,
    radius: 0.4, gemDropCount: 1,  spawnWeight: 30, minSpawnTick: 30 * 20,
    flying: false, isBoss: false,
    bossAbilityCooldownTicks: 0,  bossAbilityWindupTicks: 0,
    bossAbilityRadius: 0,         bossAbilityDamage: 0 },

  // 2: Ghost — flying mid; unlocks after 90s.
  { name: "Ghost",    baseHp: 20,   speedMultiplier: 1.0, contactDamage: 6,
    radius: 0.5, gemDropCount: 2,  spawnWeight: 20, minSpawnTick: 90 * 20,
    flying: true,  isBoss: false,
    bossAbilityCooldownTicks: 0,  bossAbilityWindupTicks: 0,
    bossAbilityRadius: 0,         bossAbilityDamage: 0 },

  // 3: Skeleton — humanoid mid; unlocks after 150s.
  { name: "Skeleton", baseHp: 80,   speedMultiplier: 1.0, contactDamage: 10,
    radius: 0.6, gemDropCount: 3,  spawnWeight: 15, minSpawnTick: 150 * 20,
    flying: false, isBoss: false,
    bossAbilityCooldownTicks: 0,  bossAbilityWindupTicks: 0,
    bossAbilityRadius: 0,         bossAbilityDamage: 0 },

  // 4: Boss — bespoke creature; spawnWeight=0 so tickSpawner never picks it.
  //    Spawned exclusively by tickBossSpawner on its own timer.
  { name: "Boss",     baseHp: 2000, speedMultiplier: 0.7, contactDamage: 20,
    radius: 1.5, gemDropCount: 15, spawnWeight: 0,  minSpawnTick: 0,
    flying: false, isBoss: true,
    bossAbilityCooldownTicks: 100,  // 5s @ 20Hz
    bossAbilityWindupTicks: 20,     // 1s telegraph
    bossAbilityRadius: 4,
    bossAbilityDamage: 30 },
];

/**
 * Clamp `kind` into the defined range and return the row. Defensive
 * against fractional and non-finite inputs — same shape as `statsAt`
 * in weapons.ts and `itemValueAt` in items.ts. Today `Enemy.kind` is
 * uint8 so out-of-range is theoretical, but the helper is the public
 * boundary contract.
 */
export function enemyDefAt(kind: number): EnemyDef {
  const floored = Math.floor(kind);
  const safe = Number.isFinite(floored) ? floored : 0;
  const idx = Math.max(0, Math.min(ENEMY_KINDS.length - 1, safe));
  return ENEMY_KINDS[idx]!;
}

/**
 * Cached boss kind index. Resolved at module load by scanning
 * ENEMY_KINDS for the first `isBoss === true` row. If a future refactor
 * accidentally removes the boss row, the IIFE assertion trips at
 * import time — not at the first 3-minute mark of a real run.
 *
 * Mirror of the assertion pattern used for MAX_ORB_COUNT_EVER in
 * shared/index.ts.
 */
export const BOSS_KIND_INDEX: number = (() => {
  const idx = ENEMY_KINDS.findIndex((d) => d.isBoss);
  if (idx < 0) {
    throw new Error(
      "BOSS_KIND_INDEX: ENEMY_KINDS contains no row with isBoss === true",
    );
  }
  return idx;
})();
