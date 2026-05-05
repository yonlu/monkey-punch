// Pure data table for weapon kinds. No Schema, no methods, no side effects on import.
// Adding a weapon means adding a row here (and possibly a new `targeting` mode in
// rules.ts). Per spec §Weapons table.

export type TargetingMode = "nearest";

export type WeaponKind = {
  name: string;
  cooldown: number;            // seconds between shots
  projectileSpeed: number;     // units/sec
  projectileLifetime: number;  // seconds
  projectileRadius: number;    // collision radius
  damage: number;
  targeting: TargetingMode;
};

export const WEAPON_KINDS: readonly WeaponKind[] = [
  {
    name: "Bolt",
    cooldown: 0.6,
    projectileSpeed: 18,
    projectileLifetime: 0.8,
    projectileRadius: 0.4,
    damage: 10,
    targeting: "nearest",
  },
];
