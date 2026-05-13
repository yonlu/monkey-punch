# M10 — Enemy Expansion + First Boss

**Status:** Design — drafted 2026-05-13. Ready for review.

## Goal

Lift the enemy system from one kind / one behavior to a data-driven roster
of distinct kinds, and introduce the project's first boss subsystem. The
asset pipeline (Meshy two-stage prompts in `docs/art-pipeline/`) has
proven out on the slime; this milestone validates that the *framework*
under it generalizes the same way `WEAPON_KINDS` did at M5/M8 — adding
an enemy is a row in a table, not a branch in tick or render code.

The hypothesis: an `ENEMY_KINDS` table parallel to `WEAPON_KINDS` can
encode kind variety (HP, speed, contact damage, flying flag, time-gated
unlocks, spawn weight) AND a single bespoke boss kind with a
telegraphed AoE ability, with **no name-based branching anywhere in
tick or render code** (CLAUDE.md rule 12). If that fails during
implementation, stop and revisit.

## Non-goals

- No abilities on regular (non-boss) enemies. Bunnies, Ghosts, and
  Skeletons are walkers with stat differences only.
- No second boss ability, no multi-phase bosses, no additional boss
  kinds. One boss type, one ability. M11.
- No spawn-rate scaling. `ENEMY_SPAWN_INTERVAL_S` stays constant —
  difficulty curves come from kind-mix shifts (time-gated unlocks) and
  per-kind HP, not from spawn density. M11.
- No new status-effect kinds. Boss AoE deals damage only; players dodge
  by walking out of the radius. Keeps us at "1 effect kind, slow only"
  per CLAUDE.md "Things NOT to do" — the parallel-field shape is not
  refactored.
- No rule-10 InstancedMesh refactor for enemies on the Unity client.
  The TODO at `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs:628`
  stays — one GameObject per enemy is fine through M10's expected
  enemy counts.
- No balance pass. Numbers in this spec are mechanical-intent starting
  values, not tuned. Same precedent as M8 — tuning is its own task.
- No `run_ended` coupling. Boss death drops gems and the run continues;
  the recurring-spawn cadence keeps producing bosses.
- No remaining roster (Mushroom, Cocoon, Beetle, Chick, Bat). They
  extend `ENEMY_KINDS` later with no framework changes. Skipping them
  now is a scope decision, not an architectural one.

## Architectural decisions

Each of these was resolved during brainstorming. They are load-bearing
for the implementation plan.

### AD1. Enemy variety is encoded as a flat data table, dispatched by kind index

New file `packages/shared/src/enemies.ts`, parallel to
`packages/shared/src/weapons.ts` and `packages/shared/src/items.ts`.
Pure data, no `Schema`, no methods, no side effects on import. Adding
an enemy = appending a row. Per-kind dispatch goes through the kind
index into `ENEMY_KINDS` (via `enemyDefAt(kind)`), never via weapon
name or kind-name lookups.

```ts
export type EnemyDef = {
  name: string;
  baseHp: number;
  speedMultiplier: number;   // multiplied by ENEMY_SPEED (slime = 1.0)
  contactDamage: number;     // hp per touch (overrides ENEMY_CONTACT_DAMAGE)
  radius: number;            // hit + contact radius (overrides ENEMY_RADIUS)
  gemDropCount: number;      // gems spawned in a fan around death point
  spawnWeight: number;       // relative odds in tickSpawner; 0 for bosses
  minSpawnTick: number;      // earliest state.tick at which kind may spawn
  flying: boolean;           // true = tickEnemies skips terrain Y-snap
  isBoss: boolean;           // spawned by tickBossSpawner, not tickSpawner
  // Boss-only fields (read only when isBoss === true; zeroed otherwise).
  bossAbilityCooldownTicks: number;
  bossAbilityWindupTicks: number;
  bossAbilityRadius: number;
  bossAbilityDamage: number;
};

export const ENEMY_KINDS: readonly EnemyDef[] = [
  // 0: Slime — preserves current behavior (ENEMY_HP=30, ENEMY_SPEED=2.0,
  //    ENEMY_CONTACT_DAMAGE=5, ENEMY_RADIUS=0.5, 1 gem). Always spawns.
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

  // 2: Ghost — flying mid; unlocks after 90s. Skips terrain Y-snap;
  //    tickEnemies pins Y to terrainHeight + FLYING_ENEMY_ALTITUDE every
  //    tick (resnap with offset — see AD5).
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

  // 4: Boss — bespoke creature; spawnWeight=0 so tickSpawner never picks it;
  //    spawned exclusively by tickBossSpawner on its own timer (AD7).
  { name: "Boss",     baseHp: 2000, speedMultiplier: 0.7, contactDamage: 20,
    radius: 1.5, gemDropCount: 15, spawnWeight: 0,  minSpawnTick: 0,
    flying: false, isBoss: true,
    bossAbilityCooldownTicks: 100,  // 5s @ 20Hz
    bossAbilityWindupTicks: 20,     // 1s telegraph
    bossAbilityRadius: 4,
    bossAbilityDamage: 30 },
] as const;

export function enemyDefAt(kind: number): EnemyDef {
  const idx = Math.max(0, Math.min(ENEMY_KINDS.length - 1, Math.floor(kind)));
  return ENEMY_KINDS[idx]!;
}
```

`enemyDefAt` is the public read API — defensive against fractional and
non-finite inputs, same shape as `statsAt` in `weapons.ts` and
`itemValueAt` in `items.ts`. Today `Enemy.kind` is `uint8` so out-of-range
is theoretical, but the helper is the boundary contract.

Flat-shape boss fields (always present, zeroed for non-bosses) instead
of a discriminated union: justified because there is exactly one boss
kind. A second boss type with a different ability shape would force the
refactor to a `WeaponDef`-style union — that's M11's problem.

### AD2. Schema: two new fields on `Enemy`. No new MapSchema, no new RoomState fields.

```ts
export class Enemy extends Schema {
  declare id: number;
  declare kind: number;
  declare x: number;
  declare y: number;
  declare z: number;
  declare hp: number;
  declare slowMultiplier: number;
  declare slowExpiresAt: number;
  // M10: drives boss HP-bar ratio AND lets clients display damage as a
  // percentage of max. Set at spawn from ENEMY_KINDS[kind].baseHp; never
  // mutated post-spawn.
  declare maxHp: number;
  // M10: countdown tick for the boss telegraphed ability. -1 sentinel = idle
  // (matches Player.jumpBufferedAt and Enemy.slowExpiresAt encoding). For
  // non-boss enemies stays -1 forever after construction.
  declare abilityFireAt: number;
  constructor() {
    super();
    this.id = 0;
    this.kind = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.hp = 0;
    this.slowMultiplier = 1;
    this.slowExpiresAt = -1;
    this.maxHp = 0;
    this.abilityFireAt = -1;
  }
}
defineTypes(Enemy, {
  id: "uint32",
  kind: "uint8",
  x: "number",
  y: "number",
  z: "number",
  hp: "uint16",
  slowMultiplier: "number",
  slowExpiresAt: "int32",
  maxHp: "uint16",          // NEW
  abilityFireAt: "int32",   // NEW
});
```

`declare` fields plus constructor-body assignment — same discipline as
every other Schema in the project; preserves the `defineTypes` setters
that esbuild would otherwise shadow with `Object.defineProperty`. The
19-line banner at the top of `schema.ts` documents the landmine.

**Wire cost.** `maxHp` (2B) + `abilityFireAt` (4B) = 6 bytes per enemy
at add-time only. Colyseus deltas don't re-encode unchanged fields:
- `maxHp` is set once at spawn → 0 bytes/tick after.
- `abilityFireAt` is `-1` forever for non-bosses → 0 bytes/tick. Mutates
  only on boss state transitions (twice per ability cycle).

**Why not a separate `Boss` schema?** Considered and rejected: doubles
the schema surface and the client add/remove dispatch, requires a new
`MapSchema` on RoomState and a new integration round-trip, all to model
a single-instance entity that is already an enemy in every meaningful
sense. With one boss kind, the 6 bytes on every Enemy add are cheaper
than the parallel-state risk. If bosses grow to a half-dozen kinds with
specialized fields, revisit.

### AD3. Boss state lives off-schema on `GameRoom`, parallel to `SpawnerState`

```ts
type BossSpawnerState = {
  nextBossAt: number;       // tick at which to attempt next boss spawn
  aliveBossId: number;      // -1 = none alive
};

// In GameRoom.onCreate (after state.seed is set):
this.bossSpawner = {
  nextBossAt: BOSS_INTERVAL_TICKS,   // first spawn at T=BOSS_INTERVAL s, not T=0
  aliveBossId: -1,
};
```

Same rationale as `SpawnerState` from M3 AD1: server-only counters do
not benefit clients, would burn snapshot bytes for no value, and the
schema is reserved for "values that need to reach clients" (CLAUDE.md
rule 2). The 1-alive-at-a-time invariant is enforced server-side by the
`aliveBossId === -1` precondition on spawn.

### AD4. Boss death cleanup is one-tick-late and post-condition based

Detecting boss death by mutating `bossSpawner.aliveBossId` from every
`enemy_died` emit site would mean threading the spawner state into four
different tick functions (`tickWeapons`, `tickProjectiles`,
`tickBoomerangs`, `tickBloodPools`). Instead, `tickBossSpawner` checks
the post-condition: if `aliveBossId !== -1` and
`state.enemies.has(String(aliveBossId)) === false`, the boss died last
tick. Reset `aliveBossId = -1` and schedule `nextBossAt = currentTick +
BOSS_INTERVAL_TICKS`.

One-tick latency (the boss is removed from `state.enemies` in tick N,
the spawner notices in tick N+1) is irrelevant: the next boss is
minutes away. The simplicity gain is substantial — no `bossSpawner`
parameter on four tick signatures.

### AD5. Flying enemies pin to `terrainHeight(x, z) + FLYING_ENEMY_ALTITUDE` every tick

Two alternatives considered:

1. **Frozen-altitude:** record `y` at spawn (terrain height at spawn point
   + offset), never mutate. If the enemy walks from a hilltop into a
   valley, its world Y is unchanged so its visual altitude above local
   terrain grows.
2. **Resnap-with-offset (chosen):** every tick, `enemy.y =
   terrainHeight(x, z) + FLYING_ENEMY_ALTITUDE`. Enemy stays at a
   constant altitude above whatever ground is beneath it.

Resnap reads as a hovering creature; doesn't require remembering the
spawn-terrain-height; same wire size; one extra `terrainHeight` call
per flying enemy per tick (already done for non-flying enemies via the
existing snap line — the new branch is just `+0` vs `+FLYING_ENEMY_ALTITUDE`).
New constant in `packages/shared/src/constants.ts`:

```ts
export const FLYING_ENEMY_ALTITUDE = 2.5;  // world units above terrain
```

### AD6. Time-gated spawn unlocks + per-kind weighted pick. Spawn rate stays constant.

`tickSpawner` is the only consumer of regular enemy spawn rng. Replace
the single-kind `enemy.kind = 0` with a weighted pick over enabled
kinds:

```ts
function pickEnemyKind(currentTick: number, rng: Rng): number {
  let totalWeight = 0;
  // Deterministic single pass: filter + sum.
  for (let i = 0; i < ENEMY_KINDS.length; i++) {
    const def = ENEMY_KINDS[i];
    if (def.isBoss) continue;
    if (currentTick < def.minSpawnTick) continue;
    totalWeight += def.spawnWeight;
  }
  if (totalWeight <= 0) return 0;          // defensive — slime fallback
  let r = rng() * totalWeight;             // ONE rng() call per pick
  for (let i = 0; i < ENEMY_KINDS.length; i++) {
    const def = ENEMY_KINDS[i];
    if (def.isBoss) continue;
    if (currentTick < def.minSpawnTick) continue;
    r -= def.spawnWeight;
    if (r <= 0) return i;
  }
  return 0;                                // unreachable in practice; static fallback
}
```

**Determinism schedule impact.** `tickSpawner` today consumes one
`rng()` call per spawn for the live-player pick, then 1–3 calls in the
angle retry loop (variable, capped at 3). The kind pick adds **exactly
one** additional `rng()` call per spawn, inserted **first** in the
per-spawn sequence:

1. Kind pick (1 call) — new.
2. Live-player pick (1 call) — unchanged.
3. Angle retry loop (1–3 calls) — unchanged.

Spawn count per tick is determined by `accumulator >= interval` — same
as before — so the new consumer adds calls deterministically. CLAUDE.md
rule 11 ("tickXp + spawner both consume the room rng — reordering forks
the seed") remains intact because we **add** a consumer; we don't
reorder existing ones.

**Existing test impact.** `packages/shared/test/rules.test.ts` has a
load-bearing determinism test ("Five reproducible spawns from
`mulberry32(42)`") that asserts exact (x, z, kind) tuples for a known
seed. Adding the kind-pick rng consumer changes the spawn sequence —
the test will need its expected values **regenerated** after the
change lands, with a one-line note in the assertion that the values
were re-derived for M10. The test's *purpose* (asserting determinism
end-to-end across rng consumers) is preserved; only the literal values
change.

Difficulty progression comes entirely from `minSpawnTick` unlocks and
the kind-mix shift. `ENEMY_SPAWN_INTERVAL_S` stays at 1.0s. Spawn-rate
scaling over time is M11.

### AD7. Two new tick functions; both append to existing tick-order positions

Per CLAUDE.md rule 11, the tick order is load-bearing for fairness AND
cross-client determinism. Two new functions:

- **`tickBossAbilities(state, currentTick, emit)`** — slots between
  `tickEnemies` and `tickContactDamage`. Reads post-movement enemy
  positions (so a windup-frozen boss telegraphs from where it actually
  stopped), runs before contact damage (so a player who's about to be
  hit by the AoE doesn't also take contact damage on the same tick).
  Consumes NO rng — telegraph timing is deterministic from cooldown
  bookkeeping; AoE damage is a radius check, no rolls.

- **`tickBossSpawner(state, bossSpawner, currentTick, rng)`** —
  appended after `tickSpawner`. Consumes rng for the spawn angle.
  Trailing position keeps the rng schedule append-only.

Full updated tick order:

```
tickPlayers → tickStatusEffects → tickEnemies → tickBossAbilities (NEW)
  → tickContactDamage → tickRunEndCheck → tickWeapons → tickProjectiles
  → tickBoomerangs → tickBloodPools → tickGems → tickXp
  → tickLevelUpDeadlines → tickSpawner → tickBossSpawner (NEW)
```

`tickBossAbilities` placement after `tickEnemies` requires one branch in
`tickEnemies`: skip movement for any enemy with `abilityFireAt > 0`
(the boss freezes during windup). One conditional read on a field
that's `-1` for every non-boss enemy — trivial.

### AD8. Universal `runEnded` early-out is preserved

Both new tick functions early-out at the top with
`if (state.runEnded) return;`, matching the M6-onward universal
invariant. The frozen-world recap state is one branch in each function,
not a per-system gate.

### AD9. Combat events: boss telegraph + slam are time-based broadcasts

Per CLAUDE.md rule 12, combat-style events are server→client broadcasts,
not schema entries. Two new event types in
`packages/shared/src/messages.ts`:

```ts
// M10: telegraph for the boss's AoE slam. Emitted once per ability
// activation at the start of the windup. The client reads
// fireServerTimeMs to time the ring's fill animation — same time-based
// pattern as FireEvent.serverFireTimeMs (no per-tick syncing needed).
export type BossTelegraphEvent = {
  type: "boss_telegraph";
  bossId: number;
  originX: number;
  originZ: number;
  radius: number;
  fireServerTimeMs: number;   // Date.now() at expected fire tick
  serverTick: number;
};

// M10: AoE slam fired. Drives the strike VFX (ring shockwave). Per-player
// damage rides on the existing PlayerDamagedEvent path — one event per
// hit player — so the existing damage-number + downed-modal flow lights
// up without changes. This event is the "the slam happened" cue for
// ambient VFX only.
export type BossAoeHitEvent = {
  type: "boss_aoe_hit";
  bossId: number;
  originX: number;
  originZ: number;
  radius: number;
  serverTick: number;
};
```

Both added to the `MessageType` constant: `BossTelegraph:
"boss_telegraph"` and `BossAoeHit: "boss_aoe_hit"`.

No `boss_defeated` event — the existing `enemy_died` carries `enemyId`,
and the client knows the kind from `state.enemies.get(id).kind` at
event time. Client uses that to pick the richer death VFX. Event
surface stays minimal.

### AD10. Gem fan is evenly-spaced (no rng) — enemy_died sites read gemDropCount from ENEMY_KINDS

Every existing `enemy_died` emit site spawns one gem. Generalize:

```ts
const def = enemyDefAt(enemy.kind);
const count = def.gemDropCount;
if (count === 1) {
  spawnGem(state, enemy.x, enemy.z, GEM_VALUE);
} else {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;   // evenly spaced — NO rng
    spawnGem(state,
             enemy.x + Math.cos(angle) * GEM_FAN_RADIUS,
             enemy.z + Math.sin(angle) * GEM_FAN_RADIUS,
             GEM_VALUE);
  }
}
```

New constant:
```ts
export const GEM_FAN_RADIUS = 1.5;   // world units
```

Evenly-spaced angles (no rng) keep the determinism schedule untouched.
Gem positions are a deterministic function of `(deathX, deathZ, count)`.
Sites to update: `tickWeapons` (orbit kill path), `tickProjectiles`
(projectile kill path), `tickBoomerangs` (boomerang hit path),
`tickBloodPools` (pool DoT kill path), and `tickContactDamage` is
unaffected (contact damages players, not enemies).

### AD11. Boss-spawn position uses the same radius as regular spawns

`ENEMY_SPAWN_RADIUS = 30` is reused. The boss enters the player's
sight cone at the same distance as a regular enemy. Cinematic-distance
spawn (50+ units away with a slow walk-in) is deferred until M11
polish. Same retry-3 angle loop as `tickSpawner` for map-radius
containment.

### AD12. Unity client adopts a kind→prefab registry; existing slime keeps working

`NetworkClient.cs:42` currently:
```csharp
[SerializeField] private GameObject slimePrefab;
```

becomes:
```csharp
[Tooltip("Prefab per Enemy.kind index. ENEMY_KINDS in shared/enemies.ts " +
         "defines the order: 0=Slime, 1=Bunny, 2=Ghost, 3=Skeleton, 4=Boss. " +
         "Slots can be null — null falls back to the cube placeholder.")]
[SerializeField] private GameObject[] enemyPrefabs;
```

`HandleEnemyAdd` (`NetworkClient.cs:623`) dispatches on `e.kind`:
```csharp
GameObject prefab = (e.kind < enemyPrefabs.Length)
  ? enemyPrefabs[e.kind] : null;
if (prefab != null) {
  go = Instantiate(prefab);
  go.name = $"Enemy:{e.id}";
} else {
  // existing cube fallback unchanged
}
```

Inspector workflow: drag prefabs into array slots in kind-index order.
Empty slot falls back to the existing cube placeholder, so the *code*
ships before the *art* — slime keeps rendering today; new kinds appear
as cubes until their prefabs land.

The rule-10 TODO comment at `NetworkClient.cs:628` stays — InstancedMesh
refactor is out of scope.

## Architecture

```
shared/
  enemies.ts    (NEW)  EnemyDef type; ENEMY_KINDS table; enemyDefAt() helper
  constants.ts         + FLYING_ENEMY_ALTITUDE, GEM_FAN_RADIUS, BOSS_INTERVAL_TICKS
  schema.ts            Enemy: + maxHp + abilityFireAt
  rules.ts             tickEnemies: speed multiplier + flying snap + ability-windup freeze
                       tickSpawner: weighted kind pick + per-kind stats
                       tickContactDamage: per-kind contactDamage + radius
                       enemy_died sites: per-kind gem fan (4 call sites)
                       + tickBossAbilities (NEW)
                       + tickBossSpawner (NEW)
  messages.ts          + BossTelegraphEvent, + BossAoeHitEvent
                       MessageType: + BossTelegraph, + BossAoeHit
  index.ts             re-export ENEMY_KINDS, EnemyDef, enemyDefAt, BOSS_KIND_INDEX

server/
  GameRoom.ts          + bossSpawner: BossSpawnerState (off-schema)
                       tick(): inserts tickBossAbilities (after tickEnemies)
                              and tickBossSpawner (after tickSpawner)
                       BossCooldown map (off-schema, parallel to OrbitHitCooldown)
                       + emit hook for boss_telegraph + boss_aoe_hit

client/  (the TS web client; deprecated per user memory — Unity-only client)
  ⌀ — no changes. Unity client is the sole target. TS web client out of scope.

Unity (Monkey Punch/Assets/Scripts/):
  Schema/Enemy.cs                  + [Type(8)] maxHp + [Type(9)] abilityFireAt
  Net/NetworkClient.cs             slimePrefab → enemyPrefabs[] kind→prefab registry
                                   + boss_telegraph / boss_aoe_hit subscribers
  Net/PredictorConstants.cs        + BOSS_KIND_INDEX = 4
  Combat/BossTelegraphVfx.cs (NEW) ring decal + slam shockwave; reads
                                   ServerTime offset to sync fill across clients
  UI/GameUI.cs                     + boss HP bar (hp/maxHp ratio; visible while
                                     any enemy with kind == BOSS_KIND_INDEX is alive)
  Render/BunnyHop.cs (NEW)         procedural hop animator (mirrors SlimeBob)
  Render/GhostFloat.cs (NEW)       procedural float + drift animator
  (Skeleton uses Unity Animator on the Meshy-rigged FBX; no MonoBehaviour.)

art-pipeline:
  docs/art-pipeline/meshy-enemy-prompts.md
    — append a "10. Boss (bespoke)" section with new MJ + Meshy prompts
      authored when the specific boss creature is chosen.
```

## Data flow

### Regular-enemy spawn

1. `tickSpawner` (after gating): `pickEnemyKind(currentTick, rng)` →
   one weighted rng call → kind index.
2. `enemyDefAt(kind)` → `EnemyDef`. Set `enemy.kind = kind`,
   `enemy.hp = enemy.maxHp = def.baseHp`, `enemy.abilityFireAt = -1`.
3. Spawn position: angle from `rng`, distance `ENEMY_SPAWN_RADIUS`,
   `y = terrainHeight(x, z) + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET)`.

### Regular-enemy tick

1. `tickEnemies`: per enemy, read `def = enemyDefAt(enemy.kind)`. Skip
   movement if `abilityFireAt > 0`. Step toward nearest non-downed
   player by `ENEMY_SPEED * dt * def.speedMultiplier *
   enemy.slowMultiplier`. Re-snap Y: `enemy.y = terrainHeight(x, z) +
   (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET)`.
2. `tickContactDamage`: per (player, enemy) pair within radius, apply
   `def.contactDamage` damage. Per-pair cooldown reuses
   `ENEMY_CONTACT_COOLDOWN_S`.

### Enemy death (any kind)

1. The killing tick fn (orbit / projectile / boomerang / blood pool)
   sets `enemy.hp -= damage`. If `<= 0`, look up `def =
   enemyDefAt(enemy.kind)`. Spawn `def.gemDropCount` gems in an
   evenly-spaced fan around the death point. Emit `enemy_died`. Delete
   the enemy from `state.enemies`.

### Boss spawn

1. `tickBossSpawner` (last tick fn): if `aliveBossId === -1` and
   `currentTick >= nextBossAt` and there's at least one non-downed
   player:
   1. Pick a random non-downed player (`rng` call).
   2. Pick an angle in `[0, 2π)` (`rng` call). Place new Enemy with
      `kind = BOSS_KIND_INDEX` at `ENEMY_SPAWN_RADIUS`.
   3. `bossSpawner.aliveBossId = enemy.id`.

### Boss ability cycle

1. `tickBossAbilities` (after `tickEnemies`): for each enemy with
   `enemyDefAt(kind).isBoss`:
   1. If `abilityFireAt === -1` (idle) and the per-boss off-schema
      cooldown is elapsed: enter windup. Set `abilityFireAt =
      currentTick + def.bossAbilityWindupTicks`. Emit `boss_telegraph`
      with `fireServerTimeMs = Date.now() + windupMs`.
   2. If `currentTick === abilityFireAt`: fire. For each non-downed
      player within `def.bossAbilityRadius` (2D XZ distance):
      apply `def.bossAbilityDamage` hp damage. Emit `player_damaged`
      (existing event path → existing client damage-number flow).
      If `player.hp` reaches 0, set `player.downed = true`; emit
      `player_downed`. Emit one `boss_aoe_hit` (ambient cue). Reset
      `abilityFireAt = -1`; restart the off-schema cooldown.

### Boss death

1. Killing tick fn handles it like any other enemy death: gem fan
   (15 gems for the boss row), `enemy_died` emit, deletion.
2. Next `tickBossSpawner`: post-condition check fires — `aliveBossId
   !== -1` but `state.enemies.has(String(aliveBossId)) === false`.
   Reset `aliveBossId = -1`. Schedule `nextBossAt = currentTick +
   BOSS_INTERVAL_TICKS`.

### Client (Unity)

1. `Enemy` schema arrives → `HandleEnemyAdd` instantiates
   `enemyPrefabs[e.kind]` (or cube fallback).
2. Each frame: `transform.position = (interpolated x, y, z)` from the
   per-enemy `SnapshotBuffer`. Procedural animator (SlimeBob /
   BunnyHop / GhostFloat) layers visual life onto the child transform.
   Rigged enemies (Skeleton, Boss) drive their `Animator` from the
   per-frame root-position delta (same locomotion-from-velocity pattern
   `SlimeBob.cs` already uses for facing).
3. On `boss_telegraph`: `BossTelegraphVfx` instantiates a ring decal
   at the origin, animates fill 0 → 1 over `(fireServerTimeMs -
   NowMs())` ms (server-time-offset from `ServerTime.cs` makes this
   wall-clock-synchronized across all clients).
4. On `boss_aoe_hit`: replace the ring with a shockwave VFX
   (scale 1.0 → 1.2 over 200 ms, fade out). Lifecycle matches
   `CombatVfx.OnHit`.
5. Each frame: `GameUI` scans `state.enemies` for any enemy with
   `kind == BOSS_KIND_INDEX`. If found, show the HP bar with fill =
   `hp / maxHp` and label "Boss". If none, hide the bar.

## Schema

(See AD2 for the full diff.) Two new fields on `Enemy`. Nothing else
moves. RoomState unchanged.

## Constants

New entries in `packages/shared/src/constants.ts`:

```ts
// M10 — enemy expansion
export const FLYING_ENEMY_ALTITUDE = 2.5;   // world units above terrain
export const GEM_FAN_RADIUS        = 1.5;   // world units, even-spaced fan
export const BOSS_INTERVAL_TICKS   = 3 * 60 * TICK_RATE;  // 3 min @ 20Hz = 3600 ticks
```

`BOSS_INTERVAL_TICKS` is the single tunable for boss cadence. Three
minutes feels right for a foundation milestone; tuning pass adjusts.

The Unity client gets a matching constant in `PredictorConstants.cs`:

```csharp
public const int BOSS_KIND_INDEX = 4;   // mirrors ENEMY_KINDS[4] in shared/enemies.ts
```

This is the one place the Unity client hardcodes the boss kind. If
the boss kind index ever moves, both `enemies.ts` and
`PredictorConstants.cs` change together. M11's multi-boss world
replaces this with an `isBoss` lookup table — for one boss, the int
suffices.

## Rules

New signatures in `packages/shared/src/rules.ts`:

```ts
export function tickBossAbilities(
  state: RoomState,
  currentTick: number,
  bossCooldowns: Map<number, number>,   // bossId → tick at which idle cooldown expires
  emit: (event: BossTelegraphEvent | BossAoeHitEvent | PlayerDamagedEvent | PlayerDownedEvent) => void,
): void;

export type BossSpawnerState = {
  nextBossAt: number;
  aliveBossId: number;
};

export function tickBossSpawner(
  state: RoomState,
  bossSpawner: BossSpawnerState,
  currentTick: number,
  rng: Rng,
  spawner: SpawnerState,   // shares nextEnemyId for monotonic id assignment
): void;
```

`tickBossAbilities` takes the cooldown map as a parameter (off-schema,
lives on `GameRoom`). The function is pure (mutates state and the map
passed in; produces events via `emit`). Same shape as the existing
weapon hit-cooldown maps.

`tickBossSpawner` takes both `bossSpawner` and `spawner` because boss
ids share the same monotonic counter as regular enemies (`Enemy.id`
must be unique across the whole `state.enemies` map). Reusing
`spawner.nextEnemyId` is the natural choice — same pattern as M3
where the debug burst reuses it.

**Resolving "which kind is the boss" without a hardcoded index.** Both
`tickBossSpawner` and any other server-side site that needs to identify
the boss kind reads from a cached module-level value:

```ts
// In packages/shared/src/enemies.ts:
export const BOSS_KIND_INDEX: number = (() => {
  const idx = ENEMY_KINDS.findIndex(d => d.isBoss);
  if (idx < 0) throw new Error("ENEMY_KINDS contains no isBoss row");
  return idx;
})();
```

Same module-load-time assertion pattern as `MAX_ORB_COUNT_EVER` in
`shared/index.ts`. If a future refactor accidentally removes the boss
row (or sets every `isBoss: false`), the assertion trips at import
time, not at the first 3-minute mark of a real run.

The Unity client cannot import from `enemies.ts` directly — it gets
its own `BOSS_KIND_INDEX = 4` constant in `PredictorConstants.cs`,
manually kept in sync. This is the one place the boss-kind index is
duplicated, and it's documented as such.

**`bossCooldowns` lifecycle.** The off-schema cooldown map
(`Map<bossId, nextReadyTick>`) lives on `GameRoom`. Lifecycle:
- On boss spawn (`tickBossSpawner`), initialize:
  `bossCooldowns.set(bossId, currentTick + def.bossAbilityCooldownTicks)`
  — the FIRST ability triggers after one cooldown period, not
  immediately on spawn (gives players ~5s of orientation before the
  first telegraph).
- On boss death cleanup (`tickBossSpawner` post-condition check):
  `bossCooldowns.delete(deadBossId)` to bound the map size.
- `tickBossAbilities` only reads/updates the cooldown map; never adds
  or removes entries on its own. Single-writer-at-spawn pattern.

Existing tick functions:

```ts
export function tickEnemies(state: RoomState, dt: number): void;
// Two read-site changes:
//   1. Movement step: ENEMY_SPEED * dt * def.speedMultiplier * enemy.slowMultiplier
//   2. Y-snap: terrainHeight + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET)
//   3. Skip movement when enemy.abilityFireAt > 0 (boss windup freeze).

export function tickSpawner(
  state: RoomState,
  spawner: SpawnerState,
  dt: number,
  rng: Rng,
): void;
// One change: replace `enemy.kind = 0; enemy.hp = ENEMY_HP` with
//   const kind = pickEnemyKind(state.tick, rng);
//   const def = enemyDefAt(kind);
//   enemy.kind = kind;
//   enemy.hp = enemy.maxHp = def.baseHp;
// (`pickEnemyKind` is internal to rules.ts; not exported.)

export function tickContactDamage(state: RoomState, currentTick: number,
                                  contactCooldowns: Map<string, number>): void;
// Two read-site changes per-enemy:
//   const def = enemyDefAt(enemy.kind);
//   const radius = def.radius;       (was ENEMY_RADIUS)
//   const damage = def.contactDamage; (was ENEMY_CONTACT_DAMAGE)
```

`pickEnemyKind` implementation per AD6 (one `rng()` call per call;
deterministic single-pass filter + accumulate).

Enemy-death emit sites (orbit / projectile / boomerang / bloodPool kill
paths) read `def.gemDropCount` and call a shared `spawnGemFan` helper
that places gems via the even-spaced angle math from AD10. Each
site's diff is one helper call replacing one `state.gems.set(...)` line.

## Server

`GameRoom.ts` changes are mechanical:

```ts
import { BOSS_KIND_INDEX } from "@mp/shared";
import { BOSS_INTERVAL_TICKS } from "@mp/shared";   // from shared/constants.ts

export class GameRoom extends Room<RoomState> {
  // existing fields...
  private bossSpawner!: BossSpawnerState;
  private bossCooldowns = new Map<number, number>();

  override async onCreate(options: JoinOptions): Promise<void> {
    // ...existing onCreate...
    this.bossSpawner = {
      nextBossAt: BOSS_INTERVAL_TICKS,
      aliveBossId: -1,
    };
  }

  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S, this.inputCooldowns);
    tickStatusEffects(this.state, this.state.tick);
    tickEnemies(this.state, SIM_DT_S);
    tickBossAbilities(this.state, this.state.tick, this.bossCooldowns, this.emit);
    tickContactDamage(this.state, this.state.tick, this.contactCooldowns);
    tickRunEndCheck(this.state, this.emit);
    tickWeapons(this.state, /* ... */);
    tickProjectiles(this.state, /* ... */);
    tickBoomerangs(this.state, /* ... */);
    tickBloodPools(this.state, /* ... */);
    tickGems(this.state, /* ... */);
    tickXp(this.state, this.rng, this.emit);
    tickLevelUpDeadlines(this.state, this.emit);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
    tickBossSpawner(this.state, this.bossSpawner, this.state.tick, this.rng, this.spawner);
  }
}
```

`this.emit` is the existing broadcast helper (same pattern as
`tickWeapons` emits `fire` events). For `tickBossAbilities` it
fans out `player_damaged` / `player_downed` plus the two new boss
events. `tickBossAbilities` does NOT modify `this.bossCooldowns` —
that's the caller's contract — it just reads & writes against the map
passed in. (Same pattern as `OrbitHitCooldown`.)

## Client

Per the user's auto-memory note: the TS web client under
`packages/client` is deprecated; the Unity client under `Monkey Punch/`
is the sole client target. This spec leaves `packages/client`
untouched.

Unity client changes:

- **`Monkey Punch/Assets/Scripts/Schema/Enemy.cs`** — two new fields
  matching the new schema slots:
  ```csharp
  [Type(8, "uint16")]  public ushort maxHp = default(ushort);
  [Type(9, "int32")]   public int abilityFireAt = default(int);
  ```
  Mechanical change; the C# Colyseus decoder picks them up automatically.

- **`Monkey Punch/Assets/Scripts/Net/PredictorConstants.cs`** — add
  `BOSS_KIND_INDEX = 4`.

- **`Monkey Punch/Assets/Scripts/Net/NetworkClient.cs`** — replace the
  single `slimePrefab` SerializeField with `enemyPrefabs[]` per AD12.
  Subscribe two new room messages (`boss_telegraph`, `boss_aoe_hit`)
  with `[Serializable]` DTOs that mirror the TS event shapes.

- **`Monkey Punch/Assets/Scripts/Combat/BossTelegraphVfx.cs`** — new
  singleton MonoBehaviour, parallel to `CombatVfx.cs`. Public methods:
  - `OnTelegraph(uint bossId, float originX, float originZ, float radius, long fireServerTimeMs)`:
    instantiate a ring decal child of a permanent VFX-root GameObject.
    Position at `(originX, terrainHeight(originX, originZ) + 0.02f, originZ)`.
    Scale to `radius * 2`. Animate fill 0 → 1 over the remaining
    server-time window; color ramps yellow → red. Track by `bossId` in
    a `Dictionary<uint, GameObject>` so a follow-up `boss_aoe_hit`
    finds and replaces the right ring.
  - `OnAoeHit(uint bossId, float originX, float originZ, float radius)`:
    find the ring for `bossId`, replace it with a shockwave (scale
    1.0 → 1.2 over 200 ms, fade alpha 1 → 0). Auto-destroy on animation
    end.

- **`Monkey Punch/Assets/Scripts/UI/GameUI.cs`** — extend with a
  top-of-screen boss HP bar. Each frame: scan `room.State.enemies` for
  the first entry with `kind == BOSS_KIND_INDEX`. If found, show
  `name="Boss"`, fill = `hp / maxHp`. Hide otherwise. Single
  hot-path branch; one MapSchema iteration per frame which is cheap
  even at 300 enemies.

- **`Monkey Punch/Assets/Scripts/Render/BunnyHop.cs`** (new) — mirrors
  `SlimeBob.cs`: child-transform squash + vertical hop on a sine wave
  + facing-from-root-velocity. Faster `bobSpeed` than slime to read
  as "fast hopping rabbit".

- **`Monkey Punch/Assets/Scripts/Render/GhostFloat.cs`** (new) —
  Y-bob on a slower sine + continuous Y-rotation drift. No squash. No
  facing-from-velocity (ghosts read fine without committed facing).

## Asset pipeline

Four Meshy generations required. Sequence Skeleton before Boss to
de-risk the rigged pipeline.

| Slot | Creature | Path | Source prompt | Animator |
|------|----------|------|---------------|----------|
| `kind=1` | Bunny    | A (procedural GLB)  | `docs/art-pipeline/meshy-enemy-prompts.md` §2 | `BunnyHop.cs` |
| `kind=2` | Ghost    | A (procedural GLB)  | `meshy-enemy-prompts.md` §5                    | `GhostFloat.cs` |
| `kind=3` | Skeleton | B (rigged FBX)      | `meshy-enemy-prompts.md` §9                    | Unity Animator, 1D BlendTree on Speed (M9 pattern) |
| `kind=4` | **Boss** (bespoke) | B (rigged FBX) | NEW section authored at art-prompt time | Unity Animator, BlendTree |

Each prefab lives at `Monkey Punch/Assets/Prefabs/Enemies/<creature>.prefab`
and is dragged into the `enemyPrefabs` array in kind-index order. Empty
slots fall back to cubes — implementation can ship before art does.

**Risk to call out:** Skeleton and Boss are both rigged FBX imports.
This is the first time the Meshy rigged-enemy pipeline runs at all
(the existing rigged import is the Blademaster, a Path B import for
the player). If Meshy's auto-rig produces a bone hierarchy that
doesn't load cleanly into Unity's Generic Avatar, both Skeleton (`kind=3`)
and Boss (`kind=4`) are blocked. Mitigation: build Skeleton first — its
kind is gated behind a 150s `minSpawnTick`, so the cube fallback is
fine for hours of pre-art testing. Confirm the import pipeline against
the Skeleton, then run the Boss generation.

## Tests

### `packages/shared/test/rules.test.ts` — extend

**`tickSpawner` (5 new tests)**
1. Slime always spawnable at tick=0; bunny NOT spawned with `minSpawnTick=600`
   until `currentTick >= 600`.
2. Weighted pick across {Slime:60, Bunny:30} with `mulberry32(42)` — assert
   the first N picks match a precomputed sequence. **The determinism
   load-bearing test.**
3. Long-run distribution: 1000 spawns at `currentTick = 200 * 20` (everything
   except boss unlocked) — assert per-kind counts within 10% of the
   weight ratio.
4. Per-kind stats applied at spawn: assert `enemy.maxHp === def.baseHp`
   for each non-boss kind.
5. Flying enemy spawn Y: assert `enemy.y === terrainHeight(x, z) +
   FLYING_ENEMY_ALTITUDE` for the Ghost row.

**`tickEnemies` (3 new tests)**
1. `speedMultiplier` applied: Bunny moves 1.5× as far per tick as Slime
   from identical start positions toward a stationary player.
2. `abilityFireAt > 0` freeze: boss with `abilityFireAt = currentTick + 5`
   does NOT move on this tick.
3. Flying enemy Y resnap: place a Ghost over a known terrain peak vs. a
   known valley — assert Y matches `terrainHeight + FLYING_ENEMY_ALTITUDE`
   in both cases after one tick of movement.

**`tickBossAbilities` (4 new tests)**
1. Idle → windup: boss with `abilityFireAt = -1` and elapsed cooldown
   sets `abilityFireAt = currentTick + windupTicks` and the emit
   collector receives one `boss_telegraph` with the right radius +
   `fireServerTimeMs`.
2. Windup → fire: boss with `abilityFireAt === currentTick` emits one
   `boss_aoe_hit` + one `player_damaged` per player inside radius;
   resets `abilityFireAt = -1`.
3. AoE radius gate: player just inside radius takes damage; player just
   outside does NOT. Floor/ceiling around `def.bossAbilityRadius`.
4. Non-bosses are no-ops: a slime with `abilityFireAt = 999` does NOT
   trigger any emit — only `def.isBoss === true` enemies do.

**`tickBossSpawner` (4 new tests)**
1. Nothing spawns before `nextBossAt`: tick to `nextBossAt - 1`, assert
   no boss in `state.enemies`.
2. Exactly one boss spawns at `currentTick === nextBossAt` with a live
   player and `aliveBossId === -1`. `bossSpawner.aliveBossId` is set to
   the new boss's id; `enemy.maxHp === ENEMY_KINDS[BOSS_KIND_INDEX].baseHp`.
3. Second boss does NOT spawn while first is alive: tick forward
   `BOSS_INTERVAL_TICKS * 2`, assert still only one boss in
   `state.enemies`.
4. Death cleanup: remove the alive boss from `state.enemies`; tick once;
   assert `aliveBossId === -1` and `nextBossAt === currentTick +
   BOSS_INTERVAL_TICKS`.

**`enemyDefAt` (1 new test)** — out-of-range (kind=99), fractional
(kind=2.7), and `NaN` inputs all return a defined row. Same shape as
the existing `statsAt` clamp test.

### `packages/shared/test/schema.test.ts` — extend

Extend the Enemy round-trip to include `maxHp` and `abilityFireAt`.
Catches the esbuild field-initializer landmine specifically for the
two new fields.

### `packages/server/test/integration.test.ts` — extend

Add one test:
```ts
describe("integration: boss spawn over real ticks", () => {
  it("spawns exactly one boss after BOSS_INTERVAL with the expected stats", async () => {
    // Test-only hook: override BOSS_INTERVAL_TICKS to a short value
    // (e.g. 2s = 40 ticks) so the test runs quickly.
    // Connect one client; wait ~2.5s; assert exactly one enemy with
    // kind == BOSS_KIND_INDEX in state.enemies, with maxHp matching
    // ENEMY_KINDS[BOSS_KIND_INDEX].baseHp.
  }, 5_000);
});
```

The override mechanism is a module-level setter on `GameRoom` that
tests can call before joining — same shape as existing test-only hooks
in the codebase. The default 3-minute interval is too slow for an
integration test, so a minimal setter must be added if one doesn't
already exist. The setter writes to the per-room
`bossSpawner.nextBossAt` after `onCreate`, not to a module-level
constant — so it only affects the test's own room instance.

### Deliberate omission: Unity-side tests

The new Unity code (BunnyHop, GhostFloat, BossTelegraphVfx, the HP
bar) is MonoBehaviour + UI surface. Testing requires Unity's Test
Framework + PlayMode tests, which the project doesn't currently use.
Fall back to the manual verification steps below. If the boss
telegraph VFX timing becomes a hot-bug area, extract the time-fill
calculation into a static helper and PlayMode-test that.

## Verification

### Manual checks (after dev loop wired, two Unity-client instances)

1. **Slime parity.** Slimes still spawn at T=0+; HP, speed, contact
   damage unchanged from current build.
2. **Time-gated unlocks visible.** At T≈30s bunnies appear; T≈90s
   ghosts; T≈150s skeletons. Both client instances observe the same
   kind mix (cross-client determinism via seeded rng).
3. **Speed multipliers.** Bunny visibly outpaces Slime side-by-side.
   Slime moves at current rate (1.0×).
4. **Flying ghost.** Ghost floats at `+2.5` above terrain. Walking from
   hilltop to valley, it stays at `terrain + offset`, not at hilltop
   altitude. Bolt fired from a player at ground level still hits the
   ghost (Bolt's 3D hit radius covers the altitude gap).
5. **Skeleton import.** Skeleton FBX loads; the Animator's BlendTree
   transitions idle → walk as the root-position velocity exceeds the
   threshold. No T-pose, no missing materials.
6. **Boss spawn.** At T=BOSS_INTERVAL_TICKS, one boss spawns at
   `ENEMY_SPAWN_RADIUS` from a player. HP bar appears at top of screen
   on both clients with fill = 1.0.
7. **Boss telegraph + slam.** Periodically the boss freezes; a yellow
   ring appears beneath it; ring fills to red over 1s; on fill complete
   players inside the ring take damage (floating damage numbers spawn);
   players outside don't; ring is replaced by a shockwave VFX. Both
   clients see the ring fill complete at the SAME wall-clock moment
   (server-time-offset sync working).
8. **Boss death.** Boss dies; 15 gems spawn in an evenly-spaced ring
   around the death point; HP bar disappears. Run continues. ~BOSS_INTERVAL
   seconds later, next boss spawns.
9. **One-boss invariant.** Even with two players alive, only one boss
   exists at a time. If a player tries to debug-spawn a second boss
   (kind=4 via debug_spawn), it spawns — but `tickBossSpawner` is the
   only gated path. Debug spawns are exempt; manual test only.
10. **Reconnect mid-boss.** Drop one client during a boss fight (within
    30s grace window). Reconnect. The reconnected client sees the boss
    at its current `hp / maxHp`, plus any in-progress telegraph if its
    ring decal is already on the ground (server doesn't re-emit; if
    the reconnect lands mid-telegraph, the player sees the ring
    instantiated late — minor visual artifact, gameplay-correct
    because damage application is server-side).
11. **`pnpm typecheck` and `pnpm test` pass.**
12. **`pnpm --filter @mp/server test` passes** — the integration test
    catches encoder regressions for the two new schema fields.

### Performance check (after manual passes)

Two clients connected. Press `]` and `}` to debug-spawn 200–300 mixed
enemies (the existing burst debug spawns kind=0; extend it to kind=1
via the existing `kind` parameter on `debug_spawn` to mix kinds).

- Server tick rate holds 20Hz with mixed kinds.
- Client fps holds 60 with mixed kinds + an active boss telegraph.
- Per-tick snapshot bytes stay under the M3-era 50 KB stop-condition.
  Expected impact: +6 bytes/enemy at add-time only (so the delta
  encoder doesn't add per-tick cost). Full-state encode grows by
  `MAX_ENEMIES * 6 bytes = 1.8 KB` worst case.

If perf degrades, stop and diagnose. Rule 10 InstancedMesh refactor
moves up in priority if Unity GameObject costs are the bottleneck.

## CLAUDE.md update

Two edits to `CLAUDE.md`:

1. **Rule 11 (tick order)** — extend the tick-order block with the two
   new functions:
   ```
   tickPlayers → tickStatusEffects → tickEnemies → tickBossAbilities
     → tickContactDamage → tickRunEndCheck → tickWeapons → tickProjectiles
     → tickBoomerangs → tickBloodPools → tickGems → tickXp
     → tickLevelUpDeadlines → tickSpawner → tickBossSpawner
   ```
   Append to the rationale paragraph: `tickBossAbilities` between enemies
   and contact damage so the AoE strikes post-movement player positions;
   `tickBossSpawner` last so its rng consumption (boss spawn angle)
   appends to the schedule rather than reordering it. `tickBossAbilities`
   does NOT consume rng — telegraph timing is deterministic, AoE is a
   radius check.

2. **Architecture rules — add Rule 13** (after the existing Rule 12):
   > 13. **Enemy variety is data, not branches.** Per-kind enemy stats
   > (HP, speed multiplier, contact damage, radius, gem drop count,
   > spawn weight, time-gated unlocks, flying flag) live in the
   > `ENEMY_KINDS` table in `packages/shared/src/enemies.ts`. Per-kind
   > dispatch goes through `enemyDefAt(kind)`, never through name-based
   > branching in tick or render code. Adding a new enemy is a row in
   > the table. Adding a new mechanical capability (a second status-effect
   > kind, a new movement mode, a boss with a different ability shape)
   > requires the corresponding field shape AND the read site — same
   > discipline as `WEAPON_KINDS`. The Unity client's `enemyPrefabs[]`
   > array is indexed by `Enemy.kind` so the rendering layer matches
   > the data table's order.

## Future work (deliberately deferred)

- **M11 boss variety.** Multi-phase bosses (HP-threshold transitions),
  second ability per boss (charge / summon / ranged projectile),
  additional boss kinds, boss-side player debuffs (would trip the
  "2 effects → refactor to ArraySchema<StatusEffect>" rule and force
  the move).
- **Remaining roster.** Mushroom, Cocoon, Beetle, Chick, Bat — extend
  `ENEMY_KINDS` with their rows; build their prefabs from the existing
  `meshy-enemy-prompts.md` prompts; drop into the `enemyPrefabs` array
  in their kind-index order. No framework changes.
- **Spawn-rate scaling over time.** `tickSpawner` reads
  `ENEMY_SPAWN_INTERVAL_S` from a time curve (e.g., 1.0s at T=0 →
  0.4s at T=600s). One additional read, one additional constant
  (curve params). Two-line change once needed.
- **Rule-10 InstancedMesh on Unity.** The `NetworkClient.cs:621`
  deferral. Becomes urgent if per-GameObject cost is the perf
  bottleneck at high enemy counts.
- **Server-driven boss name.** `Enemy.displayName: string` field.
  Only needed once we have multiple distinguishable bosses.
- **Boss reward escalation.** Forced level-up grant on boss kill,
  treasure-chest interaction, item drops — all rejected from M10
  scope. Layer on top of the existing `enemy_died` event when needed.
- **Cinematic boss spawn.** Slow walk-in from 50+ units, brief
  HUD intro animation. M11 polish.
- **Balance pass.** HP curve, spawn weights, time gates, boss damage,
  boss cooldown, boss AoE radius. Tuning is its own task — same
  precedent as M8 weapons.
