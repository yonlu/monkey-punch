# PRD: Milestone 8 — Six New Weapons (Ragnarok-Inspired) + Status Effects

## 1. Introduction / Overview

Milestone 7 made the world genuinely 3D. This milestone is the first
milestone where the work is mostly **content**: six new weapons, taking
their names and flavor from Ragnarok Online's iconic weapons and their
mechanics from genre peers (HoloCure, Vampire Survivors, Megabonk).

Two of the new weapons (Kronos, Bloody Axe) require a piece of
infrastructure that does not yet exist: enemy status effects (slow,
blood-pool DoT). That is genuinely architectural work and is sequenced
explicitly in the implementation order.

The hypothesis being tested is that the weapon-table abstraction proven
out in Milestone 5 can absorb six new weapons across four behavior kinds
(`projectile`, `melee_arc`, `aura`, `boomerang`) without any name-based
branching in tick or render code (CLAUDE.md rule 12). If it cannot, the
abstraction is wrong, and we discover that here and fix it before
piling new content on top.

All gameplay logic stays in `shared/rules.ts` (rule 4); all synced
state stays in `shared/schema.ts` (rule 2); the seeded PRNG remains the
sole source of randomness for gameplay outcomes (rule 6); the tick
order in rule 11 is preserved.

## 2. Goals

- Add six new weapons across four behavior kinds: `projectile`
  (Gakkung Bow, Ahlspiess), `melee_arc` (Damascus, Claymore), `aura`
  (Kronos), `boomerang` (Bloody Axe).
- Extend the existing `projectile` behavior to support targeting modes
  (`nearest | furthest | facing`), mild homing, and pierce — without
  breaking Bolt.
- Add a minimal but cleanly-shaped enemy status effect system (slow +
  per-enemy-per-pool DoT) that future weapons can reuse.
- Expand the level-up choice pool from 2 weapons to 8.
- Distinct visual identity per weapon (placeholder fidelity is fine —
  the bar is "feels mechanically distinct," not "looks AAA").
- Architectural compliance: zero name-based branching in tick or render
  code (rule 12). Behavior dispatches on `behavior.kind` only.
- Determinism: all targeting, crit rolls, and projectile/boomerang
  trajectories are bit-identical across server and clients (rule 6).
- Performance: 200 enemies + 2 players each running 4–5 weapons holds
  60fps client and 20Hz server.

## 3. User Stories

The implementation is sequenced as 14 stories: 12 implementation
stories + 2 explicit human-checkpoint stories that block forward
progress.

### US-001: 🛑 BLOCKING — Architecture review checkpoint

**Description:** As the project owner (Luke), I need to review the
refactored `WeaponBehavior` discriminated union, the full 8-weapon
table including `perLevel` arrays, and the schema additions for
status effects BEFORE any implementation work. This is where
abstraction issues surface; better to catch them in review than after
six weapons are wired up.

**Acceptance Criteria:**
- [ ] A design document or PR-stub presents:
  - [ ] The refactored `WeaponBehavior` union including the four kinds
    (`projectile`, `orbit`, `melee_arc`, `aura`, `boomerang`) and all
    new fields on `projectile` (`targeting`, `homingTurnRate`,
    `pierceCount`)
  - [ ] The full weapon table for all 8 weapons (Bolt, Orbit, Gakkung
    Bow, Damascus, Claymore, Ahlspiess, Bloody Axe, Kronos) with base
    constants and `perLevel` arrays
  - [ ] Schema additions: `Enemy.slowMultiplier`, `Enemy.slowExpiresAt`,
    new `BloodPool` schema, `RoomState.bloodPools: MapSchema<BloodPool>`
  - [ ] New message types: `melee_swipe`, `boomerang_thrown`
  - [ ] The CLAUDE.md note to add: "if we add more than 2 status effect
    kinds, refactor to `ArraySchema<StatusEffect>` per enemy"
- [ ] Luke has explicitly approved OR provided concrete changes that
  have been incorporated into the proposal
- [ ] No work on US-002+ begins until this story is closed

### US-002: Refactor `WeaponBehavior` (extended projectile params, non-regression)

**Description:** As the simulation, I need the existing `projectile`
behavior to support targeting modes, mild homing, and pierce — and I
need Bolt and Orbit to still behave exactly as they do today.

**Acceptance Criteria:**
- [ ] `WeaponBehavior` in `packages/shared/src/weapons.ts` extends the
  `projectile` arm with: `targeting: "nearest" | "furthest" | "facing"`,
  `homingTurnRate: number` (rad/s; 0 = straight line), `pierceCount:
  number` (-1 = infinite)
- [ ] Bolt's existing definition updated with `targeting: "nearest"`,
  `homingTurnRate: 0`, `pierceCount: 1` — i.e. unchanged behavior
- [ ] Orbit unchanged
- [ ] `tickWeapons` and `tickProjectiles` in `shared/rules.ts` updated
  to read the new fields generically — no name-based branching (rule 12)
- [ ] Per-projectile state tracks `pierceRemaining` so a pierce projectile
  decrements on each hit and despawns at 0 (or never, if -1)
- [ ] Per-projectile state tracks `enemyHitCooldowns` (Map<enemyId, tick>)
  for projectiles with `hitCooldownPerEnemy > 0` — same mechanism Orbit
  already uses
- [ ] Vitest: existing Bolt tests pass unchanged (non-regression)
- [ ] Vitest: a projectile with `homingTurnRate > 0` adjusts its velocity
  toward target each tick, capped by the turn rate (deterministic given
  fixed inputs)
- [ ] Vitest: targeting modes — given fixed enemy positions and player
  facing, `"nearest"`, `"furthest"`, and `"facing"` each select the
  correct enemy / direction
- [ ] `pnpm typecheck` passes; `pnpm test` passes in shared and server

### US-003: Gakkung Bow (long-range homing, furthest targeting)

**Description:** As a player, I want a bow weapon that picks off
distant enemies, so positioning (letting a tail of enemies build up)
is rewarded.

**Acceptance Criteria:**
- [ ] Weapon definition added to the weapon table:
  ```ts
  { name: "Gakkung Bow",
    behavior: { kind: "projectile", speed: 28, lifetime: 1.2,
                targeting: "furthest", homingTurnRate: Math.PI * 0.8,
                pierceCount: 1 },
    cooldown: 0.85, damage: 18, hitRadius: 0.4 }
  ```
- [ ] `perLevel` array for L1–L5: increasing damage; `pierceCount` rises
  to 2 at L3 and 3 at L5
- [ ] Targeting picks the **furthest** enemy within max range (range =
  `speed * lifetime`); the projectile homes toward the locked target with
  the configured turn rate
- [ ] If the locked enemy dies mid-flight, the projectile continues on
  its current heading (no re-target) — keeps determinism simple
- [ ] Pierce: passes through up to `pierceCount` enemies before despawning
- [ ] Client-side rendering: a thin elongated projectile (cylinder or
  line geometry), light wood/brown color, with a subtle trail behind it
  — visibly distinct from Bolt's white sphere
- [ ] Closed-form client simulation from the `fire` event payload only
  (rule 12) — `fire` payload includes locked target id so client homing
  matches server
- [ ] Vitest: with three enemies at distances 5, 10, 15 from the player,
  `targeting: "furthest"` locks the one at 15
- [ ] Vitest: a homing projectile with a moving target curves toward
  it, capped by `homingTurnRate`, deterministically across re-runs with
  the same seed
- [ ] Manual: a player with Gakkung Bow visibly fires arrows past nearer
  enemies to hit far ones
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-004: Ahlspiess (piercing line projectile)

**Description:** As a player, I want a spear that pierces through
entire enemy lines without stopping, so dense crowds become a
liability for them rather than for me.

**Acceptance Criteria:**
- [ ] Weapon definition added:
  ```ts
  { name: "Ahlspiess",
    behavior: { kind: "projectile", speed: 22, lifetime: 1.5,
                targeting: "facing", homingTurnRate: 0,
                pierceCount: -1 /* infinite */ },
    cooldown: 1.0, damage: 25, hitRadius: 0.5,
    hitCooldownPerEnemy: 0.2 }
  ```
- [ ] `perLevel`: increasing damage; visual scale increases at higher
  levels (handled in render)
- [ ] Targeting `"facing"`: spear travels along player's current facing
  direction at fire time (no homing)
- [ ] `pierceCount: -1` → never decrements, never despawns from hits;
  only despawns when `lifetime` expires
- [ ] `hitCooldownPerEnemy: 0.2` → same enemy can only be hit again
  after 0.2s of in-flight time; uses the same `enemyHitCooldowns`
  mechanism added in US-002
- [ ] Client rendering: a long thin spear (elongated cylinder),
  golden/silver, with a slight glow trail
- [ ] Vitest: a spear fired through a line of three enemies hits all
  three on the same tick, deals damage to each, does not despawn
- [ ] Vitest: a stationary enemy hit by a spear is hit at most once
  within the `hitCooldownPerEnemy` window
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-005: Add `melee_arc` behavior + `melee_swipe` event infrastructure

**Description:** As the simulation, I need a new behavior kind for
instant front-of-player arc hits, with a corresponding event for
client VFX.

**Acceptance Criteria:**
- [ ] `WeaponBehavior` extended with a `melee_arc` arm:
  ```ts
  { kind: "melee_arc"; arcAngle: number; range: number;
    critChance: number; critMultiplier: number; knockback?: number }
  ```
- [ ] `tickWeapons` arm for `melee_arc`: on cooldown expiry, picks all
  enemies within `range` of player whose bearing from player's facing
  is within `arcAngle / 2`, applies damage to each, rolls per-hit crit
  using the room PRNG (NOT `Math.random` — rule 6), applies optional
  knockback to each
- [ ] Damage emission via existing `damage_dealt` event (one per enemy
  hit), with an `isCrit` flag derived per-hit
- [ ] One `melee_swipe` event emitted per swing (not per hit) for
  client VFX:
  ```ts
  { type: "melee_swipe", ownerId: string, weaponKind: number,
    originX, originY, originZ, facingX, facingZ,
    arcAngle, range, isCrit: boolean, tick: number }
  ```
  (`isCrit` here is true if any hit in the swing crit'd, used to drive
  a brighter slash flash)
- [ ] `melee_swipe` added to `shared/messages.ts` (rule 3)
- [ ] No name-based branching in `tickWeapons` for `melee_arc` (rule 12)
- [ ] Knockback (when set): pushes hit enemies along the player→enemy
  vector by `knockback` units; capped to avoid teleporting them out of
  the world
- [ ] Vitest: `melee_arc` hits all enemies in arc and **no** enemies
  outside arc (boundary cases at exactly `arcAngle / 2`)
- [ ] Vitest: crit rolls are deterministic given a seeded PRNG —
  re-running with the same seed produces the same crit pattern
- [ ] Vitest: knockback moves hit enemies by the configured distance
  in the correct direction
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-006: Damascus (fast melee swipe with crits)

**Description:** As a player, I want a fast knife-style swipe that
crits often — high tempo, high reward.

**Acceptance Criteria:**
- [ ] Weapon definition added:
  ```ts
  { name: "Damascus",
    behavior: { kind: "melee_arc", arcAngle: Math.PI / 3,
                range: 2.2, critChance: 0.25, critMultiplier: 2.0 },
    cooldown: 0.35, damage: 12, hitRadius: 0 }
  ```
- [ ] `perLevel`: increasing damage and `critChance` per level
- [ ] Client rendering: brief curved slash sprite (thin curve, white-blue
  color), flashes for ~80ms in front of player on each swipe; slightly
  brighter / yellow on crit swings
- [ ] Crits emit damage numbers in **yellow** with a larger font size
  (see US-013)
- [ ] Manual: with Damascus, crits visibly trigger as yellow numbers
  on roughly 1 in 4 hits
- [ ] No name-based branching in render code (Damascus is rendered as a
  generic `melee_arc` with parameters from the weapon def, rule 12)
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-007: Claymore (wide slow arc with knockback)

**Description:** As a player, I want a heavy two-handed sword that
sweeps a wide arc, hits hard, and knocks enemies back — slow but
satisfying.

**Acceptance Criteria:**
- [ ] Weapon definition added:
  ```ts
  { name: "Claymore",
    behavior: { kind: "melee_arc", arcAngle: Math.PI * 0.9,
                range: 3.5, critChance: 0, critMultiplier: 1,
                knockback: 1.2 },
    cooldown: 1.4, damage: 45, hitRadius: 0 }
  ```
- [ ] `perLevel`: increasing damage and slightly increasing `arcAngle`
  per level
- [ ] No crit (`critChance: 0`) — the weapon is about reliable big hits
- [ ] Knockback set; hit enemies are pushed back ~1.2 units along
  player→enemy vector (uses the mechanism from US-005)
- [ ] Client rendering: wide sweeping slash sprite (larger and slower
  than Damascus), with a brief subtle screen flash on swing (no full
  screen shake — rule explicitly: defer shake to game-feel milestone)
- [ ] Manual: with Claymore, single swing visibly hits multiple
  enemies in a near-180° arc and pushes them back
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-008: 🛑 BLOCKING — Mid-milestone playtest checkpoint

**Description:** As the project owner (Luke), I need to play with all
four "simple" new weapons live (Gakkung Bow, Ahlspiess, Damascus,
Claymore — alongside Bolt and Orbit) before committing to the more
architectural Kronos and Bloody Axe work. Six weapons in the choice
pool will already significantly change run feel; if anything is
broken at this point, fix it now before adding status effects on top.

**Acceptance Criteria:**
- [ ] Two clients can join, level up, and see all 6 weapons (Bolt,
  Orbit, Gakkung Bow, Ahlspiess, Damascus, Claymore) appear in choice
  pools across multiple runs
- [ ] Each of the 4 new weapons, picked: visibly works, deals damage,
  is mechanically distinct from the others
- [ ] No regressions: Bolt and Orbit still behave the same as before
  the milestone
- [ ] No name-based branching exists anywhere in `tickWeapons`,
  `tickProjectiles`, or client weapon renderers (`grep -E
  'name === "(Gakkung|Ahlspiess|Damascus|Claymore|Bolt|Orbit)"'` over
  `packages/{shared,server,client}/src` returns nothing)
- [ ] Two-client determinism check: damage numbers, projectile paths,
  and crit patterns match between two clients viewing the same room
- [ ] `pnpm typecheck` passes; `pnpm test` passes
- [ ] Luke has explicitly approved feel (or filed concrete tuning
  changes that have been applied)
- [ ] No work on US-009+ begins until this story is closed

### US-009: Enemy status effect infrastructure (slow) + CLAUDE.md note

**Description:** As the simulation, I need a minimal status effect
system so weapons can apply persistent debuffs to enemies — starting
with `slow`, but shaped so future effects (burn, freeze, stun) can be
added without ripping anything out.

**Acceptance Criteria:**
- [ ] `Enemy` schema gains:
  - [ ] `slowMultiplier: number` (default `1.0`)
  - [ ] `slowExpiresAt: number` (server tick at which slow expires; `-1`
    = no slow active)
- [ ] `applySlow(enemy, multiplier, durationTicks, currentTick)` helper
  in `shared/rules.ts` — if a stronger slow is already active (smaller
  `slowMultiplier` and not yet expired), keep it; otherwise overwrite
- [ ] New `tickStatusEffects(state, dt, currentTick)` function: for
  each enemy whose `slowExpiresAt < currentTick && slowExpiresAt !== -1`,
  reset to `slowMultiplier = 1.0, slowExpiresAt = -1`
- [ ] `tickEnemies` movement multiplied by `enemy.slowMultiplier`
- [ ] `tickStatusEffects` inserted into the rule 11 tick order — placed
  immediately before `tickEnemies` so movement uses fresh slow state
  (and the rule 11 docstring in CLAUDE.md is updated to reflect the new
  order — load-bearing per CLAUDE.md, must be explicit)
- [ ] Universal early-out invariant respected: `tickStatusEffects` early
  returns if `state.runEnded` (CLAUDE.md rule 11)
- [ ] CLAUDE.md amended with a note in the "Things NOT to do" section
  or a new short subsection: "If we add more than 2 status effect
  kinds, refactor `Enemy` slow fields into a generic
  `ArraySchema<StatusEffect>` (kind, magnitude, expiresAt). The
  current per-effect fields are deliberate for one effect; do not pile
  on a 3rd."
- [ ] Vitest: `applySlow` with a stronger active slow does not get
  overridden by a weaker one
- [ ] Vitest: a slowed enemy moves at `speed * slowMultiplier` for
  exactly `durationTicks`, then restores to full speed on the next tick
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-010: `aura` behavior + Kronos

**Description:** As a player, I want a persistent damaging aura around
me that also slows enemies inside it — a defensive, area-control weapon.

**Acceptance Criteria:**
- [ ] `WeaponBehavior` extended with an `aura` arm:
  ```ts
  { kind: "aura"; radius: number; tickInterval: number;
    slowMultiplier: number }
  ```
- [ ] Weapon definition added:
  ```ts
  { name: "Kronos",
    behavior: { kind: "aura", radius: 3.5, tickInterval: 0.5,
                slowMultiplier: 0.6 },
    cooldown: 0, damage: 8, hitRadius: 0 }
  ```
- [ ] `perLevel`: increasing damage; increasing `radius` per level;
  stronger slow (smaller `slowMultiplier`) at L4+
- [ ] `tickWeapons` arm for `aura`: cooldown is unused; instead, the
  per-weapon-instance tracks `nextTickAt`. When `currentTick >=
  nextTickAt`: damage all enemies within `radius` of owner, apply
  `slow` (`durationTicks` short, e.g. 0.3s of ticks — re-applied each
  aura tick while enemy remains in radius), schedule next tick
- [ ] Damage emission via `damage_dealt` events (one per affected
  enemy) — no separate `aura_tick` event needed
- [ ] Slow-tick damage numbers rendered in **icy blue** color (US-013)
- [ ] Closed-form client simulation: aura is a function of `(state.tick,
  player position, weapon level)` (rule 12) — the dome visual updates
  every render frame, no per-frame schema sync
- [ ] Client rendering: translucent dome/cylinder centered on player,
  blue-purple tint, `MeshBasicMaterial { transparent: true, opacity: ~0.15 }`
  on `CylinderGeometry` (or `SphereGeometry`), parented to the player
  visual; subtle additive sparkle particles inside; optional faint
  rotating clock-hand sprite for the time motif (placeholder
  acceptable)
- [ ] Vitest: aura damages all enemies inside radius and **no** enemies
  outside radius
- [ ] Vitest: aura damage ticks at exactly `tickInterval` cadence
  (deterministic)
- [ ] Vitest: enemies inside aura are slowed; enemies that walk out
  recover full speed within ~0.3s
- [ ] Server integration: 5 enemies walk into a Kronos aura; after 5
  seconds, all 5 have taken expected total damage and have current
  `slowMultiplier < 1`
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-011: `boomerang` behavior + `BloodPool` schema/tick

**Description:** As the simulation, I need a behavior kind that throws
a projectile on an outbound-then-return path, plus a `BloodPool`
schema for deterministic damaging trails that future blood-axe-style
weapons (and any future ground-effect weapons) can reuse.

**Acceptance Criteria:**
- [ ] `WeaponBehavior` extended with a `boomerang` arm:
  ```ts
  { kind: "boomerang"; outboundDistance: number; outboundSpeed: number;
    returnSpeed: number; leavesBloodPool: boolean }
  ```
- [ ] `BloodPool` schema in `shared/schema.ts`: `id: number`, `x: number`,
  `z: number`, `expiresAt: number` (tick), `ownerId: string`
- [ ] `RoomState.bloodPools: MapSchema<BloodPool>` (rule 2)
- [ ] Spawner counter `nextBloodPoolId` lives on the GameRoom instance,
  not on `RoomState` (rule 10 spirit — server-only counters do not
  pollute schema)
- [ ] `tickWeapons` arm for `boomerang`: on cooldown expiry, throws an
  axe in player facing direction; emits one `boomerang_thrown` event:
  ```ts
  { type: "boomerang_thrown", fireId: number, ownerId: string,
    originX, originY, originZ, dirX, dirZ, outboundDistance,
    outboundSpeed, returnSpeed, leavesBloodPool: boolean, tick: number }
  ```
- [ ] `boomerang_thrown` added to `shared/messages.ts` (rule 3)
- [ ] Server-side per-axe state tracks phase (`outbound | returning`),
  position, and `enemyHitCooldowns` (Map<enemyId, tick>)
- [ ] Closed-form trajectory: position at time `t` is a deterministic
  piecewise function of (`outboundDistance`, `outboundSpeed`,
  `returnSpeed`, fire origin, direction, owner's current position for
  the return phase). Documented in a comment so client and server agree
- [ ] Client simulates the trajectory locally from the
  `boomerang_thrown` event payload only (rule 12)
- [ ] If `leavesBloodPool` is true: spawner places blood-pool decals at
  fixed intervals along the outbound path (e.g. every 1.5 units) by
  inserting `BloodPool` entries with `expiresAt = currentTick + ~30`
  ticks (≈1.5s)
- [ ] New `tickBloodPools(state, dt, currentTick, emit)`:
  - removes pools whose `expiresAt < currentTick`
  - for each enemy overlapping a pool, applies DoT every 0.3s
    (per-pool-per-enemy cooldown stored server-side in a Map; not on
    schema), emits `damage_dealt`
- [ ] `tickBloodPools` inserted into rule 11 tick order between
  `tickProjectiles` and `tickGems` (so this-tick deaths from pools
  drop pickups before pickup checks). CLAUDE.md rule 11 docstring is
  updated to reflect the new order.
- [ ] `tickBloodPools` early-returns if `state.runEnded` (rule 11)
- [ ] Vitest: boomerang trajectory — given fixed parameters, position
  at any `t` matches the expected piecewise formula
- [ ] Vitest: a single boomerang does not double-hit the same enemy on
  outbound + return within `hitCooldownPerEnemy`
- [ ] Vitest: blood pools deal DoT to overlapping enemies every 0.3s
  and expire after their lifetime
- [ ] Vitest: same seed → identical blood-pool placement (determinism)
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-012: Bloody Axe (boomerang weapon, level 3+ leaves blood pools)

**Description:** As a player, I want an axe that flies out, returns,
and at higher levels leaves a damaging blood trail behind it.

**Acceptance Criteria:**
- [ ] Weapon definition added:
  ```ts
  { name: "Bloody Axe",
    behavior: { kind: "boomerang", outboundDistance: 7,
                outboundSpeed: 14, returnSpeed: 18,
                leavesBloodPool: false /* true at L3+ via perLevel */ },
    cooldown: 1.6, damage: 30, hitRadius: 0.7,
    hitCooldownPerEnemy: 0.3 }
  ```
- [ ] `perLevel`: increasing damage; `leavesBloodPool` becomes `true`
  at L3 (the level system overrides this field per the existing
  perLevel mechanism)
- [ ] Client rendering: chunky spinning axe shape (placeholder mesh:
  `BoxGeometry` or simple custom geometry), red, with a red particle
  trail; spinning rotation around its travel axis
- [ ] Blood pool client rendering: translucent red splotch decal on
  the ground (a flat circle / `PlaneGeometry` rotated horizontal,
  textured or just `MeshBasicMaterial { color: red, transparent: true,
  opacity: 0.5 }`)
- [ ] Manual: a Bloody Axe at L1 visibly throws out, slows, returns;
  at L3+ leaves visible red splotches that damage enemies walking
  through
- [ ] Two-client determinism: both clients see identical axe trajectory
  AND identical blood-pool positions (boundary check that the
  placement uses the room PRNG / deterministic spacing, not
  `Math.random` — rule 6)
- [ ] No name-based branching: rendering is generic on `boomerang` and
  on the `BloodPool` schema entries (rule 12)
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-013: Damage number color coding + per-level scaling tuning pass

**Description:** As a player, I want damage numbers to immediately
communicate which weapon hit and what kind of hit it was (crit, slow
tick, pierce). And I want to make sure all 6 new weapons' per-level
scaling values land at sensible starting points for playtest.

**Acceptance Criteria:**
- [ ] `damage_dealt` event (or a derived field on the client) carries
  enough info for clients to color the number:
  - [ ] Crit hits (Damascus): **yellow**, larger font (~1.4× size)
  - [ ] Status-applying hits (Kronos slow tick): **icy blue**
  - [ ] Pierce hits (Ahlspiess): **white with a subtle additive glow**
  - [ ] Default: **white**
- [ ] Color/size derivation logic lives on the client and is dispatched
  generically (e.g. on a `tag` enum field in `damage_dealt`, not by
  `weaponName === "Kronos"`) — rule 12
- [ ] All 6 new weapons have `perLevel` arrays filled in for L1–L5 with
  the values implied by §3 of this PRD (or refined values from the
  US-001 review). Documented inline in `weapons.ts`
- [ ] Level-up choice pool now contains 8 weapons (Bolt, Orbit, plus
  the 6 new), equally weighted by default
- [ ] Manual: across many runs, each of the 8 weapons is offered at
  least once in choice pools (sanity check on the equal-weighting)
- [ ] Manual: pick a weapon, level it to L5, verify the per-level
  scaling visibly takes effect (more pierce / wider arcs / larger
  radius / stronger slow)
- [ ] `pnpm typecheck` passes; `pnpm test` passes

### US-014: 🛑 BLOCKING — Final playtest checkpoint

**Description:** As the project owner (Luke), I want to play a real
session with friends before declaring the milestone done. Bullet-heaven
balance is iterative — this checkpoint is for "all weapons work and
feel mechanically distinct," NOT for tuned balance. Concrete bugs are
fixed; balance feedback is captured for a follow-up tuning pass.

**Acceptance Criteria:**
- [ ] Real multi-client session played end-to-end
- [ ] All 8 weapons confirmed to (a) appear in choice pools, (b) deal
  damage when picked, (c) have a visibly distinct visual identity
- [ ] No "obviously broken" outcomes: no weapon does zero damage; no
  weapon one-shots everything; no weapon crashes the client or server
- [ ] Performance verified: 200 enemies, 2 players each running 4–5
  weapons simultaneously, 60fps client, 20Hz server stable
- [ ] Two-client determinism verified by direct observation: damage
  numbers, projectile/boomerang/aura visualizations match between two
  clients
- [ ] Balance feedback captured (notes file or commit message) for a
  separate tuning milestone — not addressed in this milestone
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] CLAUDE.md updated (status effect note from US-009)
- [ ] Final commit on `main` closes US-014 and the milestone

## 4. Functional Requirements

- **FR-1:** `WeaponBehavior` is a discriminated union with arms
  `projectile`, `orbit`, `melee_arc`, `aura`, `boomerang`. Behavior
  dispatch in tick and render code uses **only** `behavior.kind` —
  no name-based branching anywhere.
- **FR-2:** `projectile` behavior supports `targeting: "nearest" |
  "furthest" | "facing"`, `homingTurnRate: number`, `pierceCount:
  number` (-1 = infinite). Existing Bolt is expressed via these
  fields without changing its observable behavior.
- **FR-3:** `melee_arc` behavior fires an instant arc-hit on cooldown:
  selects all enemies within `range` and within `arcAngle / 2` of
  player facing, applies damage to each, optionally rolls per-hit
  crit using the room PRNG, optionally applies knockback.
- **FR-4:** `aura` behavior maintains a persistent damage tick around
  the player at `tickInterval`, damaging all enemies within `radius`
  and re-applying a short slow each tick.
- **FR-5:** `boomerang` behavior throws a projectile on an outbound
  trajectory of `outboundDistance` at `outboundSpeed`, then returns
  to the owner at `returnSpeed`. Hits use per-axe-per-enemy hit
  cooldown.
- **FR-6:** `Enemy` schema gains `slowMultiplier: number` (default
  `1.0`) and `slowExpiresAt: number` (default `-1`). `tickEnemies`
  multiplies movement by `slowMultiplier`. `tickStatusEffects`
  expires slows when `slowExpiresAt < currentTick`.
- **FR-7:** `BloodPool` schema (`id, x, z, expiresAt, ownerId`) is
  added; `RoomState` gains `bloodPools: MapSchema<BloodPool>`.
  `tickBloodPools` removes expired pools and applies DoT to
  overlapping enemies on a per-pool-per-enemy cooldown.
- **FR-8:** Tick order from CLAUDE.md rule 11 is amended to:
  `tickPlayers → tickStatusEffects → tickEnemies → tickContactDamage
  → tickRunEndCheck → tickWeapons → tickProjectiles → tickBloodPools
  → tickGems → tickXp → tickLevelUpDeadlines → tickSpawner`.
  CLAUDE.md is updated to reflect this. Universal `if (state.runEnded)
  return;` early-out applies to every new tick function.
- **FR-9:** New server→client events: `melee_swipe`, `boomerang_thrown`.
  Both added to `shared/messages.ts` as new arms in the discriminated
  message union (rule 3).
- **FR-10:** Level-up choice pool expanded from 2 weapons to 8 (Bolt,
  Orbit, Gakkung Bow, Damascus, Claymore, Ahlspiess, Bloody Axe,
  Kronos). Equal weighting. Each weapon supports L1–L5 via the
  existing `perLevel` mechanism from Milestone 5.
- **FR-11:** All client-side weapon simulations are closed-form
  functions of their event payloads (`fire`, `melee_swipe`,
  `boomerang_thrown`) or of `(state.tick, player position, weapon
  level)` for the aura — never a per-frame schema sync (rule 12).
- **FR-12:** All gameplay randomness (crit rolls, blood-pool
  placement determinism, etc.) goes through the seeded PRNG on
  `RoomState` — no `Math.random` in gameplay code (rule 6).
- **FR-13:** Damage numbers are color-coded on the client based on a
  generic tag/enum field (crit / status / pierce / default), not by
  weapon name.
- **FR-14:** CLAUDE.md gains a note explicitly cautioning that adding
  a 3rd status effect kind requires refactoring `Enemy` slow fields
  to `ArraySchema<StatusEffect>`.

## 5. Non-Goals (Out of Scope)

- **No items / passive accessories** (movement speed, damage
  multiplier, magnet range, max HP, XP gain). Queued for a separate
  milestone.
- **No weapon evolutions** (combine weapon + item to unlock evolved
  version). Milestone 9+ candidate.
- **No weapon synergies** (special interactions when multiple
  specific weapons are equipped together). Out of scope.
- **No procedural weapon generation, no rarity tiers, no random
  stats.** Fixed weapon table.
- **No new enemies.** Same enemy roster as Milestones 6/7.
- **No animated character art.** Cubes/cones still.
- **No sound.** (Yes, really. Sound milestone is queued separately.)
- **No screen shake** on Claymore (or any other) swings. Defer to a
  game-feel milestone for consistency across all weapons.
- **No PvP, no friendly fire.** Damascus crits and all other weapons
  hit only enemies, never other players. Hit detection in every new
  behavior must check enemies only.
- **No manual fire / aim direction control** beyond what already
  exists in M7. All weapons remain auto-firing on their cooldowns;
  `melee_arc` and Ahlspiess use player facing direction (which is
  already derived from movement direction in M7).
- **No rebalancing of Bolt or Orbit.** Only ADD new content. If new
  weapons make Bolt feel weak by comparison, that is acceptable —
  Bolt is the starter weapon and should be modest.
- **No third status effect kind in this milestone.** Slow only. If
  a future weapon needs burn/freeze/stun, refactor to
  `ArraySchema<StatusEffect>` first (per the CLAUDE.md note from
  US-009).
- **No final balance pass.** "All weapons work and feel mechanically
  distinct" is the bar. Numerical balance is a follow-up tuning pass
  driven by playtest feedback.

## 6. Design Considerations

### Visual identity (per weapon)

Bundled into each weapon's user story (per the chosen PRD shape).
Recap:

- **Gakkung Bow:** thin elongated cylinder/line, light wood-brown,
  with a subtle trail.
- **Damascus:** brief curved slash sprite in front of player
  (~80ms), white-blue, brighter on crit.
- **Claymore:** wide sweeping slash sprite (larger, slower), with
  a brief subtle screen flash on swing.
- **Ahlspiess:** long thin spear (elongated cylinder),
  golden/silver, with a slight glow trail.
- **Bloody Axe:** chunky spinning axe (placeholder box geometry is
  fine), red, with red particle trail. Blood pools as translucent
  red splotch decals.
- **Kronos:** translucent dome/cylinder around player (`MeshBasic`
  with `transparent: true, opacity: ~0.15`), blue-purple, with
  optional sparkle particles or a subtle clock-hand sprite inside.

### Damage number color coding

| Tag       | Color     | Size  | Triggered by                       |
|-----------|-----------|-------|------------------------------------|
| `crit`    | yellow    | 1.4×  | Damascus crit hits                 |
| `status`  | icy blue  | 1.0×  | Kronos slow ticks                  |
| `pierce`  | white+glow| 1.0×  | Ahlspiess hits                     |
| `default` | white     | 1.0×  | everything else                    |

The tag is set on the server and carried in `damage_dealt`. Client
dispatches color/size from the tag — no name-based branching.

### Visual fidelity bar

Placeholder fidelity is explicitly fine. The goal of this milestone
is mechanical distinction, not visual polish. A polish pass is
queued for after the animated character work lands. Don't go
hunting for asset packs this session.

## 7. Technical Considerations

- **No new shared deps.** All new weapons fit within `@colyseus/schema`,
  the existing PRNG, and the existing `simplex-noise`/`alea` for
  terrain. Rule (Stack) holds.
- **Status effects on schema (deliberate simplicity).** Per the
  decision recorded in this PRD's clarifying questions, the
  status-effect data lives as direct fields on `Enemy`
  (`slowMultiplier`, `slowExpiresAt`) rather than as a generic
  `ArraySchema<StatusEffect>`. This is correct for one effect kind
  and explicitly does not scale beyond two — captured in CLAUDE.md
  by US-009.
- **DoT state lives server-only.** Per-pool-per-enemy DoT cooldown
  Maps and per-projectile `enemyHitCooldowns` Maps are server-only
  state, NOT in the schema. Clients derive damage events from
  `damage_dealt` only. This mirrors the existing pattern (rule 10
  spirit — server-only counters do not pollute schema).
- **Server-only counters on the Room instance.** `nextBloodPoolId`
  and any new per-tick auxiliary counters live on `GameRoom`, not
  on `RoomState` (rule 10).
- **Deterministic boomerang return.** The return phase tracks the
  owner's current position. To stay deterministic across clients,
  client-side simulation reads the owner's interpolated position
  identically on both clients (the same interpolation buffer that
  M7 uses for remote players). Document the math in a comment so
  divergence is obvious if it ever happens.
- **Deterministic blood-pool placement.** Pool positions are placed
  at fixed `outboundDistance / N` intervals along the boomerang's
  outbound path. No PRNG draw needed; if jitter is desired, it must
  use the room PRNG (rule 6) — but the simpler fixed-interval is
  preferred.
- **Tick order is load-bearing.** `tickStatusEffects` before
  `tickEnemies` (so movement uses fresh slow state).
  `tickBloodPools` after `tickProjectiles` and before `tickGems` (so
  this-tick pool deaths drop pickups before pickup checks). Update
  CLAUDE.md rule 11 with the new order — it is part of the
  architectural contract, not just implementation detail.
- **Tick functions early-out on `runEnded`.** Universal invariant
  from rule 11. Every new tick function (`tickStatusEffects`,
  `tickBloodPools`) starts with `if (state.runEnded) return;`.
- **Performance.** With 200 enemies and a Kronos aura plus a
  Bloody Axe + 5–10 active blood pools, the inner loops (aura damage,
  blood-pool overlap, melee_arc enemy filter) are O(N_enemies) per
  effect per tick. Acceptable at the milestone target. Spatial
  indexing is NOT in scope; if perf budget is missed, narrow the
  hottest loop with a simple bounding-box pre-check before doing the
  full radius/angle math.

## 8. Success Metrics

- Six new weapons shipped, all in the level-up choice pool, all
  individually playable end-to-end.
- Zero name-based branching anywhere in `tickWeapons`,
  `tickProjectiles`, `tickStatusEffects`, `tickBloodPools`, or
  client renderers (`grep` check passes — see US-008).
- Bolt and Orbit pre-milestone tests pass unchanged
  (non-regression).
- All Vitest cases listed in stories pass; full `pnpm test` passes.
- `pnpm typecheck` passes.
- 60fps client / 20Hz server holds at 200 enemies + 2 players each
  running 4–5 weapons.
- Two-client determinism verified for every new behavior (projectile
  homing, melee crit pattern, aura tick cadence, boomerang trajectory,
  blood-pool placement).
- Luke's subjective feel approval at US-008 (mid-milestone) and
  US-014 (final).

## 9. Open Questions

- **Boomerang return target on owner death.** If the owner of a
  Bloody Axe dies/is downed mid-flight, where does the axe return
  to? Suggested default: it continues to the owner's last position
  (frozen target) until lifetime expires, then despawns. Confirm at
  the US-001 architecture review.
- **Slow stacking semantics.** The PRD says "if a stronger slow is
  already active, keep the stronger one." If a future weapon
  applies a *longer* but *weaker* slow, should we keep the stronger
  one until expiry then fall through to the weaker one? Not in
  scope this milestone (only one slow source: Kronos), but worth
  noting for the CLAUDE.md status-effect note.
- **Pierce + homing interaction (Gakkung).** A homing projectile
  with `pierceCount > 1` could in principle homing-loop back to the
  same target after piercing. The `enemyHitCooldowns` mechanism
  prevents the same enemy from being hit twice in a tight window,
  but if the projectile lifetime is long, it could re-acquire after
  the cooldown. Acceptable behavior or a bug? Lean toward
  "acceptable, do not lock targeting after fire" but capture in
  US-001 review.
- **Aura through walls / terrain.** Kronos's radius is a flat 2D
  distance (or 3D?). If 3D, on hilly terrain a Kronos player on top
  of a hill with enemies in the valley below may have inconsistent
  effective range. Suggest 3D distance for consistency with
  projectile hit detection in M7. Confirm at US-001.
- **Items milestone slot.** Out of scope here, but worth confirming
  Items is the next milestone (M9) so the level-up choice flow
  decisions made here (8-weapon equal-weighted pool) anticipate
  weapon+item presentation in the same UI.
