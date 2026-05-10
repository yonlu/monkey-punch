// M9 US-002: pure data table for passive items. No Schema, no methods,
// no side effects on import. Adding an item means adding a row here
// under an existing ItemEffect enum value — NEVER a new branch in
// getItemMultiplier or the effect-application sites (rule 12).
//
// Parallel structure to WEAPON_KINDS in weapons.ts: single source of
// truth, generic dispatch by enum value, never by `name`. Adding a new
// effect kind requires extending the ItemEffect union AND wiring the
// effect at its application site (the helper just multiplies whatever
// matching values it finds).

export type ItemEffect =
  | "damage_mult"      // multiplier on weapon damage at every damage emit site
  | "cooldown_mult"    // multiplier on weapon cooldown / aura tick interval
  | "max_hp_mult"      // multiplier on PLAYER_MAX_HP; applied at item pickup, heals diff
  | "speed_mult"       // multiplier on PLAYER_SPEED in tickPlayers
  | "magnet_mult"      // multiplier on GEM_PICKUP_RADIUS in tickGems
  | "xp_mult";         // multiplier on gem.value at xp gain in tickGems

export type ItemDef = {
  name: string;
  effect: ItemEffect;
  // L1–L5 multiplicative values. e.g., damage_mult [1.10, 1.20, 1.30,
  // 1.40, 1.50] = "+10% per level". cooldown_mult [0.95, 0.90, ...] =
  // "-5% per level". Values < 1 are valid (reduction); values > 1
  // amplify. Default neutral multiplier is 1.0 (no effect).
  values: number[];
};

// 6 items, Ragnarok-themed (matching M8 weapons lore hook). Kind index
// is the wire identifier for the item — order is stable across releases.
// New items append at the end; reordering breaks save/replay determinism
// the same way reordering WEAPON_KINDS would.
export const ITEM_KINDS: readonly ItemDef[] = [
  { name: "Ifrit's Talisman", effect: "damage_mult",   values: [1.10, 1.20, 1.30, 1.40, 1.50] },
  { name: "Wind of Verdure",  effect: "cooldown_mult", values: [0.95, 0.90, 0.85, 0.80, 0.75] },
  { name: "Apple of Idun",    effect: "max_hp_mult",   values: [1.20, 1.40, 1.60, 1.80, 2.00] },
  { name: "Sleipnir",         effect: "speed_mult",    values: [1.05, 1.10, 1.15, 1.20, 1.25] },
  { name: "Magnifier",        effect: "magnet_mult",   values: [1.25, 1.50, 1.75, 2.00, 2.25] },
  { name: "Bunny Top Hat",    effect: "xp_mult",       values: [1.10, 1.20, 1.30, 1.40, 1.50] },
];

/**
 * Clamp `level` into the defined range and return the value at that
 * level. Mirrors `statsAt` from weapons.ts:
 *  - Floors fractional inputs.
 *  - Coerces NaN/Infinity to level 1.
 *  - Clamps to [1, values.length].
 *
 * Public read API for item values — never index `def.values[level]`
 * directly. Today `ItemState.level` is uint8 so out-of-range is
 * theoretical, but the helper is the boundary contract.
 */
export function itemValueAt(def: ItemDef, level: number): number {
  const floored = Math.floor(level);
  const safe = Number.isFinite(floored) ? floored : 1;
  const idx = Math.max(0, Math.min(def.values.length - 1, safe - 1));
  return def.values[idx]!;
}

/**
 * Type guard for runtime ItemEffect strings. Used at message boundaries
 * where the enum value arrives as `string` (e.g., decoded from the
 * wire) and must be narrowed back to the union.
 */
export function isItemEffect(s: string): s is ItemEffect {
  return s === "damage_mult"
      || s === "cooldown_mult"
      || s === "max_hp_mult"
      || s === "speed_mult"
      || s === "magnet_mult"
      || s === "xp_mult";
}

/**
 * Neutral (1.0) multiplier returned when no items contribute to an
 * effect. Constant for clarity — getItemMultiplier short-circuits to
 * this when player.items is empty.
 */
export const NEUTRAL_MULTIPLIER = 1.0;
