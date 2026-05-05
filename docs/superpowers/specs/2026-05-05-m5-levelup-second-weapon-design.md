# M5 — Level-up flow and a second weapon (Orbit)

**Status:** Design — approved 2026-05-05. Ready for implementation plan.

## Goal

Two outcomes, both load-bearing for everything that follows:

1. **A second weapon — "Orbit" — that proves the M4 weapon table isn't
   secretly Bolt-shaped.** Orbit is mechanically as different from Bolt
   as the fire-and-hit protocol allows: persistent (no lifetime), no
   target (rotates around the player), no despawn on hit (multi-hit),
   gated by per-enemy hit cooldown. If `tickWeapons` needs a name-based
   special case for Orbit, the architecture is wrong; the right shape is
   the one we land in this milestone.
2. **A non-blocking, per-player, timed-default level-up flow.** When a
   player crosses an XP threshold they're offered three weapon choices.
   Other players keep playing. The leveling player keeps moving. After
   10 seconds with no choice, choice 0 is auto-picked. This is the
   pattern that makes 10-player co-op viable; pause-on-level-up does
   not work above 1-2 players.

After M5: structurally complete-ish — players, enemies, two weapons that
level up, XP loop. Future weapons are content; future enemy variety is
the next architectural milestone.

## Non-goals

- No third weapon. Two examples is what proves the abstraction; three
  adds scope without resolving any new architectural question.
- No weapon evolutions, synergies, or item passives. Two weapons, each
  upgradeable.
- No rarity on choices. All three offers are random, equally weighted.
- No reroll, banish, skip, or "level-skip" mechanic.
- No pause-on-level-up. Non-negotiable.
- No global / shared level. Per-player XP, per-player levels, per-player
  choices.
- No persistent meta-progression.
- No sound (deferred to the audio milestone).
- No screen shake, hit-stop, gem arcs, or major game-feel work. The
  small level-up flash is the only game-feel addition this session;
  everything else belongs to the dedicated game-feel pass.

## Architectural decisions

These are load-bearing. Each was either resolved in the brief or in
brainstorming. The implementation plan treats them as fixed.

### AD1. `tickWeapons` dispatches on `behavior.kind`, not weapon name

A single `tickWeapons` walks `players × weapons` and switches on
`def.behavior.kind`. There are exactly two arms: `"projectile"` (decrement
cooldown, fire if ready, push projectile — the existing M4 path) and
`"orbit"` (compute orb world positions, point-circle vs each enemy
— see AD8 for why point not swept — gate by per-enemy hit cooldown).
No name lookups. No `if (def.name === "Orbit")`. Adding a third weapon
of an existing behavior kind is zero new tick code; adding a fourth
behavior is exactly one new `case`.

Why not separate `tickProjectileWeapons` + `tickOrbitHits`: spreads the
players×weapons walk for no benefit, and both functions still ultimately
filter by behavior. Why not strategy objects: over-engineered for two
behaviors. The behavior switch is the right shape.

This decision is the actual point of the milestone. Any deviation in
implementation that re-introduces name-based branching invalidates the
milestone's purpose; if the cleanest implementation seems to require
name branching, that's the signal to revisit AD3 (the data shape), not
to add the branch.

### AD2. Orbit determinism is "client computes from synced state"

Orb world positions are not synced. Both clients compute them from:

```
angle  = (state.tick / TICK_RATE) * orbAngularSpeed + i * (2π / orbCount)
worldX = playerRenderX + cos(angle) * orbRadius
worldZ = playerRenderZ + sin(angle) * orbRadius
```

`state.tick` is already synced on `RoomState`. Two clients reading the
same tick produce the same orb angle. Server hit detection uses the
same angle formula but with `player.x/z` (authoritative tick-aligned
position).

`playerRenderX/Z` is the *render* position — predicted-local for the
local player, interpolated remote for others (matches `PlayerCube`). This
gives orbs that visually stick to the player at all times. The tiny
discrepancy from server hit positions (server uses authoritative
tick-aligned `player.x/z`) is invisible at 60fps and is the correct
trade — local visual responsiveness over rendering parity with the hit
oracle.

This is the pattern every future deterministic-client-simulation weapon
will follow (rotating saws, returning boomerangs, periodic auras, AoE
circles). Get it right here and the rest is content.

### AD3. WeaponDef is a discriminated union by behavior

```ts
type WeaponDef =
  | { name: string; behavior: { kind: "projectile"; targeting: "nearest" }; levels: ProjectileLevel[] }
  | { name: string; behavior: { kind: "orbit" };                              levels: OrbitLevel[] };
```

`ProjectileLevel` and `OrbitLevel` are non-overlapping. Each weapon's
`levels` array is shaped to its behavior, so the projectile arm of
`tickWeapons` cannot read an orb-only field (and TypeScript enforces
this). `levels[level - 1]` is the *complete* effective stats at that
level — no merge logic, no base+overrides. Five rows per weapon at
max level 5 is fully readable; if a stat is constant across levels, it
just repeats.

Rejected alternative: `Array<Partial<WeaponDef>>` overrides (spec
sketch). Adds a merge step at every read site without saving meaningful
data; for two weapons at small max level the supposed compactness is
nil.

Rejected alternative: per-stat scaling functions. Most flexible, least
readable; nobody can answer "what does Bolt L3 do" from the data.

### AD4. XP overflow is one level per tick, draining via re-ticks

If a player earns enough XP for multiple levels in a single tick, only
one level-up fires; the rest are absorbed by the next tick. `tickXp`
is gated by `!pendingLevelUp` — a player with an unresolved level-up
won't trigger another, so the choice doesn't get clobbered. Once
resolved (manually or by deadline), the next tick's `tickXp` re-checks
the threshold; if still over, fires another level-up immediately.

So a 3-level tick produces 3 sequential overlay choices, not a single
"+3 levels" event. This matches Vampire Survivors' UX and avoids a
state machine that has to remember a queue of pending level-ups.

`xpForLevel(level)` — XP required to advance from `level` to `level+1`
— is canonically `level * 5 + level * level`:

| from L | to L+1 | xpForLevel(L) |
|--------|--------|---------------|
| 1      | 2      | 6             |
| 2      | 3      | 14            |
| 3      | 4      | 24            |
| 4      | 5      | 36            |
| 5      | 6      | 50            |

(The brief gave example values 6/12/21 alongside this formula; that's
internally inconsistent. The formula is canonical, the example values
are not. Tests assert monotonicity, not specific values, so retuning is
free.)

Each enemy still drops 1 XP gem (no change from M4).

### AD5. RNG source is the room rng; tick order is load-bearing

Level-up choice generation uses the same `mulberry32(state.seed)` rng
that drives the spawner and debug bursts. Determinism holds because the
order of consumption is fixed by tick order:

```
tickPlayers → tickEnemies → tickWeapons → tickProjectiles → tickGems →
  tickXp → tickLevelUpDeadlines → tickSpawner
```

`tickXp` rolls choices for any player crossing a threshold (3 rolls per
level-up). `tickSpawner` consumes its rolls last. Reordering these would
fork the determinism between server and any future tooling that replays
from a seed; the order will be commented as load-bearing in code.

Choices are rolled with replacement. With two weapon kinds today, ~25%
of offer sets are all-same-kind ("three Bolt upgrades"). Once a third
kind exists this drops to 11% and stays there. Acceptable wart for a
milestone; reroll-on-collision adds RNG bookkeeping for a problem that
self-resolves in M6+.

### AD6. Level-up state is in the schema, not transient client state

Three `Player` schema fields drive the level-up flow:

```
pendingLevelUp:       boolean
levelUpChoices:       ArraySchema<number>   // 3 weapon-kind ints when pending, 0 otherwise
levelUpDeadlineTick:  uint32                // RoomState.tick at which auto-pick fires
```

Why on the schema rather than transient room data + broadcast events:
**reconnection.** Verification step 10 disconnects mid-overlay and
reconnects; on reconnect the client must show the *same* overlay with
the *same* deadline ticking down from the right value. Schema state
arrives automatically on resync; the overlay component reads from
schema each frame and re-shows when `pendingLevelUp` is true. No
client-side persistence, no special reconnect path.

The `level_up_offered` and `level_up_resolved` events still exist as
broadcasts (§Message protocol) — they let VFX components react cleanly
without diffing schema. But they are *redundant with* schema, not the
source of truth.

### AD7. Orbit per-enemy hit cooldown is a server-local store, not schema

A `Map<string, number>` keyed by `${playerId}:${weaponIndex}:${enemyId}`
holding the last-hit timestamp (`Date.now()`-style ms). Lives on
`GameRoom`, never in the schema — clients have no use for this value
and syncing it would balloon snapshot size for no reason.

`weaponIndex` is the player's `weapons[]` array index. Stable for the
lifetime of the weapon: we only push to `weapons`, never reorder or
splice, so an upgrade keeps the same index.

Eviction (defense in depth):

- **On enemy death:** `evictEnemy(enemyId)` called from inside both the
  projectile path (`tickProjectiles`) and the orbit branch of
  `tickWeapons` whenever an enemy is removed from `state.enemies`.
- **On player removal from schema:** `evictPlayer(playerId)` called from
  both `onLeave` paths in `GameRoom` — the `consented` early-return
  (immediate leave) and the `allowReconnection` catch block (grace
  expiry). Crucially, *not* called on the disconnect itself: a
  reconnect within the 30s grace window preserves the same sessionId
  and should preserve cooldowns.
- **Periodic sweep:** every 100 ticks (5s), drop entries whose age
  exceeds the longest cooldown configured (computed once from
  `WEAPON_KINDS` at startup). Defensive against any leak from a missed
  eviction path.

Worst-case size before sweep: 10 players × 6 max orbs × 300 enemies ≈
18,000 entries. Sweep is `Map` iteration; cheap enough at 5s cadence.

### AD8. Orbit hit detection runs inside `tickWeapons`, not as a sibling tick

Per AD1: `tickWeapons` walks players × weapons and dispatches by
`behavior.kind`. The orbit arm computes orb positions for the current
tick (server side, using authoritative `player.x/z` and `state.tick`),
swept-circle tests each orb position against each enemy, and applies
damage gated by the cooldown store. On a hit, same emit/death/gem flow
as the projectile path: emit `hit`, decrement HP, on lethal emit
`enemy_died` after creating the gem and removing the schema entry
(matches AD7 of M4).

Important: the orbit arm uses **point-circle**, not swept-circle —
unlike projectiles, orbs are not making a discrete jump between ticks
(they sweep through a continuous arc, but at 20Hz with `orbAngularSpeed
≤ 3.0 rad/s` the arc per-tick is `≤ 0.15 rad` ≈ 0.34 units of arc at
`orbRadius=2.4`, well under one enemy radius). Point-circle at the
tick's orb position is sufficient and simple. If we ever raise
`orbAngularSpeed` past ~6 rad/s we'll need swept-circle along the arc;
not now.

### AD9. Level-up resolution is a single pure function

```ts
function resolveLevelUp(
  player: Player,
  weaponKind: number,
  emit: Emit,
  autoPicked: boolean,
): void
```

Called from both `tickLevelUpDeadlines` (auto-pick) and the
`level_up_choice` message handler. Logic: if the player already has the
weapon (linear scan of `player.weapons` by `kind`), increment its
`level` (capped at `def.levels.length`). Else push a new `WeaponState`
with `kind = weaponKind, level = 1, cooldownRemaining = 0`. Clear
`pendingLevelUp / levelUpChoices / levelUpDeadlineTick`. Emit
`level_up_resolved`.

Pure: no side effects beyond mutating `player` and calling `emit`. Same
shape will carry every future "player gains a thing" flow (passives,
relics, etc., when those exist).

### AD10. Level-up overlay dismisses optimistically

On 1/2/3 keypress (or click), the client immediately sends the
`level_up_choice` message and immediately hides the overlay. The
overlay does not wait for `level_up_resolved` to dismiss — that event
arrives within ~50ms over a healthy connection but could be longer
under throttled network (verification step 9). UI feels responsive;
worst-case under packet loss is "I clicked, choice didn't take" which
is recoverable: schema still shows `pendingLevelUp = true` next snapshot
and the overlay re-shows.

If the client flap-happens to send a `level_up_choice` *and* the
deadline fires server-side at the same tick, the message handler runs
before `tickLevelUpDeadlines` (handlers fire on receipt; tick fires on
the simulation interval); the player's choice wins. If the deadline
fires first, the choice arrives as "no longer pending" and is rejected
silently — the player gets the auto-picked result.

### AD11. The "no per-name branches" rule is enforced in code review

The spec's central architectural claim is that no `if (def.name ===
...)` or `switch (kind)` over weapon-specific names exists in
`tickWeapons` (or the client orbit/projectile renderers). This is
enforceable by:

1. Code search at PR review time: `grep -rn "WEAPON_KINDS\[" packages/`
   should show only `[weapon.kind]` index lookups, never name compares.
2. Adding a third weapon (in a hypothetical future M-something) of an
   existing behavior kind requires zero changes to `tickWeapons` —
   verifiable by adding a row and grepping the diff.

If during implementation a name branch seems necessary, **stop**. The
correct response is to revise AD3 (the data shape) until the branch
becomes a behavior dispatch. Loosening AD1 is not on the table.

## Schema additions (`shared/schema.ts`)

`Player` gains three fields. All declared with `declare`, assigned in
the constructor, registered in `defineTypes` (per the schema-toolchain
landmine, schema/feedback memory):

```ts
declare pendingLevelUp: boolean;
declare levelUpChoices: ArraySchema<number>;   // weapon-kind ints; length 3 when pending, 0 otherwise
declare levelUpDeadlineTick: number;
```

`defineTypes` adds:

```ts
pendingLevelUp:      "boolean",
levelUpChoices:      [ "uint8" ],
levelUpDeadlineTick: "uint32",
```

`Player.level: "uint8"` already exists from M4 and now starts being
incremented (was always 1).

`WeaponState` is unchanged. `kind` and `level` already exist; the orbit
hit-cooldown is server-local (AD7), not schema.

`RoomState` is unchanged.

## Message protocol (`shared/messages.ts`)

Added to `ClientMessage` union (client → server):

```ts
type LevelUpChoiceMessage    = { type: "level_up_choice"; choiceIndex: number };
type DebugGrantWeaponMessage = { type: "debug_grant_weapon"; weaponKind: number };
```

Added as broadcast events (server → client, like the M4 combat events;
not part of `ClientMessage`):

```ts
type LevelUpOfferedEvent = {
  type: "level_up_offered";
  playerId: string;
  newLevel: number;        // the level the player just reached
  choices: number[];       // length 3, weapon-kind ints (with replacement)
  deadlineTick: number;    // RoomState.tick at which auto-pick fires
};

type LevelUpResolvedEvent = {
  type: "level_up_resolved";
  playerId: string;
  weaponKind: number;
  newWeaponLevel: number;
  autoPicked: boolean;
};
```

`MessageType` constant table extended with the four new strings.

## Weapon table (`shared/weapons.ts`)

Replaces the M4 `WeaponKind` shape entirely. Bolt is re-expressed in the
new shape; verifying Bolt still works exactly as before is the
non-regression checkpoint between Phase 1 and Phase 2 of implementation.

```ts
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
      { damage: 10, cooldown: 0.60, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 14, cooldown: 0.55, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 18, cooldown: 0.50, hitRadius: 0.4, projectileSpeed: 20, projectileLifetime: 0.8 },
      { damage: 22, cooldown: 0.45, hitRadius: 0.5, projectileSpeed: 20, projectileLifetime: 0.9 },
      { damage: 28, cooldown: 0.40, hitRadius: 0.5, projectileSpeed: 22, projectileLifetime: 0.9 },
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
] as const;

// Helper: clamp `level` to the defined range and return the row.
// `tickWeapons` and the client renderers all read stats through this.
export function statsAt<W extends WeaponDef>(def: W, level: number): W["levels"][number] {
  const idx = Math.max(1, Math.min(def.levels.length, level)) - 1;
  return def.levels[idx]!;
}
```

Numbers are placeholder tuning. Tests assert structure (monotonicity
where it matters, dispatch correctness), not specific damage values.

## Tick functions

Tick order:

```
tickPlayers → tickEnemies → tickWeapons → tickProjectiles → tickGems →
  tickXp → tickLevelUpDeadlines → tickSpawner
```

Order is load-bearing (AD5) and will be commented at the call site.

### `tickWeapons` — refactored, behavior dispatch

```ts
export function tickWeapons(
  state: RoomState,
  dt: number,
  ctx: WeaponContext,
  emit: Emit,
): void
```

Body shape:

```ts
state.players.forEach((player) => {
  player.weapons.forEach((weapon, weaponIndex) => {
    const def = WEAPON_KINDS[weapon.kind]!;
    switch (def.behavior.kind) {
      case "projectile": {
        const stats = statsAt(def, weapon.level);
        // Existing M4 path: tick cooldown, find nearest, push projectile, emit fire.
        // weapon.cooldownRemaining is the schema field; clamp at 0 (AD10 of M4 spec).
        break;
      }
      case "orbit": {
        const stats = statsAt(def, weapon.level);
        // For i in 0..stats.orbCount:
        //   angle = (state.tick / TICK_RATE) * stats.orbAngularSpeed + i * (2π / stats.orbCount)
        //   orbX  = player.x + cos(angle) * stats.orbRadius
        //   orbZ  = player.z + sin(angle) * stats.orbRadius
        //   For each enemy: if (dist² <= (stats.hitRadius + ENEMY_RADIUS)²) and
        //     ctx.orbitHitCooldown.tryHit(player.sessionId, weaponIndex, enemy.id,
        //         ctx.serverNowMs(), stats.hitCooldownPerEnemyMs):
        //     enemy.hp -= stats.damage
        //     emit hit (no fireId for orbit; use 0 or a special sentinel)
        //     if hp <= 0: drop gem, emit enemy_died, state.enemies.delete,
        //                 ctx.orbitHitCooldown.evictEnemy(enemy.id)
        break;
      }
    }
  });
});
```

Detail: `HitEvent.fireId` is required by the M4 schema. For orbit hits
there's no fire event to correlate with. Resolution: use `0` as a
sentinel "non-projectile hit". M4 already starts `nextFireId` at 1, so
`fireId === 0` is unambiguously "not a fire-id". Client `CombatVfx`
renders hit flashes from `enemyId` + `damage` and treats `fireId` as
correlation-only; the existing code path needs no change for orbit
hits, but a comment will be added at the emit site noting the sentinel.

### `tickXp` — new

```ts
export function tickXp(state: RoomState, rng: Rng, emit: Emit): void
```

For each player:

1. Skip if `player.pendingLevelUp` is already true.
2. Compute `need = xpForLevel(player.level)`.
3. If `player.xp < need`, continue.
4. Otherwise:
   - `player.xp -= need`
   - `player.level += 1`
   - Roll 3 choices: `[rng() * WEAPON_KINDS.length | 0, ...]` × 3, with
     replacement.
   - `player.levelUpChoices.push(...choices)` (clear first if needed —
     should always be empty here given the gate at step 1).
   - `player.pendingLevelUp = true`
   - `player.levelUpDeadlineTick = state.tick + LEVEL_UP_DEADLINE_TICKS`
   - `emit({ type: "level_up_offered", playerId: player.sessionId,
       newLevel: player.level, choices, deadlineTick:
       player.levelUpDeadlineTick })`

### `tickLevelUpDeadlines` — new

```ts
export function tickLevelUpDeadlines(state: RoomState, emit: Emit): void
```

For each player with `pendingLevelUp && state.tick >=
levelUpDeadlineTick`: call `resolveLevelUp(player, levelUpChoices[0],
emit, autoPicked: true)`.

### `resolveLevelUp` — new, pure

```ts
export function resolveLevelUp(
  player: Player,
  weaponKind: number,
  emit: Emit,
  autoPicked: boolean,
): void
```

Logic:

1. Linear scan `player.weapons` for one with `w.kind === weaponKind`.
2. If found: `w.level = Math.min(w.level + 1, WEAPON_KINDS[weaponKind].levels.length)`. Note new level for the event.
3. If not found: push new `WeaponState { kind: weaponKind, level: 1, cooldownRemaining: 0 }`. Note new level = 1.
4. Clear: `pendingLevelUp = false`, `levelUpChoices.clear()` (or `length = 0`), `levelUpDeadlineTick = 0`.
5. `emit({ type: "level_up_resolved", playerId: player.sessionId,
     weaponKind, newWeaponLevel, autoPicked })`.

### Updated `WeaponContext`

```ts
export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
  orbitHitCooldown: OrbitHitCooldownStore;   // new — see AD7
};
```

`tickProjectiles` and `tickGems` are unchanged.

## Server (`packages/server/src/GameRoom.ts`)

- Construct `OrbitHitCooldownStore` in `onCreate`; pass into
  `weaponCtx`. Spec at `packages/server/src/orbitHitCooldown.ts` (new
  file):

  ```ts
  export interface OrbitHitCooldownStore {
    tryHit(playerId: string, weaponIndex: number, enemyId: number,
           nowMs: number, cooldownMs: number): boolean;
    evictPlayer(playerId: string): void;
    evictEnemy(enemyId: number): void;
    sweep(nowMs: number): void;
  }
  export function createOrbitHitCooldownStore(): OrbitHitCooldownStore;
  ```

  Internal: `Map<string, number>` keyed
  `${playerId}:${weaponIndex}:${enemyId}`. `sweep` drops entries older
  than the global max cooldown configured in `WEAPON_KINDS` (computed
  once at construction).

- Hook the new ticks into the simulation loop in the order specified
  in AD5.

- `level_up_choice` message handler. The same `emit` lambda used by the
  tick (`(e: CombatEvent) => this.broadcast(e.type, e)`) is hoisted to
  a member field `private emit: Emit` in `onCreate` so handlers and
  ticks share it:

  ```ts
  this.onMessage<LevelUpChoiceMessage>("level_up_choice", (client, message) => {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.pendingLevelUp) return;
    const idx = Number(message?.choiceIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= player.levelUpChoices.length) return;
    const weaponKind = player.levelUpChoices[idx]!;
    resolveLevelUp(player, weaponKind, this.emit, /* autoPicked */ false);
  });
  ```

  Reject silently otherwise — no error response, no logging spam under
  packet loss.

- `debug_grant_weapon` message handler (gated by `ALLOW_DEBUG_MESSAGES`):
  if the player doesn't have the weapon, push a `WeaponState` at
  `level: 1`; if they do, increment its level (capped). No event
  emitted; this is for testing, not a real game flow.

- Eviction wiring:
  - `evictEnemy(enemyId)` called inside `tickProjectiles` on enemy
    death (modify the existing M4 path) and inside the orbit branch of
    `tickWeapons` on enemy death.
  - `evictPlayer(sessionId)` called from the `onLeave` catch block
    (after `allowReconnection` rejects, i.e., after grace expiry).
  - `sweep(Date.now())` called once per 100 ticks from inside the room
    `tick()` (cheap; just a tick counter modulo).

- `onJoin` continues to grant Bolt L1 as the starting weapon (no
  change). The starter is never Orbit; players acquire Orbit via
  level-up choice or `debug_grant_weapon`.

## Client

### New `LevelUpOverlay.tsx`

Bottom-center, 3 translucent cards side-by-side, key bindings 1/2/3,
visible countdown. Mounted once in `GameView`. Reads from
`room.state.players.get(localSessionId)` directly each rAF (same
pattern as `PlayerHud`). Source of truth for visibility:
`localPlayer.pendingLevelUp`.

- Seconds remaining = `Math.max(0, (deadlineTick - state.tick) * SIM_DT_S)`.
- Card content: read `WEAPON_KINDS[kind]` for name, scan
  `localPlayer.weapons` for current level → display
  `"Bolt L2 → L3"` if upgrade or `"Bolt — NEW"` if first acquisition.
  Cap-at-max indicated as `"Bolt L5 (MAX)"`.
- On 1/2/3 keypress (or card click): `room.send("level_up_choice",
  { type: "level_up_choice", choiceIndex: i })`. Optimistically hide.
- Re-shows automatically if `pendingLevelUp` flips back true (this is
  the reconnect path, AD6 — falls out for free with no special code).

### New `OrbitSwarm.tsx`

Separate `InstancedMesh` from `ProjectileSwarm` (different lifecycle).

- Capacity: `MAX_PLAYERS * MAX_ORB_COUNT_EVER` = 10 × 6 = 60. Defined
  in `shared/constants.ts` as `MAX_ORB_COUNT_EVER` (matches the highest
  `orbCount` across all weapon levels; assert at startup that
  `WEAPON_KINDS` doesn't exceed it).
- Each frame: walk `room.state.players`, for each player walk
  `weapons`. For each orbit-kind weapon, compute `orbCount` orb
  positions per AD2. Player attach point: predicted-local-pos for the
  local player, interpolated remote-pos for others.
- Same "no castShadow" landmine as `ProjectileSwarm`/`EnemySwarm`
  (Three.js + InstancedMesh memory).

### New `LevelUpFlashVfx.tsx`

Listens for `level_up_resolved` events; on receipt, plays a 250ms
expanding ring + tint flash on the affected `PlayerCube`. Single
ref-driven scale animation; no particles, no shake. This is the *only*
game-feel exception in this milestone.

### Edited `PlayerHud.tsx`

Each row currently shows one weapon name + cooldown bar. New row shape:
list **all** weapons formatted `"Bolt L2, Orbit L1"` (separated by
comma), with the level number on the player line as a separate
`Lv NN` field (already present, just now actually changing). Cooldown
bar logic stays for Bolt-style weapons; for orbit-only weapons the bar
is omitted (orbit has no cooldown).

### Edited `GameView.tsx`

- Mount `LevelUpOverlay`, `OrbitSwarm`, `LevelUpFlashVfx`.
- Add 1/2/3 keybinds (only active when overlay is visible).
- Add HUD-gated `Shift+G` debug keybind to send
  `{ type: "debug_grant_weapon", weaponKind: <Orbit-kind-int> }` for
  testing the Orbit branch in isolation.

## Constants (`shared/constants.ts`)

```ts
// M5 — XP / level-up
export function xpForLevel(level: number): number {
  return level * 5 + level * level;
}
export const LEVEL_UP_DEADLINE_TICKS = 10 * TICK_RATE;  // 200 ticks @ 20Hz = 10s

// M5 — orbit rendering
export const MAX_ORB_COUNT_EVER = 6;  // upper bound; asserted >= max orbCount in WEAPON_KINDS at startup
```

`MAX_ORB_COUNT_EVER` is the InstancedMesh capacity bound on the client
plus a safety margin. At module load (asserted in shared/index.ts or
the server bootstrap), we walk `WEAPON_KINDS` for every orbit-behavior
weapon's max-level `orbCount` and assert `MAX_ORB_COUNT_EVER >= max`.
With current data the actual max is 4 (Orbit L5), so 6 leaves growth
headroom. Mismatch throws at startup, not at runtime.

## Tests

### Vitest, shared

- `xpForLevel` is monotonically increasing on `[1, 50]`.
- `tickXp` triggers a level-up exactly once when XP crosses the
  threshold; does not retrigger on subsequent ticks while
  `pendingLevelUp` is true.
- `tickXp` re-triggers on the next tick after `resolveLevelUp` clears
  the pending flag, if XP is still over threshold (drain-via-re-ticks).
- `tickLevelUpDeadlines` fires `resolveLevelUp` exactly at
  `state.tick === levelUpDeadlineTick`, not before.
- `resolveLevelUp` upgrades existing weapon (`level` increments, no new
  WeaponState pushed) and adds new weapon (new WeaponState pushed at
  `level: 1`) on the appropriate paths. Caps at `levels.length`.
- Orbit hit-cooldown store: `tryHit` returns true the first time,
  false within the window, true after the window. `evictEnemy` removes
  all entries with that enemy id. `evictPlayer` removes all entries for
  that player. `sweep` drops entries older than max cooldown.
- `tickWeapons` orbit branch: a player with Orbit at L1 (2 orbs)
  positioned at origin generates the expected 2 orb positions for tick
  N, hits an enemy at orb-radius (one hit per enemy per cooldown
  window), respects cooldown across multiple ticks.
- `WEAPON_KINDS` structural invariant: every kind's `levels.length` is
  >= 1, every level's relevant fields are positive.

### Vitest, server

- Integration: a player gains XP from killed enemies → crosses
  threshold → `pendingLevelUp = true` → ignores choice → at deadline
  tick, `resolveLevelUp` fires with `autoPicked: true` → weapon state
  reflects the upgrade or new weapon.
- Integration: a player picks Orbit at L2 (via `debug_grant_weapon` to
  L1, then a real level-up to L2). Two orbs (L1) or two/three orbs (L2)
  appear by walking the `tickWeapons` orbit branch against a
  stationary ring of enemies; verify the expected number of hits over
  5 simulated seconds.
- Integration: client sends `level_up_choice` with `choiceIndex: 1`,
  server resolves to that weapon kind, `level_up_resolved` is broadcast
  with `autoPicked: false`.
- Integration: stale or out-of-range `choiceIndex` is rejected
  silently — no schema mutation, no broadcast.

### Vitest, client

- `LevelUpOverlay` shows/hides correctly off `pendingLevelUp` schema
  state.
- Reconnect path: simulate a fresh schema arrival with `pendingLevelUp
  = true` and a `levelUpDeadlineTick` in the future; overlay re-shows
  with the correct remaining time.

## Verification (manual, two browser tabs)

1. Two browser tabs, both join. Play normally. Within ~30s, at least
   one player levels up.
2. Level-up overlay appears for the leveling player only. Other player
   continues uninterrupted: enemy spawning, weapon firing, gem pickup
   all keep happening for them.
3. The leveling player can move during the choice (overlay does not
   intercept input beyond 1/2/3).
4. Pressing 1/2/3 selects that option; overlay dismisses; chosen
   weapon is reflected in the HUD within ~100ms.
5. Ignore the choice for 10 seconds: auto-pick fires (`autoPicked:
   true`), weapon updates, overlay dismisses.
6. Pick Orbit. Two (L1) orbiting projectiles appear, visible on BOTH
   clients in the SAME positions (cross-client determinism).
7. Orbiting projectiles damage enemies they touch. The same enemy is
   not shredded in a single tick — visible damage tick rate matches
   `hitCooldownPerEnemyMs`.
8. Level up multiple times. Both Bolt and Orbit can be upgraded;
   upgrades reflected in HUD weapon list.
9. Throttle one client's network to "Slow 3G". Level-up choice still
   works; resolution is delayed but eventually consistent.
10. Disconnect (hard, e.g. close tab via DevTools) WHILE the level-up
    overlay is showing. Reconnect within the 30s grace window. On
    reconnect, the overlay re-shows with the remaining time computed
    from `levelUpDeadline - currentTick`. Deadline is in tick-space, so
    no advantage gained.
11. `pnpm typecheck` and `pnpm test` both pass.

## Implementation order (informational; the plan will own this)

1. Refactor `shared/weapons.ts` to `WeaponDef` discriminated union.
   Update Bolt to fit. Update `tickWeapons` to dispatch on
   `behavior.kind` (single arm `"projectile"` for now). Update client
   `ProjectileSwarm` and `PlayerHud` to read via `statsAt`. Verify Bolt
   plays exactly as before.
   **Non-regression checkpoint.**
2. Add Orbit weapon definition. Add `OrbitHitCooldownStore`. Add the
   orbit arm to `tickWeapons`. Add `OrbitSwarm` to the client. Add
   `debug_grant_weapon` message + handler. Test orbit behavior with a
   debug-granted Orbit on a single client.
3. Add schema fields, `tickXp`, `xpForLevel`, message protocol,
   `level_up_choice` handler, `resolveLevelUp`. Add
   `LevelUpOverlay` to the client. Verify the manual choice path.
4. Add `tickLevelUpDeadlines`. Verify auto-pick path.
5. Verify reconnection path (verification step 10) end-to-end. This
   should require no extra code if AD6 is honored.
6. Add `LevelUpFlashVfx`. Update `PlayerHud` weapon list rendering.

## Files touched

**New:**
- `packages/server/src/orbitHitCooldown.ts`
- `packages/client/src/game/LevelUpOverlay.tsx`
- `packages/client/src/game/OrbitSwarm.tsx`
- `packages/client/src/game/LevelUpFlashVfx.tsx`

**Edited:**
- `packages/shared/src/weapons.ts` — full rewrite to `WeaponDef`
- `packages/shared/src/schema.ts` — add 3 fields to `Player`
- `packages/shared/src/messages.ts` — add 2 client + 2 server message
  shapes, extend `MessageType`
- `packages/shared/src/rules.ts` — refactor `tickWeapons`, add
  `tickXp` / `tickLevelUpDeadlines` / `resolveLevelUp`, add eviction
  hooks
- `packages/shared/src/constants.ts` — add `xpForLevel`,
  `LEVEL_UP_DEADLINE_TICKS`, `MAX_ORB_COUNT_EVER`
- `packages/shared/src/index.ts` — re-export new types/functions
- `packages/server/src/GameRoom.ts` — wire ticks, message handlers,
  cooldown store, eviction
- `packages/client/src/game/GameView.tsx` — mount new components, add
  keybinds
- `packages/client/src/game/PlayerHud.tsx` — list all weapons
- `packages/client/src/game/ProjectileSwarm.tsx` — read stats via
  `statsAt`

Tests added in `packages/shared/test/`, `packages/server/test/`,
`packages/client/test/` per the existing test layout (each package has
a top-level `test/` sibling to `src/`).

## Update to `CLAUDE.md` rule set

Rule 12 currently reads "Adding a new weapon means adding a row to
`WEAPON_KINDS` and (if non-trivial) a new `targeting` mode — never new
sync logic." This is too narrow now. Proposed revision (to be applied
at the end of M5, with the rest of the milestone):

> **Rule 12 (revised).** Combat events are server→client only and
> time-based, not state. `fire`, `hit`, `enemy_died`, `gem_collected`,
> `level_up_offered`, `level_up_resolved` are broadcast events, not
> schema entries. Projectile-behavior weapons are simulated client-side
> as a closed-form function of the `fire` event payload. Orbit-behavior
> weapons are simulated client-side as a closed-form function of
> `(state.tick, player position, weapon level)` — no per-frame syncing.
> Adding a new weapon means adding a row to `WEAPON_KINDS` against an
> existing `WeaponBehavior` kind; adding a new behavior kind means one
> new arm in `tickWeapons` and one new client renderer. Never name-based
> branching in tick or render code.
