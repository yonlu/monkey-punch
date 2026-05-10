// Pure data table for weapon kinds. No Schema, no methods, no side effects on
// import. Adding a weapon means adding a row here under an existing
// behavior.kind, never a new branch in tickWeapons or the client renderers.
// Per spec §AD1/AD3 (M5).

export type TargetingMode = "nearest" | "furthest" | "facing";

// M8 US-003: projectile visual mesh kind. The renderer (ProjectileSwarm)
// keeps one InstancedMesh per kind and dispatches generically on this enum
// — never on weapon name. Adding a new visual style means adding an enum
// value here and a parallel <instancedMesh> in ProjectileSwarm; no
// changes to tickWeapons / tickProjectiles.
//
//   "sphere"     — small bright sphere (Bolt). Rotationally invariant; no
//                  per-frame quaternion needed.
//   "elongated"  — thin cylinder oriented along its dir vector (Gakkung Bow).
//                  Per-frame rotation matrix from the unit dir vector.
//   "spear"      — long thin cylinder oriented along its dir vector
//                  (Ahlspiess M8 US-004). Same orientation math as
//                  "elongated" but a longer/thinner geometry and a gold
//                  material — kept as a distinct mesh because materials
//                  cannot vary per instance on a single InstancedMesh
//                  without a custom shader path. Per-instance scale on
//                  the matrix lets hitRadius growth per level read
//                  visually (Ahlspiess L1 → L5: 0.5 → 0.8).
export type ProjectileMesh = "sphere" | "elongated" | "spear";

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
  | { name: string; behavior: { kind: "projectile"; targeting: TargetingMode; homingTurnRate: number /* rad/s; 0 = straight-line */; mesh: ProjectileMesh }; levels: ProjectileLevel[] }
  | { name: string; behavior: { kind: "orbit" };                                                                                                              levels: OrbitLevel[] };

export const WEAPON_KINDS: readonly WeaponDef[] = [
  {
    name: "Bolt",
    // M8 US-002: behavior.targeting/homingTurnRate are the projectile-mode
    // discriminators; per-level stats live on ProjectileLevel. M5 Bolt
    // observable behavior is preserved by `targeting: "nearest"` +
    // `homingTurnRate: 0` (straight-line) + per-level `pierceCount: 1` +
    // `hitCooldownPerEnemyMs: 0` (single-hit despawn, no cooldown).
    behavior: { kind: "projectile", targeting: "nearest", homingTurnRate: 0, mesh: "sphere" },
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
  {
    // M8 US-003: Gakkung Bow (kind index 2). Long-range homing arrow that
    // locks the furthest in-range enemy at fire — rewards positioning that
    // builds up an enemy tail. Mild homing (homingTurnRate ≈ π·0.8 ≈ 144°/s)
    // means the arrow can still miss a fast-dodging target. Pierce starts
    // at 1 and grows to 3 at L5; faster cooldown at higher levels. Visual
    // identity: thin elongated cylinder oriented along its dir vector,
    // light wood/brown — distinct from Bolt's bright yellow sphere.
    name: "Gakkung Bow",
    behavior: { kind: "projectile", targeting: "furthest", homingTurnRate: Math.PI * 0.8, mesh: "elongated" },
    levels: [
      { damage: 18, cooldown: 0.85, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 22, cooldown: 0.80, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 1, hitCooldownPerEnemyMs: 0 },
      { damage: 26, cooldown: 0.75, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 2, hitCooldownPerEnemyMs: 0 },
      { damage: 30, cooldown: 0.70, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 2, hitCooldownPerEnemyMs: 0 },
      { damage: 36, cooldown: 0.65, hitRadius: 0.4, projectileSpeed: 28, projectileLifetime: 1.2, pierceCount: 3, hitCooldownPerEnemyMs: 0 },
    ],
  },
  {
    // M8 US-004: Ahlspiess (kind index 3). Piercing line projectile —
    // travels along player.facing at fire (no homing), pierces ALL enemies
    // in its path (pierceCount: -1), and uses per-enemy hit cooldown so the
    // same enemy isn't double-hit on consecutive ticks while still in the
    // radius. RO lore: "ignores DEF" → mechanically translates to "passes
    // through enemies." Visual: long thin gold cylinder oriented along its
    // dir vector. hitRadius grows per level (0.50 → 0.80) — FireEvent now
    // carries weaponLevel so the client renderer can scale visual size
    // accordingly.
    name: "Ahlspiess",
    behavior: { kind: "projectile", targeting: "facing", homingTurnRate: 0, mesh: "spear" },
    levels: [
      { damage: 25, cooldown: 1.00, hitRadius: 0.50, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 30, cooldown: 0.95, hitRadius: 0.55, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 36, cooldown: 0.90, hitRadius: 0.60, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 44, cooldown: 0.85, hitRadius: 0.70, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
      { damage: 54, cooldown: 0.80, hitRadius: 0.80, projectileSpeed: 22, projectileLifetime: 1.5, pierceCount: -1, hitCooldownPerEnemyMs: 200 },
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
