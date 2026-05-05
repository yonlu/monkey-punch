# M4 — First combat: auto-attack, damage, death, XP gems

**Status:** Design — approved 2026-05-04. Ready for implementation plan.

## Goal

Two players auto-fire one weapon (Bolt) at the nearest enemy. Server runs
authoritative damage and death; clients simulate projectiles locally from
a closed-form position function over a shared server-time base. Enemies
die, drop XP gems, players walk over gems to collect them. A simple HUD
shows each player's XP and current weapon.

This milestone exists to prove out two patterns the rest of the game
inherits from:

1. **Fire-and-hit event protocol.** Projectiles are not synced as
   entities; they are a stream of broadcast events. Every future weapon
   variation (spread, pierce, bounce, homing, AoE) is a variation on this
   protocol — no new sync logic.
2. **Pickup loop.** Server places a pickup in the schema; clients render
   it; server detects player overlap; broadcast on collect; remove from
   schema. Same shape will carry every future pickup type.

Get these right here and adding more weapons / pickups later is content
work, not architecture work.

## Non-goals

- No level-up flow. `Player.level` exists in the schema and stays at 1.
- No second weapon kind. `WEAPON_KINDS` is an array of one. The array
  shape exists so M5 can add a second entry without schema or rules
  changes.
- No second enemy type. Same cone, now with non-trivial HP.
- No projectile sync via schema. Fire-and-hit events only.
- No client-authoritative damage. Clients never apply damage to schema
  state.
- No knockback, status effects, pierce, crits, elemental damage.
- No sound effects (deferred to a dedicated audio milestone).
- No object pooling for projectiles unless perf shows GC stutter.
- No camera shake / screen flash (deferred to game-feel pass).
- No magnet pickup. Radius check only; gems do not move.

## Architectural decisions

These are load-bearing. Each was either resolved in the brief or in
brainstorming. The implementation plan should treat them as fixed.

### AD1. Projectile time-base is server-time, via extended `pong`

The brief flags cross-client projectile determinism as critical. The
naïve "spawn on event receipt and simulate locally" approach diverges
across clients by exactly the network jitter between them — at "Fast 3G"
that can be 200ms+, equivalent to ~4 world-units of position drift on a
Bolt projectile (lifetime is 0.8s).

Mechanism:

- `PongMessage` gains `serverNow: number` (server `Date.now()` at echo).
- Client maintains a smoothed `serverTimeOffset = serverNow + halfRtt -
  clientNow`, mixed at α=0.2 across pings (the existing 1Hz ping is the
  driver).
- `FireEvent` gains `serverFireTimeMs: number` (server `Date.now()` at
  fire).
- Each render frame, projectile position is the closed-form function:

  ```
  elapsed = clamp((serverNow() - interpDelayMs - serverFireTimeMs) / 1000,
                  0, lifetime)
  pos     = (originX + dirX * speed * elapsed,
             originZ + dirZ * speed * elapsed)
  ```

  No mutable per-projectile position state on the client.

This makes cross-client position consistency a property of the time-base,
not the network jitter. Any two clients computing `pos` for the same
`(fireId, frame)` get the same answer up to clock-offset drift — which
is single-digit ms on a stable connection.

### AD2. Render-aligned projectiles (same `interpDelayMs` as state)

Enemies and remote players already render at `performance.now() -
interpDelayMs` (≈100ms behind realtime). Projectiles render at the same
delay (using the synced server-time base from AD1). This makes hit
feedback land correctly:

- Server scores hits at *realtime* server tick.
- Server emits `hit` event; arrives at client some ping later.
- Meanwhile the rendered projectile is `interpDelayMs` behind realtime,
  so it visually reaches the rendered enemy *just as* the `hit` event
  has had time to arrive.
- Despawn lands on the enemy, not 1.8 units past it.

The brief's "no interpolation for projectiles" is still true in the
literal sense (no two-snapshot lerp). Projectiles have a closed-form
position function that is sampled at render-time minus the standard
delay. They live in the same time-base as everything else.

### AD3. Server collision = swept-circle, per tick

A Bolt projectile travels `0.9 units / tick`, and `projRadius +
enemyRadius = 0.9`. A simple per-tick point-or-circle test will tunnel
on near-tangent shots — visible hit, scored miss. With faster weapons
later it gets worse.

Each tick, for each projectile, the server computes the segment
`(prevX, prevZ) → (x, z)` and finds the closest distance from each
enemy center to that segment (clamped parameter `u ∈ [0, 1]`). Hit if
`closestDist² < (projRadius + enemyRadius)²`. Six lines of math, no
substepping, no tuning. Generalizes to all future weapons regardless of
speed.

### AD4. `activeProjectiles` is a server-local array on GameRoom

Plain `Projectile[]`, mirror of how `spawner: SpawnerState` lives on
GameRoom (M3 AD1). Per CLAUDE.md rule 2 (synced state in schema only,
contrapositive: server-only state stays off schema), and per the
fire-and-hit event model — projectiles are an event stream, not entity
state.

```ts
type Projectile = {
  fireId: number;
  ownerId: string;
  weaponKind: number;
  damage: number;
  speed: number;
  radius: number;
  lifetime: number;
  age: number;
  dirX: number;          // pre-normalized
  dirZ: number;
  prevX: number;         // for swept-circle
  prevZ: number;
  x: number;
  z: number;
};
```

### AD5. `fireId` and `nextGemId` are server-local counters on GameRoom

Same pattern as `spawner.nextEnemyId` (M3 AD1). Both start at 1 so id=0
is never valid. The brief proposed putting `nextGemId` on `RoomState`;
keeping it off the schema preserves the M3 precedent — server-only
counters do not pollute the schema.

### AD6. Tick order: players → enemies → weapons → projectiles → gems → spawner

Each step assumes the previous step has already updated the world this
tick:

- **Players** first so weapons see updated positions for targeting.
- **Enemies** next so weapons target enemies at their this-tick position
  (otherwise weapons would consistently shoot one tick behind).
- **Weapons** before projectiles so a same-tick fire is integrated by
  `tickProjectiles` next tick (the projectile starts with `age = 0` and
  is added to `activeProjectiles` between the two calls — the next tick
  is when it actually moves).
- **Projectiles** before gems so a this-tick kill drops a gem before
  pickup checks run, allowing same-tick collect-on-kill (rare but
  consistent).
- **Gems** before spawner so a freshly-spawned enemy at gem-spawn radius
  doesn't accidentally interact with a fresh gem (no overlap geometry,
  but the rule is "spawner runs last to give every new entity one tick
  of grace before any other system touches it").
- **Spawner** last so newly-spawned enemies don't get attacked or hit
  until next tick. Important for fairness — every enemy gets one tick of
  existence before it can die.

This order is load-bearing for fairness and consistency. Documented in
CLAUDE.md as rule 11. Do not reorder without revisiting these
invariants.

### AD7. Damage authority is the server's `tickProjectiles` walk

Within `tickProjectiles`, when a swept-circle test reports a hit:

1. `enemy.hp -= damage`
2. `emit({ type: "hit", fireId, enemyId, damage, serverTick })`
3. If `enemy.hp ≤ 0`:
   - Build a `Gem` at `(enemy.x, enemy.z)` with `id = ctx.nextGemId()`,
     `value = GEM_VALUE`. Set into `state.gems` keyed by `String(id)`.
   - Remove enemy from `state.enemies`.
   - `emit({ type: "enemy_died", enemyId, x, z })`.
4. Mark this projectile for removal (consumed by hit).

Multi-projectile-same-tick on a single enemy is naturally handled:
subsequent projectiles iterating the same `state.enemies` find the
already-removed enemy gone and continue to other targets (or expire by
lifetime).

Order of `hit` then `enemy_died` matters for client VFX: hit flash
references an enemy that still exists in `state.enemies` at the moment
the client's `hit` handler reads its position. The schema-removal then
`enemy_died` event arrives next.

### AD8. Multi-player gem pickup: first-by-insertion-order wins

`tickGems` iterates gems in their `MapSchema` insertion order. For each
gem it iterates `state.players` in insertion order; first player within
`GEM_PICKUP_RADIUS²` wins — `player.xp += gem.value`, emit
`gem_collected`, remove gem, break to next gem.

Deterministic and dependency-free. The two-players-on-the-same-gem case
is rare; whichever joined first gets the pickup. If this becomes a
gameplay annoyance later, the fix is a magnet/explicit-ownership system,
not a tiebreak hack.

### AD9. Projectile owner-leaving the room: orphans keep flying

If a player disconnects (consented or grace-expired) while their
projectiles are mid-flight, the projectiles stay in `activeProjectiles`
until lifetime expiry. They can still hit enemies. The `ownerId` field
on `FireEvent` is for client-side VFX attribution only; the simulation
itself doesn't read it after fire-time. Cheaper than a teardown sweep,
and the visible game state stays sensible.

### AD10. Initial cooldown on weapon at player join = 0; cooldown clamps at 0 with no target

A new player gets the first shot the instant any enemy is in range —
joining a swarm should feel responsive, not "wait 0.6s." When a weapon's
`cooldownRemaining` reaches 0 but no enemy is within
`TARGETING_MAX_RANGE`, it stays clamped at 0 (does not go negative)
until a target enters range, at which point it fires immediately. This
is the standard auto-attack feel for the genre.

## Architecture

```
shared/
  schema.ts          + WeaponState (new), + Gem (new),
                     + Player.{xp, level, weapons: ArraySchema<WeaponState>},
                     + RoomState.gems: MapSchema<Gem>
                       (Enemy schema unchanged — hp already exists from M3)
  weapons.ts (NEW)   pure data table: WEAPON_KINDS, types
  constants.ts       + ENEMY_HP, ENEMY_RADIUS, GEM_PICKUP_RADIUS,
                       GEM_VALUE, PROJECTILE_MAX_CAPACITY, TARGETING_MAX_RANGE
  messages.ts        + FireEvent, HitEvent, EnemyDiedEvent, GemCollectedEvent
                     + PongMessage.serverNow
  rules.ts           + tickWeapons, + tickProjectiles, + tickGems
                     + Projectile type, + Emit/CombatEvent types,
                     + WeaponContext type
  rng.ts             unchanged
  index.ts           re-export new symbols (incl. weapons.ts)

server/
  GameRoom.ts        tick order: tickPlayers → tickEnemies → tickWeapons →
                       tickProjectiles → tickGems → tickSpawner
                     + activeProjectiles: Projectile[]
                     + nextFireId, nextGemId counters
                     + weaponCtx, projectileCtx pre-built in onCreate
                     + onJoin pushes a Bolt WeaponState onto player.weapons
                     + pong handler sends serverNow alongside echoed t

client/
  net/
    serverTime.ts (NEW) ServerTime class: smoothed server-clock offset
    client.ts         unchanged
    snapshots.ts      unchanged (reused for player+enemy interp)
    prediction.ts     unchanged (M2 local prediction is independent)
    hudState.ts       + xp, cooldownFrac, serverTimeOffsetMs, projectileCount
  game/
    GameView.tsx      + ServerTime instance, + room.onMessage handlers for
                       fire/hit/enemy_died/gem_collected, + mounts of new
                       components below, + extended pong handler
    ProjectileSwarm.tsx (NEW) single InstancedMesh of capacity 256;
                       closed-form position from FireEvent + ServerTime
    GemSwarm.tsx      (NEW) single InstancedMesh; samples state.gems
    CombatVfx.tsx     (NEW) plain-mesh hit/death/pickup flashes
    PlayerHud.tsx     (NEW) always-on per-player XP / level / weapon /
                       cooldown bar (bottom-left)
    DebugHud.tsx      + 3 lines: srvOffset, projectiles, fire rate
    EnemySwarm.tsx    unchanged
    PlayerCube.tsx    unchanged
    Ground.tsx        unchanged
    input.ts          unchanged
```

## Schema

```ts
// packages/shared/src/schema.ts (additions only)

export class WeaponState extends Schema {
  declare kind: number;
  declare level: number;
  declare cooldownRemaining: number;
  constructor() {
    super();
    this.kind = 0;
    this.level = 1;
    this.cooldownRemaining = 0;
  }
}
defineTypes(WeaponState, {
  kind: "uint8",
  level: "uint8",
  cooldownRemaining: "number",
});

export class Gem extends Schema {
  declare id: number;
  declare x: number;
  declare z: number;
  declare value: number;
  constructor() {
    super();
    this.id = 0;
    this.x = 0;
    this.z = 0;
    this.value = 0;
  }
}
defineTypes(Gem, {
  id: "uint32",
  x: "number",
  z: "number",
  value: "uint16",
});
```

`Player` gains:
```ts
declare xp: number;
declare level: number;
declare weapons: ArraySchema<WeaponState>;
// constructor body:
this.xp = 0;
this.level = 1;
this.weapons = new ArraySchema<WeaponState>();
// defineTypes:
xp: "uint32", level: "uint8", weapons: [WeaponState],
```

`RoomState` gains:
```ts
declare gems: MapSchema<Gem>;
// constructor body:
this.gems = new MapSchema<Gem>();
// defineTypes:
gems: { map: Gem },
```

Schema discipline as always: `declare`-fields plus constructor-body
assignment. No class-field initializers (the esbuild
`Object.defineProperty` landmine that bypasses defineTypes() prototype
setters; see the long comment block at the top of `schema.ts`).

`Enemy` schema is unchanged — `hp: uint16` already exists from M3.

## Constants

```ts
// packages/shared/src/constants.ts (additions only)

export const ENEMY_HP = 30;                 // 3 Bolt hits @ 10 dmg
export const ENEMY_RADIUS = 0.5;            // matches the cone visual
export const GEM_PICKUP_RADIUS = 1.5;
export const GEM_VALUE = 1;
export const PROJECTILE_MAX_CAPACITY = 256; // server cap + client InstancedMesh
export const TARGETING_MAX_RANGE = 20;
```

`tickSpawner` and `spawnDebugBurst` change `enemy.hp = 1` to
`enemy.hp = ENEMY_HP`.

## Weapons table

```ts
// packages/shared/src/weapons.ts (NEW — pure data, no Schema, no methods)

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
```

Re-exported from `shared/index.ts`. Imported by `rules.ts` and the client.

## Messages

Server→client events (broadcast via `room.broadcast(type, payload)`).
Not `ClientMessage` variants — rule 3 governs the client→server union
only. Each is documented in `messages.ts` so a grep on the file finds
the shape.

```ts
export type FireEvent = {
  type: "fire";
  fireId: number;
  weaponKind: number;
  ownerId: string;
  originX: number;
  originZ: number;
  dirX: number;             // pre-normalized
  dirZ: number;             // pre-normalized
  serverTick: number;       // for debugging / correlation
  serverFireTimeMs: number; // server Date.now() at fire (drives client closed-form sim)
};

export type HitEvent = {
  type: "hit";
  fireId: number;
  enemyId: number;
  damage: number;
  serverTick: number;
};

export type EnemyDiedEvent = {
  type: "enemy_died";
  enemyId: number;
  x: number;
  z: number;
};

export type GemCollectedEvent = {
  type: "gem_collected";
  gemId: number;
  playerId: string;
  value: number;
};
```

`PongMessage` is extended (existing `t` field unchanged):

```ts
export type PongMessage = {
  type: "pong";
  t: number;          // echoed from PingMessage.t (existing — drives RTT)
  serverNow: number;  // NEW — server Date.now() at echo (drives serverTimeOffset)
};
```

`MessageType` constant gains `Fire`, `Hit`, `EnemyDied`, `GemCollected`
entries (string-only, type-name parity with the existing
`Ping`/`Pong`/`Input` shape).

## Rules

```ts
// packages/shared/src/rules.ts (additions; existing functions unchanged)

import type { WeaponKind } from "./weapons.js";
import type { FireEvent, HitEvent, EnemyDiedEvent, GemCollectedEvent } from "./messages.js";

export type Projectile = {
  fireId: number;
  ownerId: string;
  weaponKind: number;
  damage: number;
  speed: number;
  radius: number;
  lifetime: number;
  age: number;
  dirX: number;
  dirZ: number;
  prevX: number;
  prevZ: number;
  x: number;
  z: number;
};

export type CombatEvent = FireEvent | HitEvent | EnemyDiedEvent | GemCollectedEvent;
export type Emit = (event: CombatEvent) => void;

export type WeaponContext = {
  nextFireId: () => number;       // closure over GameRoom.nextFireId++
  serverNowMs: () => number;      // closure over Date.now()
  pushProjectile: (p: Projectile) => void;
};

export type ProjectileContext = {
  nextGemId: () => number;        // closure over GameRoom.nextGemId++
};

export function tickWeapons(
  state: RoomState,
  dt: number,
  ctx: WeaponContext,
  emit: Emit,
): void;

export function tickProjectiles(
  state: RoomState,
  active: Projectile[],
  dt: number,
  ctx: ProjectileContext,
  emit: Emit,
): void;

export function tickGems(
  state: RoomState,
  emit: Emit,
): void;
```

The callback shape (`nextFireId`, `nextGemId`, `serverNowMs`,
`pushProjectile`) preserves the "rules.ts is pure functions over state +
dt + rng + emit" pattern. Rules can't import Colyseus or read GameRoom
counters directly — closures from the room provide that surface without
violating package boundaries. Same shape as how `mulberry32(seed)` is
closed over by the room and passed in.

### `tickWeapons` body

For each player, for each weapon entry:
1. `weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt)`.
2. If `cooldownRemaining > 0`: continue (still cooling down).
3. Otherwise (ready to fire), find nearest enemy within
   `TARGETING_MAX_RANGE²`. Squared-distance comparison; no
   `Math.hypot` per pair.
4. If no target: leave cooldown clamped at 0; continue. (AD10.)
5. Compute `dx = target.x - player.x`, `dz = target.z - player.z`,
   `dist = Math.sqrt(dx² + dz²)`, `dirX = dx/dist`, `dirZ = dz/dist`.
   (`dist > 0` guaranteed by the target's range check; an enemy
   coincident with a player would have squared-distance 0, but
   `TARGETING_MAX_RANGE > 0` doesn't exclude that — defensively, skip
   firing if `dist === 0`.)
6. `weapon.cooldownRemaining = WEAPON_KINDS[weapon.kind].cooldown`.
7. Build a `Projectile` with `prevX = originX = player.x`,
   `prevZ = originZ = player.z`, `x = originX`, `z = originZ`,
   `age = 0`, the kind's speed/radius/damage/lifetime, and
   `fireId = ctx.nextFireId()`. Call `ctx.pushProjectile(p)`.
8. `emit({ type: "fire", fireId, weaponKind: weapon.kind, ownerId:
   player.sessionId, originX, originZ, dirX, dirZ, serverTick:
   state.tick, serverFireTimeMs: ctx.serverNowMs() })`.

### `tickProjectiles` body

Single pass over `active` with in-place compaction (write index `w`
trails read index `r`; survivors copied forward, then `active.length =
w`). No allocation per tick beyond the events themselves and the new
Gem on death.

For each projectile:
1. `prevX = x; prevZ = z;` `x += dirX*speed*dt;` `z += dirZ*speed*dt;`
   `age += dt;`
2. If `age >= lifetime`: drop. Continue.
3. Swept-circle vs. each enemy in `state.enemies`:
   - segment from `(prevX, prevZ)` to `(x, z)`; vector
     `seg = (x - prevX, z - prevZ)`; length² `segLen2 = seg.x² + seg.z²`.
   - For each enemy: `to = (enemy.x - prevX, enemy.z - prevZ)`;
     parameter `u = clamp((to.x*seg.x + to.z*seg.z) / segLen2, 0, 1)`
     (only if `segLen2 > 0`; else `u = 0`); closest point on segment is
     `(prevX + u*seg.x, prevZ + u*seg.z)`; squared distance from enemy
     to that point compared to `(radius + ENEMY_RADIUS)²`.
   - First enemy whose closest point is within sum-of-radii is the hit
     target. (Iterate `state.enemies` in insertion order; first
     intersected wins. The cost of finding *the closest along the
     segment* over multiple intersections doesn't matter at this enemy
     count — but if it does in practice, that's a future optimization.)
4. On hit:
   - `enemy.hp -= damage`.
   - `emit({ type: "hit", fireId, enemyId: enemy.id, damage, serverTick: state.tick })`.
   - If `enemy.hp <= 0`:
     - Build `Gem`: `id = ctx.nextGemId()`, `x = enemy.x`, `z = enemy.z`,
       `value = GEM_VALUE`. `state.gems.set(String(id), gem)`.
     - `state.enemies.delete(String(enemy.id))`.
     - `emit({ type: "enemy_died", enemyId: enemy.id, x: enemy.x, z: enemy.z })`.
   - Drop projectile. Continue.
5. Otherwise: keep projectile.

### `tickGems` body

```ts
state.gems.forEach((gem, key) => {
  let collector: Player | undefined;
  state.players.forEach((p) => {
    if (collector) return;                                       // first wins
    const dx = p.x - gem.x; const dz = p.z - gem.z;
    if (dx*dx + dz*dz <= GEM_PICKUP_RADIUS * GEM_PICKUP_RADIUS) collector = p;
  });
  if (!collector) return;
  collector.xp += gem.value;
  state.gems.delete(key);
  emit({ type: "gem_collected", gemId: gem.id, playerId: collector.sessionId,
         value: gem.value });
});
```

### Determinism

`tickWeapons`, `tickProjectiles`, `tickGems` are RNG-free. No
`Math.random` reachable from any combat path. The fire-time `Date.now()`
is wallclock, used only for the *client* render time-base — gameplay
outcomes (hit/no-hit) are determined entirely by integer state and `dt`.

## Server

### `packages/server/src/GameRoom.ts` changes

New private fields:
```ts
private activeProjectiles: Projectile[] = [];
private nextFireId = 1;
private nextGemId = 1;
private weaponCtx!: WeaponContext;        // assigned in onCreate
private projectileCtx!: ProjectileContext;
```

`onCreate` extensions:
```ts
this.weaponCtx = {
  nextFireId: () => this.nextFireId++,
  serverNowMs: () => Date.now(),
  pushProjectile: (p) => this.activeProjectiles.push(p),
};
this.projectileCtx = { nextGemId: () => this.nextGemId++ };
```

The contexts are built once and reused every tick — recreating the
closures per tick is wasteful and the captures (the room, its counters)
are stable for the room's lifetime.

`pong` handler updated:
```ts
this.onMessage<PingMessage>("ping", (client, message) => {
  const t = Number(message?.t);
  if (!Number.isFinite(t)) return;
  client.send("pong", { type: "pong", t, serverNow: Date.now() });
});
```

`onJoin` extension: after creating and inserting the `Player`, push a
default Bolt weapon onto `player.weapons`:
```ts
const w = new WeaponState();
w.kind = 0;
w.level = 1;
w.cooldownRemaining = 0;
player.weapons.push(w);
```

Initial `cooldownRemaining = 0` per AD10 — first shot is immediate when
an enemy enters range.

`tick()` body (replaces the M3 body):
```ts
private tick(): void {
  this.state.tick += 1;
  const emit: Emit = (e) => this.broadcast(e.type, e);
  tickPlayers(this.state, SIM_DT_S);
  tickEnemies(this.state, SIM_DT_S);
  tickWeapons(this.state, SIM_DT_S, this.weaponCtx, emit);
  tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S,
                  this.projectileCtx, emit);
  tickGems(this.state, emit);
  tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
}
```

`onLeave`: existing logic is unchanged. The `Player` deletion (consented
or grace-expired) takes the player's `ArraySchema<WeaponState>` with it.
Orphaned projectiles in `activeProjectiles` keep flying per AD9.

### Cap on `activeProjectiles`

Defense in depth: if `activeProjectiles.length >= PROJECTILE_MAX_CAPACITY`
when `pushProjectile` is called, log a one-shot warning and drop the
push (also skip the `emit("fire", …)` so clients aren't told about a
projectile that won't be simulated server-side). At Bolt's parameters
the steady-state count for 10 players is ~13; hitting 256 means
something has gone wrong upstream and crashing the room is worse than
dropping the shot. Emit `console.warn` once per room when this first
happens.

## Client

### `packages/client/src/net/serverTime.ts` (new)

```ts
const ALPHA = 0.2;

export class ServerTime {
  offsetMs = 0;
  private initialized = false;

  observe(serverNow: number, halfRttMs: number): void {
    const sample = serverNow + halfRttMs - Date.now();
    if (!this.initialized) {
      this.offsetMs = sample;
      this.initialized = true;
      return;
    }
    this.offsetMs = this.offsetMs * (1 - ALPHA) + sample * ALPHA;
  }

  serverNow(): number {
    return Date.now() + this.offsetMs;
  }
}
```

A single instance per `GameView` mount, lifetime equals the Colyseus
room. Hooked into the existing `pong` handler:
```ts
const offPong = room.onMessage("pong", (msg: PongMessage) => {
  const rtt = Date.now() - Number(msg.t);
  hudState.pingMs = hudState.pingMs === 0 ? rtt : hudState.pingMs * 0.8 + rtt * 0.2;
  if (Number.isFinite(msg.serverNow)) {
    serverTime.observe(Number(msg.serverNow), rtt / 2);
    hudState.serverTimeOffsetMs = serverTime.offsetMs;
  }
});
```

### `packages/client/src/game/ProjectileSwarm.tsx` (new)

Single `InstancedMesh` of capacity `PROJECTILE_MAX_CAPACITY`. Receives
a plain `Map<fireId, FireEvent>` and a `ServerTime` from `GameView`.
`GameView`'s fire/hit handlers mutate the Map directly (`fires.set` /
`fires.delete`); `useFrame` walks the Map and additionally `delete`s any
entry whose `elapsed >= lifetime`. No slot allocator, no React state
for fire ids — Map iteration in JavaScript is insertion-order, so
projectiles naturally appear in the InstancedMesh in fire order.

Why no slot allocator (vs. the swap-and-pop pattern used by
`EnemySwarm`): projectiles have high turnover (~20+/sec at peak), and
the matrix matrix-update cost is the same whether slots are stable or
re-walked each frame. The slot allocator's value is *re-using slot
indices for stable per-instance attributes*; we have none. Skipping it
saves a Set-state path through React.

`useFrame`:
```ts
const renderServerTimeMs = serverTime.serverNow() - hudState.interpDelayMs;
let i = 0;
for (const [fireId, fe] of fires) {
  const elapsed = (renderServerTimeMs - fe.serverFireTimeMs) / 1000;
  if (elapsed >= fe.lifetime) { fires.delete(fireId); continue; }
  if (i >= PROJECTILE_MAX_CAPACITY) break;       // defense; should never hit
  const t = elapsed > 0 ? elapsed : 0;
  matrix.makeTranslation(
    fe.originX + fe.dirX * fe.speed * t,
    PROJECTILE_RENDER_Y,
    fe.originZ + fe.dirZ * fe.speed * t,
  );
  mesh.setMatrixAt(i, matrix);
  i++;
}
mesh.count = i;
mesh.instanceMatrix.needsUpdate = true;
hudState.projectileCount = i;
```

Mid-iteration `Map.delete` of the *current* key is well-defined in JS
(the iterator advances past the deleted entry) — that's the standard
pattern for in-place pruning during iteration.

Geometry: a small bright sphere or short cylinder. Final shape decided
at implementation time; both are one-line geometry calls.
`PROJECTILE_RENDER_Y` is a render-only constant (≈0.6, level with
enemies), local to the file.

### `packages/client/src/game/GemSwarm.tsx` (new)

Same swap-and-pop slot allocator as `EnemySwarm`, but fed by
`state.gems.onAdd` / `state.gems.onRemove` (gems ARE schema entities, so
Colyseus drives the lifecycle). Per-frame matrix update reads
`state.gems.get(idAtSlot[i]).{x,z}` directly — gems don't move so no
interpolation is needed; one-frame staleness of position is invisible.

Geometry: small octahedron, emissive material. Floats slightly above
ground (`y ≈ 0.4`).

### `packages/client/src/game/CombatVfx.tsx` (new)

Three small ref-arrays of `{ x, z, t0 }` for hit / death / pickup
flashes. `useFrame` advances each, computes `age = now - t0`, drops once
`age > 0.2s`. Renders each as a `<mesh>` with emissive material whose
opacity and scale decay linearly with age.

Peak count is bounded by hits-per-second × 0.2s, single digits at the
peak of combat. Plain `<mesh>` in `.map` is fine — no InstancedMesh
needed.

`fire` events do not produce VFX (the projectile itself is the VFX).
`hit` events produce a hit-flash at the rendered enemy position
(`enemyBuffers.get(enemyId)?.sample(performance.now() - interpDelayMs)`
— same time-base as the projectile, so the flash lands exactly where the
projectile despawns). `enemy_died` produces a slightly larger flash at
the dying enemy's position (already in the event payload). `gem_collected`
produces a small pulse on the collecting player.

### `packages/client/src/game/PlayerHud.tsx` (new)

Always-on (not gated by F3). Bottom-left, simple monospace HUD. Reads
`room.state.players` via the same `getStateCallbacks` path used in
`GameView.tsx`. One row per player:

```
Alice   XP 12   Lv 1   ▓▓▓░░  Bolt
Bob     XP  3   Lv 1   ▓░░░░  Bolt
```

Cooldown bar fraction: `1 - (cooldownRemaining / WEAPON_KINDS[kind].cooldown)`
(full = ready, empty = just fired). Reads `weapons[0]` for now;
future weapon UI is a separate cleanup.

Throttled re-render: rAF-driven `force` like `DebugHud`, 60fps is fine
for two players. For 10 players it's still negligible.

### `packages/client/src/game/GameView.tsx` extensions

In the existing `useEffect`:

```ts
const serverTime = serverTimeRef.current;        // useRef'd singleton
const fires = firesRef.current;                  // useRef<Map<number, FireEvent>>

// pong: extended below the existing RTT line
const offPong = room.onMessage("pong", (msg: PongMessage) => {
  const rtt = Date.now() - Number(msg.t);
  hudState.pingMs = hudState.pingMs === 0 ? rtt : hudState.pingMs * 0.8 + rtt * 0.2;
  if (Number.isFinite(msg.serverNow)) {
    serverTime.observe(Number(msg.serverNow), rtt / 2);
    hudState.serverTimeOffsetMs = serverTime.offsetMs;
  }
});

// New combat-event handlers:
const offFire = room.onMessage("fire", (msg: FireEvent) => {
  fires.set(msg.fireId, msg);
});
const offHit = room.onMessage("hit", (msg: HitEvent) => {
  fires.delete(msg.fireId);
  const enemyPos = enemyBuffers.get(msg.enemyId)?.sample(performance.now() - hudState.interpDelayMs);
  if (enemyPos) vfx.pushHit(enemyPos.x, enemyPos.z);
});
const offDied = room.onMessage("enemy_died", (msg: EnemyDiedEvent) => {
  vfx.pushDeath(msg.x, msg.z);
});
const offCollected = room.onMessage("gem_collected", (msg: GemCollectedEvent) => {
  // Player position pulled from the rendered buffer; pickup flash on it.
  const buf = buffers.get(msg.playerId);
  const pos = buf?.sample(performance.now() - hudState.interpDelayMs);
  if (pos) vfx.pushPickup(pos.x, pos.z);
});
```

Cleanup additions in the effect's `return`: `offFire(); offHit();
offDied(); offCollected();` and `fires.clear()`.

### `packages/client/src/net/hudState.ts` extensions

```ts
xp: number;                  // local player only
cooldownFrac: number;        // local player; 0..1 (ready=1)
serverTimeOffsetMs: number;  // debug
projectileCount: number;     // debug — active projectiles this frame
```

Local-player XP/cooldown are mutated in the same place as `reconErr`:
inside the local player's `onChange` handler in `GameView.tsx`,
re-read `player.xp` and `player.weapons[0]?.cooldownRemaining`.

### `DebugHud.tsx`

Three new lines under the existing block:
```
srv offset  ${hudState.serverTimeOffsetMs.toFixed(0)} ms
projectiles ${hudState.projectileCount}
xp / cd     ${hudState.xp} / ${hudState.cooldownFrac.toFixed(2)}
```

## Tests

### `packages/shared/test/rules.test.ts` extensions

Existing `tickPlayers` / `tickEnemies` / `tickSpawner` blocks stay. New
blocks:

**`tickWeapons`** (5 tests)
1. Cooldown decrements by `dt` each tick when no enemies; doesn't fire
   while > 0.
2. Cooldown ≤ 0 with target in range: emits exactly one `fire` event,
   resets to `WEAPON_KINDS[0].cooldown`, pushes one projectile via the
   spy. `fireId` matches the spy's assigned id. `serverFireTimeMs` came
   from the `serverNowMs` callback.
3. Cooldown ≤ 0 with no enemies: no fire emitted, cooldown stays
   clamped at 0 (multi-tick assertion: still 0 after another `tickWeapons`
   call with empty `state.enemies`).
4. Two enemies at different distances: target = nearest; check
   `dirX, dirZ` exactly (pre-normalized).
5. Out-of-range enemy ignored (just outside `TARGETING_MAX_RANGE`).

**`tickProjectiles`** (6 tests)
1. Projectile fully past lifetime → removed, no hit emitted.
2. Projectile head-on into stationary enemy: hit detected, damage
   applied, `hit` emitted, projectile removed.
3. **Swept-circle tangent case** (the AD3 regression): projectile aimed
   so its segment passes within `radius_sum` of an enemy center, with
   both endpoints *outside* the radius. Simple point test would miss;
   swept must catch.
4. Lethal hit (hp drops to 0 or below): enemy removed from
   `state.enemies`, `enemy_died` emitted, gem inserted into `state.gems`
   at enemy's position, `gemId` matches the `nextGemId` callback output.
5. Two projectiles in same tick, same enemy with hp = damage: first
   hits and kills, second finds no enemy (already removed) and continues
   until lifetime.
6. Projectile vs. multiple enemies — hits the first one its segment
   intersects (insertion-order tiebreak; documented behavior).

**`tickGems`** (3 tests)
1. Player exactly on gem: pickup. xp incremented by `value`, gem
   removed, event emitted.
2. Player at distance > pickup radius: no pickup.
3. Two players both within radius: first by insertion order wins
   (deterministic).

### `packages/shared/test/schema.test.ts` extensions
- `WeaponState` round-trip (encode → decode → all three fields preserved).
- `Gem` round-trip.
- `Player.weapons: ArraySchema<WeaponState>` round-trip with one entry
  and with two entries (forward-compat).
- `RoomState.gems: MapSchema<Gem>` round-trip.

These catch the esbuild field-initializer landmine specifically for the
new schema classes.

### `packages/server/test/integration.test.ts` extensions

**End-to-end kill + gem.** Single client. Send `debug_spawn` to fire
~20 enemies. They spawn at `ENEMY_SPAWN_RADIUS = 30` from the player,
which is outside `TARGETING_MAX_RANGE = 20`, then walk inward at
`ENEMY_SPEED = 2 u/s`. After ~5–6s the first enemies enter range; the
auto-firing weapon (Bolt, 0.6s cooldown, 10 dmg) needs 3 hits per kill
against `ENEMY_HP = 30`. Wait ~12s wall-clock to give combat plenty of
time to resolve. Assert: `state.gems.size > 0` (some enemies died),
`state.enemies.size < 20` (some enemies were removed). Tolerances are
loose; this test catches "the death-and-gem path is wired" not exact
combat tuning.

**End-to-end XP gain.** Same setup. After gems exist, pick one (read
its `(x, z)` from `state.gems`) and send `input` messages walking the
player straight toward it (`dir.x = sign(gem.x - player.x)`,
`dir.z = sign(gem.z - player.z)`, `seq` incremented per message, sent
every ~50ms). Wait until `player.xp > 0` or 5s elapse. Assert:
`player.xp > 0`, the chosen gem's id no longer present in
`state.gems`.

**Cross-client determinism (the AD1/AD2 regression).** Two clients
connect to the same room. Both register `room.onMessage("fire", ...)`
handlers and capture every event's `(fireId, originX, originZ, dirX,
dirZ, serverFireTimeMs)`. Run for ~3s with at least one auto-spawned
enemy so multiple fires occur. After the run, for every `fireId`
observed by both clients, assert the captured fields are bit-identical
across the two clients. (Receive *time* differs — that's expected; the
*content* must match.)

### Deliberate omissions
- No client React tests for `ProjectileSwarm` / `GemSwarm` / `CombatVfx`
  / `PlayerHud`. Same reasoning as M3 — no jsdom + R3F infrastructure.
  Rely on manual verification + the cross-client determinism integration
  test for the load-bearing parts.

## Verification

### Manual checks (after dev loop is wired)

1. **Auto-fire visible.** Two browser tabs, both join. Within ~1s of
   the first enemy spawning, both players' weapons start auto-firing at
   nearest enemies. Visible projectiles fly out of each player toward
   their target.
2. **Cross-client visual determinism.** Pick a single in-flight
   projectile (use the slow-motion of a Bolt's 0.8s lifetime). Same
   world position in both tabs at the same wall-clock moment. The
   `srvOffset` debug HUD line stays stable around a small value (<10ms
   on localhost; tens-to-hundreds on real network) — drift would
   manifest as projectiles slowly diverging across clients.
3. **Hits and deaths.** Hit flashes land on rendered enemies (not in
   mid-air, not behind them). Enemies die after exactly 3 hits. Gems
   drop at the enemy's death position.
4. **Pickup.** Walk over a gem; XP ticks up on `PlayerHud`. Gem vanishes
   from both tabs in the same frame.
5. **Cross-client gem positions.** Both tabs see identical gems in
   identical positions; pickups consistent (one tab can't see a gem
   that the other doesn't).
6. **200 enemies.** Press `]`/`}` to spawn 200. Combat continues.
   `fps` holds 60 in both tabs. `projectileCount` HUD line stays small
   (typically 0–20).
7. **Throttled.** DevTools → Fast 3G on one tab. Combat still functions.
   The throttled tab's projectiles may visibly lag and cross-tab
   determinism may degrade under heavy throttling — note the magnitude
   in README rather than fail the test. The throttled tab itself stays
   self-consistent (no jitter, no snap).
8. **Reconnect mid-combat.** Drop tab A to "Offline" for 5s within the
   30s grace window. Restore. Tab A reconnects; schema state correct
   (xp, enemies, gems all match tab B). In-flight projectiles at the
   moment of disconnect are gone from tab A's view — expected, no event
   replay.
9. `pnpm typecheck` and `pnpm test` green.

### Performance check (after manual verification passes)

Two clients connected. Note baseline HUD numbers and server log baseline
(0 enemies, both players idle).

**Phase 1 — 200 enemies.** Press `}` twice. Players will start chewing
through them. Wait ~5s for steady state. Record:
- Client fps both tabs (target 60).
- Server tick rate (target 20Hz; check `serverTick` HUD line).
- Server log: per-tick patch bytes, full-state bytes.
- HUD `projectileCount` (typical and peak).
- HUD `srv offset` (should stay stable, not drift).

**Phase 2 — 300 enemies.** One more `}`. We hit `MAX_ENEMIES`. Note:
- fps drop?
- Server tick fall-behind?
- Snapshot growth pattern?

**Stop conditions:**
- If per-tick patch bytes > 50 KB at 200 enemies, **stop**. Diagnose
  before optimizing. (Each `WeaponState.cooldownRemaining` change is
  one float per active player per tick — ~16 bytes × 2 players ≈ 32
  bytes; this should not blow the budget. If it does, the schema cost
  of cooldown ticking is the suspect — consider quantizing or only
  syncing on fire-cycle boundaries. Don't optimize blindly.)
- If client fps drops at 200 enemies, **stop**. Diagnose first: VFX
  array growing unbounded? `ProjectileSwarm` slot table thrash?
  `CombatVfx` `<mesh>` count?

### Record numbers in README

Append a section:

```
## Manual perf test (M4)

Run on <date>, <hardware>, 2 connected Chrome clients.

| Enemies | Client FPS | Server tick | Patch bytes/tick | Full-state bytes | Peak projectiles |
|--------:|-----------:|------------:|-----------------:|-----------------:|-----------------:|
| 0       | 60         | 20Hz        | <baseline>       | <baseline>       | 0                |
| 200     | <num>      | <num>       | <num>            | <num>            | <num>            |
| 300     | <num>      | <num>       | <num>            | <num>            | <num>            |

Notes: <observations — VFX behavior, srv offset stability, any
cross-client divergence on Fast 3G>.
```

Numbers go in honestly, even if disappointing.

## CLAUDE.md additions

Append two new rules under "Architectural rules":

> **11. Tick order.** Each server tick runs in this fixed order:
> `tickPlayers → tickEnemies → tickWeapons → tickProjectiles → tickGems → tickSpawner`.
> Players first so weapons see fresh positions; weapons before
> projectiles so a same-tick fire is integrated next tick (it starts
> with `age = 0` and the projectile's first movement is in the
> *following* `tickProjectiles` call); gems after projectiles so
> this-tick deaths drop pickups before pickup checks run; spawner last
> so freshly-spawned enemies get one tick of grace before any other
> system touches them. This order is load-bearing for fairness — do
> not reorder.

> **12. Combat events are server→client only and time-based, not state.**
> `fire`, `hit`, `enemy_died`, `gem_collected` are broadcast events,
> not schema entries. Projectiles are simulated client-side as a
> closed-form function of the `fire` event payload and a synced server
> clock (extended `pong` carries `serverNow`; client smooths
> `serverTimeOffsetMs`). Projectiles render at the same `interpDelayMs`
> as state interpolation, so hit feedback aligns with the rendered
> enemy. Adding a new weapon means adding a row to `WEAPON_KINDS` and
> (if non-trivial) a new `targeting` mode — never new sync logic.

These capture the load-bearing decisions for every future weapon and
pickup type.

## Future work (deliberately deferred)

- **Level-up flow + second weapon (M5).** The structural test of the
  weapon table — adding a second weapon must require no architectural
  changes. The third weapon onward is content.
- **Magnet pickup.** Vampire-Survivors-style XP attraction radius.
  Easy add: a `tickMagnet` step before `tickGems` that mutates gem
  positions toward nearby players, preserving the radius pickup.
- **Hit prediction on the client.** If the despawn-on-hit delay turns
  out to be objectionable (it shouldn't be — AD2 should mask it),
  predict hits client-side and reconcile with server hit events.
- **Camera shake / screen flash.** Game-feel pass.
- **Sound.** Dedicated milestone with proper spatial audio, mixing,
  AudioContext unlocking, voice limiting.
- **Object pooling for projectiles.** Only if perf shows GC stutter at
  realistic loads. At the steady-state ~13 projectiles for 10 players,
  allocation per fire is fine.
- **Extracted `SlotTable` class.** Currently used by `EnemySwarm` and
  `GemSwarm`. If a third use lands and the slot-allocator becomes a
  hot-bug area, extract it.
- **Snapshot delta optimization.** Don't add until perf check shows we
  need it. Quantizing `cooldownRemaining` is the most obvious target if
  combat-time snapshots blow the budget.
