# M6 — Playability pass: camera, map, HP, names, minimap

**Status:** Design — drafted 2026-05-06. Pending implementation plan.

## Goal

The game is deployed and playable, but the previous five milestones got us
ahead of the basic playability bar. M6 catches up. By the end the game
should feel like a real third-person co-op survivors-like, not a top-down
tech demo. This is a non-architectural milestone — the work is mostly
client-side polish and tuning. The shape of the codebase doesn't change;
the load-bearing additions (HP, downed, run-end, contact damage,
facing-as-state) all fit inside the existing schema/messages/rules
framework.

Five bundled items, chosen because they touch overlapping code:

1. **Third-person, fixed-world, twin-stick camera + controls.** Mouse
   raycast → ground plane → facing direction. WASD = movement.
2. **Larger map.** `MAP_RADIUS = 60`, soft clamp on players, despawn
   far-wandering enemies, visible boundary ring.
3. **Player HP, contact damage, downed state, spectator mode, run-over
   phase.** Single-life run; downed players become spectators until the
   last living teammate goes down.
4. **Player names + per-player HP bar billboarded above each cube.**
5. **Minimap.** 200×200px DOM `<canvas>` overlay, top-right.

## Non-goals

- No revive mechanic, no respawn, no extra lives. Single-life run.
- No HP regeneration of any kind (out-of-combat, lifesteal, healing
  pickups).
- No aim-directional weapons. Bolt remains auto-target-nearest. `facing`
  is rendered visually and synced through schema, but no weapon reads it.
  A future milestone introduces aim-coupled weapons cleanly.
- No gamepad support. Mouse + WASD only. Schema is gamepad-friendly
  (`facing` is a unit vector) so adding gamepad later is non-architectural.
- No camera free-look, zoom, rotate, lookback, or player-relative
  rotation. Fixed-world rotation only.
- No ground texture asset. Solid color + boundary ring; texture deferred
  to an art-pass milestone.
- No sound, screen shake, hit-stop, or camera kicks. Damage flash +
  floating numbers are the entirety of damage feedback.
- No revive UX scaffolding. Names rendering for downed players is
  deliberate (anticipates revive), but no UI gestures or affordances.
- No persistent scoreboard / meta-progression. Recap shows this run's
  numbers and disappears on leave.
- No per-room map sizing. `MAP_RADIUS` is a global constant; per-room
  variation is a future milestone with a corresponding `RoomState` field.
- No third weapon. M5 proved the abstraction; M6 doesn't add content.
- No cleanup of M5 weapon/level data on death. Downed players keep all
  their weapons frozen on the schema for the recap.

## Architectural decisions

These are load-bearing. Each binds future work; the implementation plan
treats them as fixed.

### AD1. Spectator-mode for downed players, not death-and-respawn

When `player.hp ≤ 0`, `downed = true` and the player's body remains in the
world at its last position. The run continues. Camera for downed local
players follows the first non-downed remote player (deterministic by
`MapSchema` iteration order). The run only ends when *every* player is
downed.

Why over respawn-with-penalty: kinder to early-fallen players in a 10-
player room (no 15-minute spectate); zero new mechanics; the body in the
world is a clean launching pad if a revive milestone lands later.

### AD2. `facing` syncs through schema, not events

Per-tick state, not a discrete moment. `Player.facingX/Z` lives on schema.
Future aim-directional weapons will read it from schema. Remote-cube
rotation reads it from schema. Cost is ~2 floats per player per tick of
patch deltas — negligible.

### AD3. `contactCooldown.ts` mirrors `orbitHitCooldown.ts`

Server-only ephemeral state, per-`(playerId, enemyId)` key, holds last
hit ms. Same `tryHit / evictEnemy / evictPlayer / sweep` API. Structural
type lives in `rules.ts` next to `OrbitHitCooldownLike`. This shape is
now the canonical "rate-limited recurring hit" pattern; future weapons
and hazards reuse it.

### AD4. All tick functions early-out on `state.runEnded`

A single `if (state.runEnded) return;` line at the top of every tick
function. Frozen world during the recap is one branch in each function,
not a per-system gate spread across the call sites.

### AD5. Tick order extension

```
tickPlayers → tickEnemies → tickContactDamage → tickRunEndCheck
            → tickWeapons → tickProjectiles → tickGems
            → tickXp → tickLevelUpDeadlines → tickSpawner
```

`tickContactDamage` after `tickEnemies` so contact tests see post-
movement positions. `tickRunEndCheck` immediately after so weapons,
projectiles, and the spawner all see the post-end state. Insertion is
deterministic and rng-free, so it does not fork the seeded schedule that
`tickXp` and `tickSpawner` consume. CLAUDE.md rule 11 is updated to
reflect the new order.

### AD6. Floating numbers split across `hit` and `player_damaged`

The existing `hit` event already carries enemy-side damage (`enemyId`,
`damage`, `serverTick`). Player-side damage gets a parallel
`player_damaged` event keyed by `playerId`. Splitting avoids overloading
`hit` with sessionId-vs-enemyId polymorphism and keeps the projectile-
cleanup path on `hit` untouched.

### AD7. Minimap is a 2D `<canvas>`, not a Three.js orthographic camera

Right fidelity for 200×200 px; trivially cheap (~18k iterations/sec at
worst case 300 enemies × 60 fps); sidesteps the InstancedMesh shadow-
camera landmine entirely (different shadow camera, different render
pass). Reads `room.state.{players, enemies}` directly each frame.

### AD8. Camera is fixed-world rotation with lerp-follow

Offset `[0, 9, 11]` from local-player render-pos. Lerp factor
`1 - exp(-dt / 0.15)` → ~150ms catch-up. World "up = north" stays
trivially correct on the minimap. Player-relative rotation deferred.

### AD9. `Player.kills` and `Player.xpGained` live on schema

Authoritative recap data survives reconnection within the grace window.
Client doesn't need to retain a perfect event log to render the recap.
`xpGained` is the lifetime sum (never drained on level-up); `xp` remains
the level-progress field.

### AD10. Map clamping happens in `tickPlayers`, not via collision

Direct radius clamp — `if (x²+z² > MAP_RADIUS²) scale (x,z) to MAP_RADIUS`.
`O(1)` per player. Consistent with the project's "no physics engine" rule.

### AD11. Enemy despawn, not enemy clamp

Enemies that wander beyond `ENEMY_DESPAWN_RADIUS = 50` from *any* non-
downed player are deleted in `tickEnemies` post-movement. Clamping enemies
to `MAP_RADIUS` would pile stuck enemies on the boundary as a player kites
along the edge; despawn handles the same problem cleanly. Eviction calls
`orbitHitCooldown.evictEnemy(id)`.

### AD12. `PLAYER_NAME_MAX_LEN = 16`

Tightened from the current 24. Spec value; tighter for billboards. Server
enforces in `onJoin` and any future name-setting handler. In-flight rooms
with longer names continue to work — the value is enforced on join, not on
existing schema state — but those names get truncated on next reconnect.

### AD13. Tuning constants are global, not per-room

`MAP_RADIUS`, `PLAYER_MAX_HP`, `ENEMY_CONTACT_DAMAGE`,
`ENEMY_DESPAWN_RADIUS`, etc. live in `shared/constants.ts`. Per-room
variation requires a follow-up milestone with corresponding `RoomState`
fields and matchmaker filters.

## Schema diff

### `shared/schema.ts` — `Player` additions

```ts
declare hp: number;        // uint16, default 100
declare maxHp: number;     // uint16, default 100
declare downed: boolean;   // default false
declare facingX: number;   // default 0
declare facingZ: number;   // default 1
declare kills: number;     // uint32, default 0
declare xpGained: number;  // uint32, default 0 — lifetime, never drained
declare joinTick: number;  // uint32, default 0 — set to state.tick on first join
```

### `shared/schema.ts` — `RoomState` additions

```ts
declare runEnded: boolean;     // default false
declare runEndedTick: number;  // uint32, default 0
```

All ten fields go through the **`declare` + constructor-init +
`defineTypes`** dance per the schema landmine documented at the top of
`schema.ts`. After edits: run `pnpm --filter @mp/shared build` and confirm
`pnpm --filter @mp/server test` (the integration test that boots a real
Colyseus server with two real WS clients) still passes.

## Constants diff (`shared/constants.ts`)

```ts
export const MAP_RADIUS = 60;                  // world units
export const PLAYER_RADIUS = 0.5;              // matches cube half-extent
export const PLAYER_MAX_HP = 100;
export const ENEMY_CONTACT_DAMAGE = 5;         // hp per contact
export const ENEMY_CONTACT_COOLDOWN_S = 0.5;   // per-(player, enemy) pair
export const ENEMY_DESPAWN_RADIUS = 50;        // beyond this from any non-downed player
export const PLAYER_NAME_MAX_LEN = 16;
```

Existing constants unchanged.

## Message protocol diff (`shared/messages.ts`)

### Extended: `InputMessage`

```ts
export type InputMessage = {
  type: "input";
  seq: number;
  dir: { x: number; z: number };
  facing: { x: number; z: number };  // unit vector; server clamps & defaults to (0,1)
};
```

### New broadcast events

```ts
export type PlayerDamagedEvent = {
  type: "player_damaged";
  playerId: string;
  damage: number;
  x: number; z: number;     // player position at hit, for floating-number placement
  serverTick: number;
};

export type PlayerDownedEvent = {
  type: "player_downed";
  playerId: string;
  serverTick: number;
};

export type RunEndedEvent = {
  type: "run_ended";
  serverTick: number;
};
```

`run_ended` is partially redundant with `RoomState.runEnded` flipping
true, but it's a discrete one-shot trigger that's convenient for client
overlay timing. Same dual-pattern as `level_up_offered` + the schema
fields it mirrors.

### `MessageType` table additions

`PlayerDamaged: "player_damaged"`, `PlayerDowned: "player_downed"`,
`RunEnded: "run_ended"`.

## Server tick changes (`shared/rules.ts` and `server/src/GameRoom.ts`)

### Universal: `state.runEnded` early-out

Every existing and new tick function begins with:

```ts
if (state.runEnded) return;
```

### `tickPlayers` — three changes

1. Skip downed players entirely (no integration of `inputDir`).
2. After integration, **clamp position to `MAP_RADIUS²`**:
   ```ts
   const r2 = p.x * p.x + p.z * p.z;
   const max2 = MAP_RADIUS * MAP_RADIUS;
   if (r2 > max2) {
     const scale = MAP_RADIUS / Math.sqrt(r2);
     p.x *= scale;
     p.z *= scale;
   }
   ```
3. Facing is written by the input message handler (not by `tickPlayers`).
   Listed here so the surface is complete.

### `tickEnemies` — two changes

1. Treat downed players as non-targets. Iterate `state.players`, skip
   `if (p.downed) return;` in the inner forEach. If no non-downed players
   remain, the function early-outs (existing `state.players.size === 0`
   guard generalizes to "no living players").
2. After movement, **despawn far-wandering enemies**: for each enemy,
   compute min squared distance to any non-downed player. If that min
   exceeds `ENEMY_DESPAWN_RADIUS²`, `state.enemies.delete(String(id))` and
   `ctx.orbitHitCooldown.evictEnemy(id)`. New `ctx` parameter.

### New: `tickContactDamage(state, contactCooldown, dt, emit)`

```ts
export interface ContactCooldownLike {
  tryHit(playerId: string, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
  evictPlayer(playerId: string): void;
  sweep(nowMs: number, maxCooldownMs: number): void;
}
```

For each non-downed player, walk `state.enemies`. Pair test:
`dx² + dz² ≤ (PLAYER_RADIUS + ENEMY_RADIUS)²`. On touching pair:
- If `contactCooldown.tryHit(playerId, enemyId, nowMs, ENEMY_CONTACT_COOLDOWN_S * 1000)` returns true:
  - `player.hp = max(0, player.hp - ENEMY_CONTACT_DAMAGE)`.
  - `emit player_damaged`.
  - If `player.hp === 0 && !player.downed`:
    - `player.downed = true`.
    - `player.inputDir.x = 0; player.inputDir.z = 0;`.
    - `emit player_downed`.

Hot-loop friendly: squared distances, no Math.hypot, no allocations.
Determinism: rng-free. `nowMs` is wall-clock for cooldown timing only,
identical pattern to orbit hits — does not affect outcomes that need to
agree across clients.

### New: `tickRunEndCheck(state, emit)`

```ts
if (state.runEnded) return;
if (state.players.size === 0) return;          // empty room is not "ended"
let allDowned = true;
state.players.forEach((p) => { if (!p.downed) allDowned = false; });
if (!allDowned) return;
state.runEnded = true;
state.runEndedTick = state.tick;
emit({ type: "run_ended", serverTick: state.tick });
```

### `tickWeapons` and `tickProjectiles` — kills bookkeeping

When an enemy crosses `hp ≤ 0`:
- In `tickProjectiles`: `state.players.get(proj.ownerId)?.kills += 1` before the existing schema removal.
- In `tickWeapons` orbit arm: `player.kills += 1` (player is in scope).

Skip the increment if the player has been removed (defensive — projectile
ownerId may belong to a player who left mid-tick).

### `tickWeapons` — skip downed players

`if (player.downed) return;` at the top of the per-player forEach body.

### `tickProjectiles` — projectiles outlive their owner

In-flight projectiles continue to integrate, hit, and credit kills to
their `ownerId` even after the owner is downed. Cancelling in-flight
projectiles on owner-down would feel wrong (the bullet is already in the
world). Kills credited to a downed owner remain on `Player.kills` for
the recap.

### `tickGems` — `xpGained` bookkeeping

When a gem is collected: `collector.xp += gem.value;` (existing) and
`collector.xpGained += gem.value;` (new — monotone). `tickXp` continues to
drain `xp` only.

### `tickXp` and `tickLevelUpDeadlines` — no logic change

Downed players continue to receive level-up offers and have them auto-
resolved at deadline. No effect (downed weapons don't fire) but avoids
special-casing the timer cancellation. Client side: `<LevelUpOverlay>`
hides when the local player is `downed`, and the 1/2/3 keystroke handler
short-circuits — keeps the UI honest while the server's auto-pick path
keeps the schema consistent.

### `tickSpawner` — spawn clamp

Spawns are placed at `target.x + cos(angle) * ENEMY_SPAWN_RADIUS` from a
random non-downed player. With `MAP_RADIUS = 60` and
`ENEMY_SPAWN_RADIUS = 30`, a player kiting at the boundary can produce
spawn positions out to ~90 units — beyond `ENEMY_DESPAWN_RADIUS = 50`,
so the enemy would despawn the next tick (a wasted spawn + a visible
flicker). When the rolled spawn falls outside `MAP_RADIUS`, retry the
angle up to **3 times**; if all retries land outside, skip this spawn
slot entirely (the accumulator already drained, so no spawn-storm
follows). Also: skip players with `downed=true` when picking a target;
the existing `playerIdx = floor(rng() * state.players.size)` is replaced
by a count of non-downed players plus a forEach skip-and-pick. RNG
schedule is preserved (one `rng()` per attempt for angle, one `rng()`
for player index — same number of calls as today on the success path).

### `GameRoom.onMessage("input")` — gating + facing

```ts
const player = this.state.players.get(client.sessionId);
if (!player) return;
if (player.downed) return;                             // drop silently; do not bump lastProcessedInput
if (this.state.runEnded) return;                       // run-end frozen state

const seq = Number(message?.seq);
if (!Number.isFinite(seq) || seq <= player.lastProcessedInput) return;

const dir = clampDirection(Number(message?.dir?.x), Number(message?.dir?.z));
const facing = clampFacing(Number(message?.facing?.x), Number(message?.facing?.z));
player.inputDir.x = dir.x;
player.inputDir.z = dir.z;
player.facingX = facing.x;
player.facingZ = facing.z;
player.lastProcessedInput = seq;
```

`clampFacing` lives in `server/src/input.ts` next to `clampDirection`,
returns a unit vector and falls back to `(0, 1)` on zero / NaN input.

### `GameRoom.onJoin` — new field initialization

```ts
player.hp = PLAYER_MAX_HP;
player.maxHp = PLAYER_MAX_HP;
player.downed = false;
player.facingX = 0;
player.facingZ = 1;
player.kills = 0;
player.xpGained = 0;
player.joinTick = this.state.tick;
player.name = (options?.name ?? "Anon").trim().slice(0, PLAYER_NAME_MAX_LEN) || "Player";
```

### `GameRoom.onLeave` — contactCooldown eviction

```ts
this.contactCooldown.evictPlayer(client.sessionId);
```

Mirrors the existing `orbitHitCooldown.evictPlayer` call.

### `GameRoom` — contactCooldown ownership and sweep

A new `ContactCooldownStore` is constructed in `onCreate` next to the
orbit store. The existing `cooldownSweepCounter` is reused: when the
counter trips, sweep both stores. `maxOrbitHitCooldownMs` extends to
`maxHitCooldownMs(WEAPON_KINDS, ENEMY_CONTACT_COOLDOWN_S * 1000)` so the
sweep window is wide enough for both.

## Client architecture

### File touchpoints

**New files (7):**

| File | Purpose |
|---|---|
| `client/src/game/CameraRig.tsx` | Lerp-follow camera, spectator-mode target switching |
| `client/src/game/Crosshair.tsx` | In-world ground-plane reticle at mouse-raycast point |
| `client/src/game/DamageNumberPool.tsx` | 30-slot pool of drei `<Text>` floaters |
| `client/src/game/BoundaryRing.tsx` | Emissive torus at `MAP_RADIUS` |
| `client/src/game/MinimapCanvas.tsx` | 200×200 DOM `<canvas>` overlay |
| `client/src/game/RunOverPanel.tsx` | DOM overlay reading `room.state.{players, runEnded, runEndedTick}` |
| `server/src/contactCooldown.ts` | Per-(player, enemy) cooldown store, mirrors `orbitHitCooldown.ts` |

**Edited files:**

`shared/{schema, messages, constants}.ts`, `shared/rules.ts`,
`shared/index.ts` (exports), `server/src/{GameRoom, input}.ts`,
`server/src/orbitHitCooldown.ts` (to factor `maxHitCooldownMs` for both
stores, if cleaner), `client/src/game/{GameView, PlayerCube, PlayerHud,
Ground, input}.tsx`, `client/src/App.tsx` (consent-leave wiring from
RunOverPanel).

### `<CameraRig>` (in `<Canvas>`)

`useFrame((state, dt) => …)`. Reads target via:

```ts
const localPlayer = room.state.players.get(room.sessionId);
const target = (localPlayer && !localPlayer.downed)
  ? localPlayerRenderPos(predictor)
  : firstNonDownedRemote(room) ?? localPlayerRenderPos(predictor);

const camTarget = { x: target.x + 0, y: target.y + 9, z: target.z + 11 };
const factor = 1 - Math.exp(-dt / 0.15);
camera.position.x += (camTarget.x - camera.position.x) * factor;
camera.position.y += (camTarget.y - camera.position.y) * factor;
camera.position.z += (camTarget.z - camera.position.z) * factor;
camera.lookAt(target.x, 0.5, target.z);
```

`firstNonDownedRemote` iterates `room.state.players` in `MapSchema`
forEach order, returns the first non-downed remote's interpolated render
pos from the existing snapshot buffer. Each client picks its own
spectator target, so iteration order does *not* need to be deterministic
across clients (CLAUDE.md rule 10's "never identify enemies by iteration
order" applies to gameplay outcome decisions; spectator target selection
is local presentation, not an outcome).

### `game/input.ts` extension

- Module-level `mouseScreenX, mouseScreenY` plus a `mousemove` listener
  registered/disposed by `attachInput`.
- New `getLiveFacing(camera, raycaster, plane)` returns a unit vector
  from local-player position toward the mouse-ray intersection with
  `Plane(y=0, normal=Y)`. Falls back to `(0, 1)` if the mouse hasn't
  moved or the ray misses (degenerate case — extremely flat camera).
- 20Hz step now sends `{ type: "input", seq, dir, facing }`. Predictor
  signature unchanged on the `dir` side; `facing` is fire-and-forget
  state with no prediction (visual only this milestone).

### `<PlayerCube>` changes

- Reads `Player.facingX/Z` (remote) or `getLiveFacing()` (local). Sets
  `mesh.rotation.y = Math.atan2(facingX, facingZ)`.
- Adds a small "nose" child mesh — a thin box `(0.2, 0.2, 0.6)` at
  `position={[0, 0, 0.7]}` — so cube rotation reads visually.
- If `player.downed`: swap material color to `#6a6a6a` and set
  `rotation.x = Math.PI / 2` (lying flat).
- Adds drei `<Billboard position={[0, 1.4, 0]}>` with:
  - `<Text>` for the name — yellow if local, white otherwise. Read from
    `Player.name` via the existing onChange listener.
  - Two thin quads (background + foreground) for the HP bar; foreground
    width scaled by `hp / maxHp`.

### `<DamageNumberPool>`

- Pre-instantiates 30 drei `<Text>` slots, all hidden.
- On every `hit` event (regardless of which player's projectile / orbit
  did the damage) → spawn a white floater at the rendered enemy position.
  Sense-of-shared-impact > clutter; capacity 30 caps the cost.
- On every `player_damaged` event → spawn a red floater at the player's
  rendered position (local: `predictor.renderX/Z`; remote: snapshot
  buffer sample at `now - interpDelayMs`).
- Each frame: `position.y += 1.0 * dt`, `material.opacity = max(0, 1 - age/0.8)`.
- Free at 800ms. On overflow, drop oldest.

### `<MinimapCanvas>` (DOM overlay, top-right)

```
canvas: 200x200
SCALE = 100 / MAP_RADIUS                  // ~1.67 px/world-unit
each frame (RAF):
  clear
  draw boundary ring (full canvas inscribed circle)
  for each enemy: 2x2 px red dot at low alpha (0.4)
  for each remote player: 3x3 px square in player hue
  draw local player as 6px yellow ▲ rotated by facing
```

Reads `room.state.{players, enemies}` directly. Worst case 300 enemies +
10 players × 60 fps = ~18.6k iterations/sec. Trivial.

### `<BoundaryRing>` (in scene)

`<mesh rotation-x={Math.PI/2}>` with `<torusGeometry args={[MAP_RADIUS, 0.05, 8, 128]}/>`
and a teal emissive material. Subtle but unmistakable as "edge."

### `<Ground>` resize

Plane `MAP_RADIUS * 2.2 = 132` units across, slightly oversize so the
boundary ring isn't at the visible edge. Color stays solid for now —
tileable texture deferred.

### `<PlayerHud>` extensions

- Bottom-center HP bar (320px wide DOM div, gradient red/orange fill,
  "72 / 100" centered label). Reads `localPlayer.{hp, maxHp}`.
- Full-screen damage-flash overlay: a `pointer-events: none` div over the
  whole viewport, `background: rgba(255,0,0,0.3)`, alpha animated to 0
  over 200ms on each `player_damaged` event for the local player.

### `<RunOverPanel>` (DOM)

- Visible iff `room.state.runEnded === true`.
- Per-player table: name, level, kills, xpGained, weapons (name + level),
  survived (`(runEndedTick - joinTick) / TICK_RATE`).
- "Leave room" button: `room.leave(true /* consented */)` then notifies
  `App.tsx` via a new `onConsentLeave` callback wired through `GameView`.
  This is distinct from `onUnexpectedLeave` (already wired) so
  consensual exits don't trigger reconnect prompts.

### Crosshair behavior in spectator mode

Hidden when `localPlayer.downed === true`. Facing updates from a downed
client are dropped server-side, so a visible crosshair would be
misleading.

## Testing strategy

### Unit (`shared/test/rules.test.ts`)

- `tickPlayers` clamps to `MAP_RADIUS`.
- `tickPlayers` skips downed players.
- `tickEnemies` ignores downed players for nearest-target selection.
- `tickEnemies` despawns enemies beyond `ENEMY_DESPAWN_RADIUS` from any
  non-downed player.
- `tickContactDamage` rate-limits per (player, enemy) pair.
- `tickContactDamage` flips `downed`, zeros `inputDir`, emits
  `player_damaged` and `player_downed` exactly once at hp ≤ 0.
- `tickRunEndCheck` flips `runEnded` only when *all* players are downed.
- `tickRunEndCheck` does not fire on an empty room.
- All tick functions early-out on `state.runEnded`.
- `Player.kills` increments only on enemy-killing projectile/orbit hits.
- `Player.xpGained` is monotone (never drained by level-up).

### Integration (`server/test/integration.test.ts`)

- Existing suite passes (no encoder regression from new fields). This is
  the schema-landmine guard documented at the top of `schema.ts` —
  Vitest unit tests don't drive the encoder.
- New: end-to-end flow — two real WS clients, contact damage applies,
  `player_damaged → player_downed → run_ended` events arrive at both
  clients, `RoomState.runEnded` patches reach both clients.

### Reconnect (`server/test/reconnect.test.ts`)

- Downed player who disconnects within the grace window comes back with
  `downed=true`, `hp=0`, `kills` and `xpGained` intact.

### Manual (two browser tabs)

- Camera lerp + crosshair + facing read correctly.
- Minimap dot-haze under heavy spawn (`Shift+]`).
- Name billboards survive distance, downed flatten, cube rotation.
- Contact damage rate-limits properly; downed teammate visible from
  across the map through camera.
- Run-over recap totals match expectations; "Leave room" exits cleanly
  back to the landing screen.
- Spectator-mode camera follows a non-downed teammate; switches when
  that teammate also goes down; freezes on local cube when all are
  downed.

## CLAUDE.md updates required

### Rule 11 — tick order

Insert `tickContactDamage` and `tickRunEndCheck` between `tickEnemies`
and `tickWeapons`. Update the rationale comment to note the `runEnded`
universal early-out invariant.

### Rule 12 — combat events

Add `player_damaged`, `player_downed`, `run_ended` to the broadcast-event
list.

No new architectural rules introduced; the design fits inside the
existing framework.

## Open follow-ups (deferred to future milestones)

- Aim-directional weapons reading `Player.facingX/Z`.
- Revive mechanic (proximity-based; downed body in world is the launching
  pad).
- Gamepad input (right stick → facing; trivial extension).
- Ground texture asset (Poly Haven CC0 or similar).
- Audio (footsteps, weapon fire, hit, level-up, run-end stinger).
- Per-room map sizing / class differences.
- Persistent recap / leaderboards.
- Per-tab visual jitter under sustained spawn — re-evaluate after the
  larger map and despawn rule reduce active enemy count.
