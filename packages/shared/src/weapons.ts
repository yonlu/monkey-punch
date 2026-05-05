// Pure data table for weapon kinds. No Schema, no methods, no side effects on
// import. Adding a weapon means adding a row here under an existing
// behavior.kind, never a new branch in tickWeapons or the client renderers.
// Per spec §AD1/AD3 (M5).

export type TargetingMode = "nearest";

export type ProjectileLevel = {
  damage: number;
  cooldown: number;            // seconds between fires
  hitRadius: number;
  projectileSpeed: number;     // units/sec
  projectileLifetime: number;  // seconds
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
  | { name: string; behavior: { kind: "projectile"; targeting: TargetingMode }; levels: ProjectileLevel[] }
  | { name: string; behavior: { kind: "orbit" };                                  levels: OrbitLevel[] };

export const WEAPON_KINDS: readonly WeaponDef[] = [
  {
    name: "Bolt",
    behavior: { kind: "projectile", targeting: "nearest" },
    levels: [
      // NOTE: only `damage` and `cooldown` vary per level for Bolt. Visual
      // stats (hitRadius, projectileSpeed, projectileLifetime) are held
      // constant so client projectile rendering — which doesn't carry
      // weapon level on the FireEvent — stays in sync with server hits at
      // every level. Future per-level visual scaling needs `weaponLevel`
      // added to FireEvent; out of scope for M5.
      { damage: 10, cooldown: 0.60, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 14, cooldown: 0.55, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 18, cooldown: 0.50, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 22, cooldown: 0.45, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 28, cooldown: 0.40, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
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
 */
export function statsAt<W extends WeaponDef>(def: W, level: number): W["levels"][number] {
  const idx = Math.max(1, Math.min(def.levels.length, level)) - 1;
  return def.levels[idx]!;
}
