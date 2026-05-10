// Pure data table for weapon kinds. No Schema, no methods, no side effects on
// import. Adding a weapon means adding a row here under an existing
// behavior.kind, never a new branch in tickWeapons or the client renderers.
// Per spec §AD1/AD3 (M5).

export type TargetingMode = "nearest" | "furthest" | "facing";

export type ProjectileLevel = {
  damage: number;
  cooldown: number;            // seconds between fires
  hitRadius: number;
  projectileSpeed: number;     // units/sec
  projectileLifetime: number;  // seconds
  // M8 US-002: max enemies a projectile may hit before despawning. 1 = M5
  // Bolt baseline (single-hit drop). -1 = infinite pierce (Ahlspiess); the
  // projectile only despawns when its lifetime expires.
  pierceCount: number;
  // M8 US-002: per-projectile-per-enemy hit cooldown (ms). 0 = no cooldown
  // (M5 Bolt baseline; not needed when pierce is 1 anyway). >0 lets a
  // pierce projectile (esp. infinite-pierce) avoid double-hitting the same
  // enemy on consecutive ticks while it's still inside the radius.
  hitCooldownPerEnemyMs: number;
};

export type OrbitLevel = {
  damage: number;
  hitRadius: number;
  hitCooldownPerEnemyMs: number;
  orbCount: number;
  orbRadius: number;
  orbAngularSpeed: number;     // radians/sec
};

export type WeaponDef =
  | { name: string; behavior: { kind: "projectile"; targeting: TargetingMode; homingTurnRate: number /* rad/s; 0 = straight-line */ }; levels: ProjectileLevel[] }
  | { name: string; behavior: { kind: "orbit" };                                                                                    levels: OrbitLevel[] };

export const WEAPON_KINDS: readonly WeaponDef[] = [
  {
    name: "Bolt",
    // M8 US-002: behavior.targeting/homingTurnRate are the projectile-mode
    // discriminators; per-level stats live on ProjectileLevel. M5 Bolt
    // observable behavior is preserved by `targeting: "nearest"` +
    // `homingTurnRate: 0` (straight-line) + per-level `pierceCount: 1` +
    // `hitCooldownPerEnemyMs: 0` (single-hit despawn, no cooldown).
    behavior: { kind: "projectile", targeting: "nearest", homingTurnRate: 0 },
    levels: [
      // NOTE: only `damage` and `cooldown` vary per level for Bolt. Visual
      // stats (hitRadius, projectileSpeed, projectileLifetime) are held
      // constant. M5 deferred per-level visual scaling because FireEvent
      // didn't carry weaponLevel; M8 US-002 lifts that restriction by
      // adding weaponLevel to FireEvent — but Bolt deliberately keeps its
      // visual stats flat to preserve M5-era look.
      { damage: 10, cooldown: 0.60, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 14, cooldown: 0.55, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 18, cooldown: 0.50, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 22, cooldown: 0.45, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 28, cooldown: 0.40, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
    ],
  },
  {
    name: "Orbit",
    behavior: { kind: "orbit" },
    levels: [
      { damage:  6, hitRadius: 0.5, hitCooldownPerEnemyMs: 700, orbCount: 2, orbRadius: 2.0, orbAngularSpeed: 2.4 },
      { damage:  8, hitRadius: 0.5, hitCooldownPerEnemyMs: 650, orbCount: 2, orbRadius: 2.2, orbAngularSpeed: 2.6 },
      { damage: 10, hitRadius: 0.6, hitCooldownPerEnemyMs: 600, orbCount: 3, orbRadius: 2.2, orbAngularSpeed: 2.6 },
      { damage: 13, hitRadius: 0.6, hitCooldownPerEnemyMs: 550, orbCount: 3, orbRadius: 2.4, orbAngularSpeed: 2.8 },
      { damage: 16, hitRadius: 0.6, hitCooldownPerEnemyMs: 500, orbCount: 4, orbRadius: 2.4, orbAngularSpeed: 3.0 },
    ],
  },
];

export type ProjectileWeaponDef = Extract<WeaponDef, { behavior: { kind: "projectile" } }>;
export type OrbitWeaponDef = Extract<WeaponDef, { behavior: { kind: "orbit" } }>;

/**
 * Type guard for the projectile branch of WeaponDef. Used at every site that
 * reads projectile-specific stats — TS does not narrow the outer object
 * through nested discriminator access (`def.behavior.kind === "..."`), so a
 * user-defined predicate is required for narrowing to flow into `statsAt`.
 */
export function isProjectileWeapon(def: WeaponDef): def is ProjectileWeaponDef {
  return def.behavior.kind === "projectile";
}

export function isOrbitWeapon(def: WeaponDef): def is OrbitWeaponDef {
  return def.behavior.kind === "orbit";
}

/**
 * Clamp `level` into the defined range and return the row of stats. Both
 * server (tickWeapons) and clients (renderers, HUD) read effective stats
 * through this — never via direct `def.levels[level]` indexing — so off-by-one
 * around level=0 or beyond max never reaches a hot path.
 *
 * Defensive against fractional and non-finite inputs: the type system permits
 * any `number` but a fractional array index returns `undefined`, which the
 * non-null assertion would mask and downstream NaN-corrupt. Today
 * `WeaponState.level` is uint8 so this is theoretical, but `statsAt` is the
 * public read API and should not require its caller to pre-floor.
 */
export function statsAt<W extends WeaponDef>(def: W, level: number): W["levels"][number] {
  const floored = Math.floor(level);
  // Math.floor(NaN) is NaN; coerce to 1 so we land on level 1 below.
  const safe = Number.isFinite(floored) ? floored : 1;
  const idx = Math.max(0, Math.min(def.levels.length - 1, safe - 1));
  return def.levels[idx]!;
}
