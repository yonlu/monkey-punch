# PRD: Milestone 9 — Items (Passive Accessories, Ragnarok-Themed)

## 1. Introduction / Overview

M8 shipped the weapon layer. M9 ships the **build** layer: six passive
items that modify player stats (damage, cooldown, max HP, speed, magnet
range, XP gain). Items appear in the level-up choice pool alongside
weapons, mirror the L1–L5 leveling pattern, and stack multiplicatively.

Architecturally this is a smaller milestone than M8. The dominant work is
**wide, not deep**: a single `getItemMultiplier(player, effect)` helper is
called from ~12 code sites (every damage emit, every cooldown set,
tickPlayers, tickGems, the level-up apply path). One new schema field
on Player (`items: ArraySchema<ItemState>`). One shape change to
`LevelUpOfferedEvent` so its `choices` payload carries both weapons and
items.

The hypothesis being validated: a single generic effect-multiplier helper
can wire passive items into every relevant code path without name-based
branching (CLAUDE.md rule 12). If it can't, the items abstraction is
wrong, and we discover that here and fix it before piling more on top.

All gameplay logic stays in `shared/rules.ts` (rule 4); all synced state
stays in `shared/schema.ts` (rule 2); the seeded PRNG remains the sole
source of gameplay randomness (rule 6); the tick order in rule 11 is
preserved (no new tick functions in M9).

Item names take their flavor from Ragnarok Online (matching M8's lore
hook). Mechanics are genre-standard (Vampire Survivors / HoloCure
passive-item pattern).

## 2. Goals

- Add **6 passive items**, each with L1–L5 multiplicative effect
  curves, drawn from a parallel `ITEM_KINDS` table.
- Extend the level-up choice pool to draw from **weapons ∪ items**
  (mixed pool, equal weighting), with the offered triple distinguishing
  weapon vs item choices on the wire.
- A single `getItemMultiplier(player, effect)` helper handles all effect
  application — generic dispatch on effect enum, no name-based branching.
- Effect application points: damage emit sites (5), weapon cooldown set
  sites (5), `tickPlayers` (movement speed), `tickGems`
  (magnet radius + XP gain), and player max HP on item pickup.
- Determinism: the seeded room PRNG is the only source of randomness
  for the choice pool (rule 6); the rng schedule is unchanged.
- Performance: stacking effects from ≤ 6 items per player adds O(items)
  work per damage emit / cooldown set. Negligible at the project's
  10-player room cap.
- Architectural compliance: no rule in CLAUDE.md is violated. Rule 12
  grep stays clean (no name-based branching for any of the 6 items).

## 3. User Stories

Eight stories total: six implementation + two BLOCKING playtest gates.

### US-001: 🛑 BLOCKING — Architecture review checkpoint

**Description:** As the project owner (Luke), I need to review the
`ItemDef` shape, the full `ITEM_KINDS` table with per-level value
curves, the schema additions, the `LevelUpOfferedEvent` shape change,
and the touch-points list (every place an item effect applies) BEFORE
any implementation. This is where wide-touch concerns surface; better
to catch them in review than after six items are wired up.

**Acceptance Criteria:**
- [ ] Design doc / PR-stub presents:
  - [ ] `ItemDef` shape: `{ name; effect: ItemEffect; values: number[] }`
  - [ ] `ItemEffect` enum: `"damage_mult" | "cooldown_mult" | "max_hp_mult"
    | "speed_mult" | "magnet_mult" | "xp_mult"`
  - [ ] Full `ITEM_KINDS` table for all 6 items with L1–L5 `values`
    arrays per the §3 starting values below
  - [ ] Schema additions: new `ItemState` class (`kind: uint8`,
    `level: uint8`), `Player.items: ArraySchema<ItemState>` —
    declare-style + `defineTypes` per landmine #1
  - [ ] `LevelUpOfferedEvent.choices` shape change from `number[]` to
    `Array<{ type: "weapon" | "item"; index: number }>`
  - [ ] `LevelUpChoiceMessage.choiceIndex` stays 0/1/2 (unchanged —
    indexes into the offered triple)
  - [ ] `getItemMultiplier(player, effect): number` helper signature
  - [ ] Touch-points list: 5 damage emit sites in `rules.ts` (tickWeapons
    orbit arm, runMeleeArcSwing, runAuraTick, tickProjectiles,
    tickBoomerangs, tickBloodPools — actually 6); 5 weapon cooldown
    sites (each tickWeapons arm); `tickPlayers` movement step;
    `tickGems` magnet radius + XP gain; `resolveLevelUp` for max HP
    apply on pickup
- [ ] Luke has explicitly approved OR provided concrete changes that
  have been incorporated
- [ ] No work on US-002+ begins until this story is closed

### US-002: Item infrastructure — schema, table, helper, mixed choice pool

**Description:** As the simulation, I need the data model and dispatch
helper for items to exist before any individual item's effect is wired
in. This story produces a complete but inert item layer: items can be
acquired via level-up choices and stored on the player schema, but
none of their effects actually apply until US-003+.

**Acceptance Criteria:**
- [ ] `packages/shared/src/items.ts` exports `ItemEffect` enum,
  `ItemDef` type, `ITEM_KINDS: readonly ItemDef[]` (with all 6 entries
  per §3 below — but their effects are not yet wired in by this US),
  `itemValueAt(def, level): number` (clamps level like `statsAt`),
  `isItemEffect(s: string): s is ItemEffect` (type guard)
- [ ] `packages/shared/src/schema.ts`: new `ItemState` class with
  `kind: uint8`, `level: uint8`, declare-style + defineTypes (landmine
  #1); `Player.items: ArraySchema<ItemState>` added (declare + ctor +
  defineTypes)
- [ ] `packages/shared/src/rules.ts`: new exported
  `getItemMultiplier(player, effect): number` walks `player.items`,
  multiplicatively accumulates values where `def.effect === effect`,
  returns 1 if no matching items. Called nowhere yet (US-003+ wire
  the call sites)
- [ ] `LevelUpOfferedEvent.choices` shape changed in
  `packages/shared/src/messages.ts` from `number[]` to
  `Array<{ type: "weapon" | "item"; index: number }>`
- [ ] `resolveLevelUp` in `rules.ts` updated:
  - On rolling choices, draws from `WEAPON_KINDS.length +
    ITEM_KINDS.length` (mixed pool, equal weighting)
  - Encodes each as `{ type: "weapon" | "item", index }`
  - On applying a chosen item: if player has the item, increments
    `item.level` (capped at 5); else pushes a new `ItemState` with
    `kind = index, level = 1`
  - Weapon path unchanged in observable behavior
- [ ] `LevelUpResolvedEvent.weaponKind` stays for backwards compat,
  but for item choices a new field `pickedItemKind: number | -1`
  surfaces which item kind was picked (-1 = weapon picked, else item
  index). Alternative cleaner approach: rename to `picked: { type,
  index }` — choose at US-001 review
- [ ] Existing M7 level-up tests pass unchanged for weapon choices
  (non-regression on the weapon path)
- [ ] Vitest: rolling level-up choices from a mixed pool produces both
  weapon and item entries deterministically given a fixed seed
- [ ] Vitest: applying an item choice creates a new `ItemState` on
  player.items at level 1; applying again increments level; capped at 5
- [ ] Vitest: `getItemMultiplier(player, effect)` with no items returns
  1, with one item at L3 returns the L3 value, with two same-effect
  items multiplies them (only relevant if a future second item shares
  an effect — defensive)
- [ ] Schema encoder integration test still passes (landmine #1
  regression guard)
- [ ] Typecheck passes
- [ ] Tests pass

### US-003: Damage Up + Cooldown Reduction items (Ifrit's Talisman + Wind of Verdure)

**Description:** As a player, I want items that scale my weapon damage
and reduce my weapon cooldowns so the build layer meaningfully
strengthens whatever weapons I picked.

**Acceptance Criteria:**
- [ ] `ITEM_KINDS[0]` is **Ifrit's Talisman** with `effect:
  "damage_mult"`, values `[1.10, 1.20, 1.30, 1.40, 1.50]` (additive
  +10% per level, reads as "+10% damage to all weapons" in-game)
- [ ] `ITEM_KINDS[1]` is **Wind of Verdure** with `effect:
  "cooldown_mult"`, values `[0.95, 0.90, 0.85, 0.80, 0.75]` (additive
  -5% per level)
- [ ] All 6 damage emit sites in `rules.ts` multiply their `damage`
  field by `getItemMultiplier(player, "damage_mult")`:
  - tickWeapons orbit arm
  - runMeleeArcSwing (per-hit damage AFTER crit multiplier — crit
    stacks with item damage)
  - runAuraTick (per-tick damage)
  - tickProjectiles (per-hit damage)
  - tickBoomerangs (per-hit damage)
  - tickBloodPools (per-tick damage) — NOTE: pool damage is BAKED at
    pool spawn from the boomerang's stats, so the multiplier is
    applied at spawn (in tickBoomerangs when creating the BloodPool)
    NOT at DoT time; otherwise a player picking Ifrit's Talisman
    after the pool spawned would retroactively boost in-flight pools
- [ ] All 5 weapon cooldown set sites in `rules.ts` multiply
  `stats.cooldown` by `getItemMultiplier(player, "cooldown_mult")`:
  - tickWeapons projectile arm (after fire)
  - tickWeapons orbit arm (orbit has no cooldown reset — confirm at
    US-001; if applicable, applies; if not, skip)
  - tickWeapons melee_arc arm (after swing)
  - tickWeapons boomerang arm (after throw)
  - tickWeapons aura arm (next-tick countdown reset — cooldown_mult
    applies to `tickIntervalMs` here too, so a damage-multiplier'd
    Kronos with cooldown reduction ticks faster)
- [ ] NO name-based branching anywhere (rule 12 grep clean)
- [ ] Vitest: a player with Ifrit's Talisman L3 (1.30×) firing a
  Damascus crit-hit deals damage × crit_mult × 1.30 (multiplicative
  stacking)
- [ ] Vitest: a player with Wind of Verdure L2 (0.90×) sees Bolt's
  cooldown set to base_cooldown × 0.90 after fire
- [ ] Vitest: stacking Ifrit's L1 + a future damage_mult item L1 (if
  there were one) multiplies — i.e., 1.10 × 1.10 = 1.21. Currently only
  one damage_mult item exists, so this is defensive: simulate by
  pushing 2 ItemState entries for the same kind (which shouldn't
  normally happen but tests the multiplier logic)
- [ ] Typecheck passes
- [ ] Tests pass

### US-004: Max HP + Movement Speed items (Apple of Idun + Sleipnir)

**Description:** As a player, I want items that increase my survivability
(more HP) and mobility (faster movement) so the build layer affects
both offense AND defense.

**Acceptance Criteria:**
- [ ] `ITEM_KINDS[2]` is **Apple of Idun** with `effect: "max_hp_mult"`,
  values `[1.20, 1.40, 1.60, 1.80, 2.00]` (additive +20% per level)
- [ ] `ITEM_KINDS[3]` is **Sleipnir** with `effect: "speed_mult"`, values
  `[1.05, 1.10, 1.15, 1.20, 1.25]` (additive +5% per level — speed is
  scaled small to avoid feel-breaking sprint speed at L5)
- [ ] `resolveLevelUp` for an Apple of Idun pickup: recomputes
  `player.maxHp = Math.floor(PLAYER_MAX_HP * getItemMultiplier(player,
  "max_hp_mult"))`. Also **heals** the player for the increase
  (`player.hp += diff`, capped at new maxHp). Without the heal, an
  item that increases max HP would be useless when picked at full
  health
- [ ] `tickPlayers` movement step multiplies `PLAYER_SPEED` by
  `getItemMultiplier(player, "speed_mult")`
- [ ] Vitest: a player at full HP picking Apple of Idun L1 (1.20×) sees
  `maxHp` go from `PLAYER_MAX_HP` to `Math.floor(PLAYER_MAX_HP * 1.20)`
  and `hp` matches (full health)
- [ ] Vitest: a player at half HP picking Apple of Idun L1 sees `maxHp`
  scale and `hp` increase by the diff (still not full health)
- [ ] Vitest: a player with Sleipnir L3 (1.15×) moves at
  `PLAYER_SPEED * 1.15 * dt` per tick on a unit-length inputDir
- [ ] Existing tickPlayers tests pass unchanged for players with no
  speed_mult items (non-regression)
- [ ] Typecheck passes
- [ ] Tests pass

### US-005: Magnet Range + XP Gain items (Magnifier + Bunny Top Hat)

**Description:** As a player, I want items that help me collect more
gems faster and gain more XP from each gem — the build layer affects
the loop of "gem → XP → level-up" beyond just combat power.

**Acceptance Criteria:**
- [ ] `ITEM_KINDS[4]` is **Magnifier** with `effect: "magnet_mult"`,
  values `[1.25, 1.50, 1.75, 2.00, 2.25]` (additive +25% per level —
  magnet feel benefits from steeper scaling than other multipliers)
- [ ] `ITEM_KINDS[5]` is **Bunny Top Hat** with `effect: "xp_mult"`,
  values `[1.10, 1.20, 1.30, 1.40, 1.50]` (additive +10% per level)
- [ ] `tickGems` pickup check uses per-player effective radius:
  `effectiveRadius = GEM_PICKUP_RADIUS * getItemMultiplier(player,
  "magnet_mult")`. Each player's radius is computed once at the start
  of `tickGems` (not per gem) for performance
- [ ] `tickGems` XP gain on pickup: `xpGained = Math.floor(gem.value *
  getItemMultiplier(player, "xp_mult"))`. Apply to both `player.xp` and
  `player.xpGained` (the cumulative counter)
- [ ] Vitest: a player with Magnifier L4 (2.00×) picks up a gem from
  exactly `GEM_PICKUP_RADIUS * 2.00 - epsilon` away (would have been
  out of range without the item)
- [ ] Vitest: a player with Bunny Top Hat L2 (1.20×) picking up a 1-value
  gem gains `Math.floor(1 * 1.20) = 1` XP (boundary case — single-value
  gems don't show the multiplier until L5 = 1.50 → 1). Use a higher
  gem value (e.g., 10) in the test to make the multiplier observable
  (10 * 1.20 = 12 XP)
- [ ] Existing tickGems tests pass unchanged for players with no
  multipliers (non-regression)
- [ ] Typecheck passes
- [ ] Tests pass

### US-006: 🛑 BLOCKING — Mid-milestone playtest checkpoint

**Description:** As the project owner (Luke), I need to play with all 6
items live before committing to the level-up UI polish work. Items
fundamentally change the level-up decision space; if any item feels
clearly broken (too weak, too strong, or doesn't read in-game), fix it
now before adding UI fidelity on top.

**Acceptance Criteria:**
- [ ] Two clients can join, level up, and see weapons AND items appear
  in choice pools across multiple runs
- [ ] Each of the 6 items, picked: visibly works (verified by
  observing damage numbers / cooldowns / movement speed / pickup
  radius / XP gain rate)
- [ ] No regressions: existing M5/M6/M7/M8 behavior (Bolt, Orbit, the
  6 M8 weapons, status effects, blood pools) all still work
- [ ] grep across `packages/{shared,server,client}/src` returns NOTHING
  for `name === "Ifrit's Talisman"|"Wind of Verdure"|"Apple of Idun"
  |"Sleipnir"|"Magnifier"|"Bunny Top Hat"` (CLAUDE.md rule 12
  verification)
- [ ] Two-client determinism: damage numbers, projectile paths, item
  effects match between two clients viewing the same room
- [ ] Luke has explicitly approved feel OR filed concrete tuning
  changes (e.g., "Sleipnir feels too weak at L1", "Apple of Idun heal
  on pickup is too generous") that have been applied and re-tested
- [ ] Typecheck passes
- [ ] Tests pass
- [ ] No work on US-007+ begins until this story is closed

### US-007: Level-up UI polish — item vs weapon distinction

**Description:** As a player, when the level-up panel appears, I should
immediately see which of the 3 choices are weapons and which are items,
so my decision is informed.

**Acceptance Criteria:**
- [ ] `LevelUpOverlay.tsx` reads the choice payload's `type` field and
  renders item choices with a visually distinct treatment:
  - Item border or background tint (e.g., gold for items, blue for
    weapons) — pick one in the implementation
  - Item icon placeholder (a simple emoji or shape — actual icon assets
    are a polish-pass concern). At minimum, a small label "ITEM" on
    item cards
- [ ] Item description text reads the item's effect + current level
  value, e.g., "Ifrit's Talisman L1 → +10% damage"
- [ ] If the player already has an item, the choice card shows "L2
  (currently L1) → +20% damage" so the upgrade is visible
- [ ] Verify in browser using dev-browser skill (or manual playtest)
- [ ] Typecheck passes

### US-008: 🛑 BLOCKING — Final playtest checkpoint

**Description:** As the project owner (Luke), I want a real session
with friends before declaring M9 complete. Items significantly change
build space; verify the loop is fun, not just functional.

**Acceptance Criteria:**
- [ ] Real multi-client session played end-to-end
- [ ] All 8 weapons + 6 items confirmed to (a) appear in choice pools,
  (b) work as expected when picked, (c) have visually readable
  presentation in the level-up overlay
- [ ] No "obviously broken" interactions (e.g., Apple of Idun heal
  exploits, infinite XP gain loops, item stacks that crash the client)
- [ ] Performance: 200 enemies + 2 players each running 4–5 weapons +
  3–4 items hold 60fps client / 20Hz server
- [ ] Balance feedback captured (notes file or commit message) for a
  follow-up tuning milestone — NOT addressed in this milestone
- [ ] Final commit on `main` closes US-008 and the milestone
- [ ] Typecheck passes
- [ ] Tests pass

## 4. Functional Requirements

- **FR-1:** `ItemDef` is a flat shape with `name: string`, `effect:
  ItemEffect`, `values: number[]`. No discriminated union — all items
  share the same level shape (`values[]` of multipliers).
- **FR-2:** `ItemEffect` is a string enum:
  `"damage_mult" | "cooldown_mult" | "max_hp_mult" | "speed_mult" |
  "magnet_mult" | "xp_mult"`. Effect dispatch in every effect-application
  site uses ONLY this enum — no name-based branching anywhere (rule 12).
- **FR-3:** `Player.items: ArraySchema<ItemState>` is the per-player
  list of owned items. `ItemState` has `kind: uint8, level: uint8`.
  declare-style + defineTypes per landmine #1.
- **FR-4:** `getItemMultiplier(player: Player, effect: ItemEffect):
  number` is the single source of effect lookup. Walks `player.items`,
  multiplicatively accumulates values where `def.effect === effect`,
  returns 1 if no matching items.
- **FR-5:** Mixed level-up choice pool — `resolveLevelUp` draws from
  the union of `WEAPON_KINDS` and `ITEM_KINDS` with equal weighting.
  `LevelUpOfferedEvent.choices` is `Array<{ type: "weapon" | "item";
  index: number }>` — typed at the schema/message boundary, not bit-
  packed.
- **FR-6:** Effect application sites:
  - **damage_mult**: applied at every damage emit site. For Bloody Axe
    blood pools, the multiplier is BAKED into `BloodPool.damagePerTick`
    at spawn time (in `tickBoomerangs`) — not at DoT time — so a
    mid-flight Ifrit's Talisman pickup doesn't retroactively boost
    in-flight pools (same single-writer-at-spawn pattern Boomerang
    uses for its own damage).
  - **cooldown_mult**: applied to `stats.cooldown` at every
    `weapon.cooldownRemaining = stats.cooldown` site in `tickWeapons`.
    For Kronos aura, applies to `tickIntervalMs/1000` (faster aura
    ticks at high cooldown_mult).
  - **max_hp_mult**: applied at item pickup in `resolveLevelUp` —
    recomputes `player.maxHp = PLAYER_MAX_HP * mult` and heals the
    diff.
  - **speed_mult**: applied in `tickPlayers` — multiplies
    `PLAYER_SPEED` by `getItemMultiplier`.
  - **magnet_mult**: applied in `tickGems` — multiplies
    `GEM_PICKUP_RADIUS` by `getItemMultiplier`. Cached per-player at
    the start of `tickGems` (not per gem).
  - **xp_mult**: applied in `tickGems` at the moment xp is granted.
- **FR-7:** Item leveling caps at L5. Picking an item already at L5
  in the level-up choice flow does nothing useful — `resolveLevelUp`
  silently ignores the increment (or re-rolls — design decision in
  US-001 review).
- **FR-8:** Choice pool is equally-weighted across all weapons AND
  items. No bias toward unowned items, no bias toward owned items.
  Random.
- **FR-9:** Tick order is UNCHANGED from M8. No new tick functions.
  Items are pure data; their effects are read at existing tick
  sites via the helper.
- **FR-10:** All gameplay randomness (mixed pool roll) goes through the
  seeded PRNG on `RoomState` — no `Math.random` in gameplay code
  (rule 6).
- **FR-11:** Level-up UI shows item vs weapon distinction (border,
  label, or background tint) and item effect descriptions including
  the current and upgraded level values.

## 5. Non-Goals (Out of Scope)

- **No weapon evolutions** — the "weapon + item combo unlocks an
  evolved weapon" Vampire Survivors mechanic is queued for M10+. M9
  items are pure stat modifiers; they do not unlock or transform
  weapons.
- **No item synergies** — no "magnet + XP gives bonus when stacked"
  interactions. Each item's effect is independent and read via the
  generic helper.
- **No item rarity tiers** — all 6 items are equally weighted in the
  choice pool. No legendary/epic/common distinction.
- **No item count cap** — a player can collect all 6 items in a long
  enough run. If playtest reveals "too many level-ups feels grindy,"
  a cap can be added in a future milestone.
- **No item drops from enemies/chests** — items appear ONLY in
  level-up choices (mixed pool with weapons). Roguelite world-pickup
  items are a separate, larger milestone.
- **No animated character art / sound** — same exclusions as M8.
  Level-up UI changes are layout + text + simple color tinting, not
  custom illustrations.
- **No item-specific VFX** — picking an item doesn't trigger a unique
  particle effect at this milestone. Future polish pass.
- **No status-effect items** — no item that grants damage immunity,
  burn application, etc. Status effects remain weapon-only (Kronos
  slow) in M9.
- **No balance tuning pass** — starting values are per §3; final
  balance is a follow-up tuning milestone driven by playtest data.

## 6. Design Considerations

### Visual identity

- **Item card distinct from weapon card**: gold-tinted border or
  background for items, blue/neutral for weapons. Item card shows
  current level and upgrade preview (e.g., "L1 → L2: +10% → +20%").
- **Item icons**: placeholder emoji or simple geometric shapes are
  acceptable for M9. Custom illustrations are a polish-pass concern.
- **Item description text**: short, readable. e.g., "Ifrit's Talisman
  L2: All weapons deal +20% damage."

### Effect description strings

Hardcoded per-effect templates that read `values[level - 1]` and format
as a percentage. Generic dispatch on `effect` enum to pick the template.
e.g.:

```ts
function describeItem(def: ItemDef, level: number): string {
  const v = itemValueAt(def, level);
  switch (def.effect) {
    case "damage_mult":   return `+${((v - 1) * 100).toFixed(0)}% weapon damage`;
    case "cooldown_mult": return `-${((1 - v) * 100).toFixed(0)}% weapon cooldown`;
    case "max_hp_mult":   return `+${((v - 1) * 100).toFixed(0)}% max HP`;
    case "speed_mult":    return `+${((v - 1) * 100).toFixed(0)}% movement speed`;
    case "magnet_mult":   return `+${((v - 1) * 100).toFixed(0)}% gem magnet range`;
    case "xp_mult":       return `+${((v - 1) * 100).toFixed(0)}% XP gain`;
  }
}
```

## 7. Technical Considerations

- **No new shared deps.** All work fits within `@colyseus/schema`, the
  existing PRNG, and existing tick infrastructure.
- **Single-writer-at-spawn for blood pools.** Damage multiplier on
  blood-pool DoT is BAKED at spawn (when `tickBoomerangs` creates the
  pool), not at DoT time. This mirrors Boomerang's own
  damage-baked-at-throw pattern: a mid-flight item pickup doesn't
  retroactively change in-flight pool damage. Documented in the
  `BloodPool.damagePerTick` field's comment.
- **Per-player caching in `tickGems`.** The magnet radius multiplier
  is computed ONCE per player at the start of `tickGems` (not per
  gem), so the inner pickup loop's cost is O(gems × players × 1
  multiplier lookup) instead of O(gems × players × items).
- **`tickGems` may need a small signature refactor** if it doesn't
  already have `player` accessible in the gem-pickup branch. Confirm
  at US-001.
- **Existing level-up tests** that assert the shape of
  `LevelUpOfferedEvent.choices` (as `number[]`) need updating to match
  the new `{ type, index }[]` shape. This is the largest known
  breaking change to existing tests.
- **`Player.maxHp` is a synced schema field** — recomputing on item
  pickup means the change syncs to all clients. HUD HP bars
  automatically update.
- **Item pickup order matters for max HP.** If a player has two
  Apple of Idun in their inventory (shouldn't happen — only one entry
  per kind), the multiplier would compound. With one entry per kind
  (US-002's increment-existing logic), the multiplier is just the
  current level's value. Safe.
- **Rule 11 tick order is preserved.** No new tick functions. Items
  affect existing tick functions' computations, not their ordering.
- **Determinism.** The mixed choice pool roll uses
  `Math.floor(state.rng() * (WEAPON_KINDS.length + ITEM_KINDS.length))`
  — single rng call per choice. Same number of rng calls as M8's
  weapon-only pool roll. The rng schedule (xp + spawner) is
  unchanged.

## 8. Success Metrics

- All 6 items shipped, all in the level-up choice pool, all individually
  playable end-to-end.
- Zero name-based branching anywhere in tick or render code (rule 12
  grep — `grep -E 'name === "(Ifrit|Wind|Apple|Sleipnir|Magnifier|Bunny)
  ' …` returns nothing).
- All existing M5/M6/M7/M8 tests pass unchanged (non-regression).
- All new Vitest cases pass.
- `pnpm typecheck` passes.
- 60fps client / 20Hz server holds at 200 enemies + 2 players each
  running 4–5 weapons + 3–4 items.
- Two-client determinism verified for the mixed choice pool (both
  clients receive the same level-up choices given the same seed +
  same XP-accumulation history).
- Luke's subjective feel approval at US-006 (mid-milestone) and
  US-008 (final).

## 9. Open Questions

- **L5 cap re-roll behavior.** If a player picks Ifrit's Talisman at
  L5 (already maxed), does the choice silently no-op, re-roll a new
  choice, or grant a small fallback XP bonus? Default: no-op. Confirm
  at US-001 review.
- **`LevelUpResolvedEvent` shape.** Current event has
  `weaponKind: number`. For an item pickup, do we (a) keep
  `weaponKind: -1` + add `itemKind: number`, (b) rename to
  `picked: { type, index }`, or (c) keep `weaponKind` for the
  weapon-only path and add a parallel `level_up_resolved_item`
  event? Confirm at US-001.
- **HP heal on Apple of Idun pickup.** Heal for the full diff between
  old and new maxHp (recommended), heal for half, or no heal? Affects
  feel — a generous heal at low HP is a strong defensive pick.
- **Item icons.** Emoji placeholders (🛡️/⚡/❤️/🥾/🔍/🐰), simple
  geometric shapes, or no icons (text-only) for M9? Defer to US-007.
- **Apple of Idun multiplier interaction with `player.hp` at low HP.**
  If a player is at HP 1 and picks Apple of Idun, do they get healed
  to (old maxHp - 1) + heal_amount? Or do they STAY at HP 1 and just
  have a higher cap? Default: heal for the diff (so HP increases by
  the amount maxHp increased). Confirm at US-001.
