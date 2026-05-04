# M3 — Dumb enemies and the first taste of gameplay

**Status:** Design — approved 2026-05-04. Ready for implementation plan.

## Goal

Spawn enemies on the server that walk toward the nearest player, sync them
to all clients, and render them efficiently enough to prove the entity
sync architecture scales. No combat, no damage, no weapons.

This milestone exists to validate the architecture under entity counts
two orders of magnitude larger than the player count, and to surface any
sync/perf issues now — with one entity kind and no other variables — so
they're cheap to fix before combat / pickups / weapons land on top.

## Non-goals

- No combat, damage, health bars, or death animations. `Enemy.hp` exists
  in the schema as preparation only; nothing reads it this milestone.
- No weapons, projectiles, XP gems, or pickups.
- No enemy variety beyond `kind = 0`. The `kind` field exists for future
  use; we ship one shape.
- No pathfinding, obstacle avoidance, flocking, or separation. Straight
  lines toward nearest player. Overlap is allowed.
- No spawn waves or difficulty scaling. Constant interval.
- No physics engine. Squared-distance comparisons only.
- No per-enemy Three.js Mesh objects. InstancedMesh from the very first
  enemy. Non-negotiable.
- No optimization beyond instanced rendering. If perf is bad we diagnose
  before optimizing.
- No animated character work. Cones, not characters.
- No client-side tests for the new React/Three.js code. The slot allocator
  could be extracted and tested later if it becomes a hot-bug area;
  flagged as future-work, not done preemptively.

## Architectural decisions

These were resolved during brainstorming. Each is load-bearing for the
implementation plan.

### AD1. Spawner state lives on the GameRoom, not on RoomState

`spawnAccumulator` (seconds since last spawn) and `nextEnemyId` (monotonic
counter for `Enemy.id`) are server-only state. They do not benefit any
client. Putting them on RoomState would burn snapshot bytes every tick
for no client value and would muddy the perf measurement we run at the
end of this milestone.

Per CLAUDE.md rule 2 ("All synced state is in `shared/schema.ts`"), the
contrapositive applies: server-only state stays off the schema. The room
owns a `SpawnerState` instance and passes it to `tickSpawner` explicitly.

```ts
export type SpawnerState = {
  accumulator: number;   // seconds since last spawn
  nextEnemyId: number;   // monotonic; assigned to Enemy.id; starts at 1
};
```

`nextEnemyId` starts at 1 so id=0 (the schema default) is never a valid
enemy id. Map keys are `String(id)`.

### AD2. Empty-room spawner does nothing and does not advance

If `state.players.size === 0`, `tickSpawner` returns early without
advancing the accumulator. This avoids a "join into a swarm" experience
when a player joins a long-empty room (Colyseus disposes empty rooms
after a grace period in practice, but the moment-of-empty must be handled
cleanly regardless).

### AD3. Snapshot byte measurement = full-state every 5s + per-tick delta via internal hook

Both signals are valuable:

- **Full-state encoded size** is what every new joiner pays once. Easy
  to measure via `state.encodeAll()`-equivalent. Stable across Colyseus
  versions.
- **Per-tick delta size** is what every connected client pays every tick.
  More useful for "does this scale?" but requires hooking Colyseus's
  internal patch broadcast — we override `broadcastPatch()` on the
  GameRoom subclass and sum buffer bytes.

The per-tick instrumentation is wrapped in try/catch with a one-shot
warning. A future Colyseus upgrade that breaks the hook fails loudly
(log line: "patch instrumentation broken — manual measurement needed"),
not silently.

Output (every 5 s):
```
[room ABCD] snapshot avg=412B/tick full=5,832B enemies=87 players=2
```

### AD4. InstancedMesh slot allocation = swap-and-pop

The single InstancedMesh has fixed capacity `MAX_ENEMIES`. Per-frame we
set `mesh.count = activeEnemyCount` to render only live slots. Slot
mapping uses a `Map<enemyId, slot>` and a parallel `idAtSlot: number[]`.

- Add: assign next slot at `activeCount`, increment `activeCount`.
- Remove: swap the last active slot's entry into the freed slot, update
  both maps, decrement `activeCount`.

Active range stays packed `[0, activeCount)`. Standard InstancedMesh
pattern; one matrix copy per remove. No holes, no per-frame skip logic.

### AD5. Constants live in `shared/constants.ts`

New file. All gameplay tuning knobs go there. `PLAYER_SPEED` and
`SIM_DT_S` move from `shared/rules.ts` (the M2 cross-reference comment
on `SIM_DT_S` moves with it). `SIM_DT_S` is derived from `TICK_RATE`
rather than hand-coded:

```ts
export const TICK_RATE = 20;
export const SIM_DT_S = 1 / TICK_RATE;
```

Client `STEP_INTERVAL_MS = 50` in `packages/client/src/game/input.ts`
stays as-is for this milestone; converting it to use shared constants
is unrelated cleanup.

### AD6. `debug_spawn` is capped per-call at MAX_ENEMIES, with full input validation

`count` is validated as a finite positive integer; `kind` is validated
as a non-negative integer (default 0 if missing or invalid). Per-call
count is clamped to `MAX_ENEMIES`. Same defensive shape as
`clampDirection` in `packages/server/src/input.ts`.

### AD7. Client interpolation = per-enemy SnapshotBuffer (mirrors players)

Same pattern as the existing per-player buffers. `Map<enemyId,
SnapshotBuffer>`. ~120 bytes per buffer × 300 max ≈ 36 KB total —
trivial. Per-frame cost is 300 small array walks. If this turns out to
matter we can move to a unified tick-keyed buffer later.

The unified-buffer alternative was considered and rejected: enemies add
and remove at independent times, so unifying their snapshot timing into
a single tick-keyed buffer requires a synthetic "server heartbeat" event
that doesn't exist. Per-enemy buffers handle add/remove naturally.

## Architecture

```
shared/
  constants.ts   (NEW)   tuning knobs; TICK_RATE, SIM_DT_S, ENEMY_*, MAX_ENEMIES, PLAYER_SPEED
  schema.ts              Enemy class filled in (was empty placeholder); RoomState unchanged
  rules.ts               + tickEnemies, + tickSpawner, + spawnDebugBurst, + SpawnerState type
  messages.ts            + DebugSpawnMessage, + DebugClearEnemiesMessage in ClientMessage union
  rng.ts                 unchanged
  index.ts               re-export new symbols

server/
  GameRoom.ts            tick loop: tickPlayers → tickEnemies → tickSpawner
                         + room-owned `rng` (mulberry32(state.seed)) and `spawner: SpawnerState`
                         + debug message handlers (gated by ALLOW_DEBUG_MESSAGES = true)
                         + snapshot byte logging (5s timer + broadcastPatch override)
                         + onDispose clears the timer
  index.ts, input.ts     unchanged
  joinCode.ts            unchanged

client/
  game/
    EnemySwarm.tsx (NEW) single InstancedMesh for all enemies; swap-and-pop slot allocator
    GameView.tsx         + enemies onAdd/onRemove plumbing (mirror of players block)
                         + EnemySwarm mount
                         + extended keydown handler for `]`, `}`, `\`
    DebugHud.tsx         + 3 lines: enemies, draw calls, snap bytes
    PlayerCube.tsx       unchanged
    Ground.tsx           unchanged
    input.ts             unchanged (STEP_INTERVAL_MS magic number left for separate cleanup)
  net/
    hudState.ts          + enemyCount, enemyDrawCalls, lastSnapshotBytes
    snapshots.ts         unchanged (reused for enemies)
    client.ts            unchanged
    prediction.ts        unchanged
```

## Data flow

1. Server tick (every 50 ms):
   1. `state.tick++`
   2. `tickPlayers(state, SIM_DT_S)` — applies inputDir to each player (existing M2)
   3. `tickEnemies(state, SIM_DT_S)` — each enemy steps toward nearest player
   4. `tickSpawner(state, this.spawner, SIM_DT_S, this.rng)` — maybe spawn one enemy
2. Colyseus encodes patch, broadcasts to all clients, our overridden
   `broadcastPatch` adds `byteLength` to the snapshot byte counter.
3. Client receives patch. `state.enemies.onAdd` fires for new enemies →
   `EnemySwarm`'s slot table picks up the new id on the next render
   tick. `state.enemies.onChange` fires for moved enemies → push to that
   enemy's `SnapshotBuffer`. `state.enemies.onRemove` for cleared
   enemies → slot table swap-and-pop.
4. `EnemySwarm.useFrame` (60 fps): for each active slot `i in [0, count)`,
   sample the buffer for `idAtSlot[i]` at `now - interpDelayMs`,
   `mesh.setMatrixAt(i, translation)`, `mesh.count = activeCount`,
   `mesh.instanceMatrix.needsUpdate = true`.

## Schema

```ts
export class Enemy extends Schema {
  declare id: number;
  declare kind: number;
  declare x: number;
  declare z: number;
  declare hp: number;
  constructor() {
    super();
    this.id = 0;
    this.kind = 0;
    this.x = 0;
    this.z = 0;
    this.hp = 0;
  }
}
defineTypes(Enemy, {
  id: "uint32",
  kind: "uint8",
  x: "number",
  z: "number",
  hp: "uint16",
});
```

`declare` fields plus constructor-body assignment, per the schema.ts
landmines comment (esbuild emits `Object.defineProperty` for class field
initializers, which shadows the prototype setters that `defineTypes`
installs — silently breaks the encoder). Same discipline as Player and
Vec2.

`RoomState.enemies: MapSchema<Enemy>` already exists from M2 with the
empty Enemy placeholder. No structural change to RoomState.

## Constants

```ts
// packages/shared/src/constants.ts
export const TICK_RATE = 20;                    // Hz
export const SIM_DT_S = 1 / TICK_RATE;          // 0.05 s
export const PLAYER_SPEED = 5;                  // world units/sec
export const ENEMY_SPEED = 2.0;                 // world units/sec
export const ENEMY_SPAWN_INTERVAL_S = 1.0;      // seconds between spawns
export const ENEMY_SPAWN_RADIUS = 30;           // world units from a player
export const MAX_ENEMIES = 300;                 // hard cap
```

## Rules

```ts
// packages/shared/src/rules.ts

export type SpawnerState = {
  accumulator: number;
  nextEnemyId: number;
};

export function tickEnemies(state: RoomState, dt: number): void;

export function tickSpawner(
  state: RoomState,
  spawner: SpawnerState,
  dt: number,
  rng: Rng,
): void;

export function spawnDebugBurst(
  state: RoomState,
  spawner: SpawnerState,
  rng: Rng,
  centerPlayer: Player,
  count: number,
  kind: number,
): void;
```

`tickEnemies`: if `state.players.size === 0`, return immediately (enemies
freeze; positions unchanged). Otherwise for each enemy, find the nearest
player by squared distance (no `Math.hypot` per pair), then move by
`ENEMY_SPEED * dt` in the normalized direction toward that player (one
`Math.sqrt` per enemy). No allocation per enemy per tick beyond
function-scope locals.

Edge case: enemy already coincident with its target player (distance 0).
Skip the normalize-and-move; do not produce NaN.

`tickSpawner`: per AD2, return early if `state.players.size === 0`.
Otherwise advance `spawner.accumulator += dt`. Then while
`accumulator >= ENEMY_SPAWN_INTERVAL_S` and `state.enemies.size <
MAX_ENEMIES`:

- **Pick a random player** uniformly: `Math.floor(rng() * state.players.size)`
  used as an index into iteration order. Colyseus `MapSchema` iterates in
  insertion order; that's stable enough within a single function call,
  which is all we need (cross-tick stability is not required because the
  RNG drives the index choice, not the iteration).
- **Pick a random angle** in `[0, 2π)`: `rng() * Math.PI * 2`.
- Place a new `Enemy` at `(player.x + cos(θ) * R, player.z + sin(θ) * R)`
  where `R = ENEMY_SPAWN_RADIUS`.
- Assign `id = spawner.nextEnemyId++`, `kind = 0`, `hp = 1`. The
  constructor default for `hp` is 0; the spawner explicitly sets it to
  1 so that future combat code reading `hp > 0` works without changing
  the constructor.
- Set into `state.enemies` keyed by `String(id)`, subtract
  `ENEMY_SPAWN_INTERVAL_S` from accumulator, loop.

When `state.enemies.size >= MAX_ENEMIES`, the accumulator drains to 0
on the same tick (instead of stalling). Reasoning: if it stalled, the
moment one enemy was removed (next milestone, when combat lands) we'd
flood. Drain is the right default.

`spawnDebugBurst`: places `min(count, MAX_ENEMIES - state.enemies.size)`
enemies at random angles around `centerPlayer` at `ENEMY_SPAWN_RADIUS`.
Uses the same `spawner.nextEnemyId++` and the same `rng` as the
auto-spawner — a debug burst doesn't desync future deterministic spawns.

### Determinism

The room creates `this.rng = mulberry32(state.seed)` in `onCreate`, after
`state.seed` is set. The RNG is room-scoped and persistent across ticks.
Only `tickSpawner` and `spawnDebugBurst` consume it.

`Math.random()` is used exactly once in the room — to generate the seed
itself in `onCreate`. The seed is the input to determinism, not a
determinism-affected output. CLAUDE.md rule 6 holds.

## Server

### GameRoom changes

```ts
const ALLOW_DEBUG_MESSAGES = true;     // becomes runtime config later
const SNAPSHOT_LOG_INTERVAL_MS = 5_000;

export class GameRoom extends Room<RoomState> {
  private rng!: Rng;
  private spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };
  private snapshotLogTimer: NodeJS.Timeout | null = null;
  private patchByteCount = 0;
  private patchSampleCount = 0;
  private patchInstrumentationFailed = false;

  override async onCreate(_options: JoinOptions): Promise<void> {
    // ... existing onCreate ...
    this.rng = mulberry32(state.seed);

    // ... existing input + ping handlers ...

    if (ALLOW_DEBUG_MESSAGES) {
      this.onMessage<DebugSpawnMessage>("debug_spawn", (client, message) => {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;

        const requested = Number(message?.count);
        if (!Number.isFinite(requested) || requested <= 0) return;
        const cap = Math.min(Math.floor(requested), MAX_ENEMIES);

        const kindRaw = Number(message?.kind);
        const kind = Number.isFinite(kindRaw) && kindRaw >= 0
          ? Math.floor(kindRaw) : 0;

        spawnDebugBurst(this.state, this.spawner, this.rng, player, cap, kind);
      });

      this.onMessage<DebugClearEnemiesMessage>("debug_clear_enemies", () => {
        this.state.enemies.clear();
      });
    }

    this.installSnapshotLogger();
    this.setSimulationInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  override onDispose(): void {
    if (this.snapshotLogTimer) clearInterval(this.snapshotLogTimer);
  }

  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S);
    tickEnemies(this.state, SIM_DT_S);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
  }

  private installSnapshotLogger(): void {
    // Wrap broadcastPatch to count per-tick patch bytes. If the internal
    // API has changed (Colyseus upgrade), log a one-shot warning and
    // continue — we still get full-state numbers from the timer.
    try {
      const original = (this as any).broadcastPatch?.bind(this);
      if (typeof original !== "function") throw new Error("no broadcastPatch");
      (this as any).broadcastPatch = () => {
        const result = original();
        // Inspect whatever Colyseus returns; sum bytes if available.
        // Exact hook details TBD during implementation against the
        // installed Colyseus version.
        // (See AD3 — wrapped in try/catch externally.)
        return result;
      };
    } catch (err) {
      this.patchInstrumentationFailed = true;
      console.warn(`[room ${this.state.code}] patch instrumentation unavailable: ${err}`);
    }

    this.snapshotLogTimer = setInterval(() => {
      const enemies = this.state.enemies.size;
      const players = this.state.players.size;
      const avgPatch = this.patchSampleCount > 0
        ? Math.round(this.patchByteCount / this.patchSampleCount)
        : 0;

      let fullBytes = -1;
      try {
        const buf = (this.state as any).encodeAll?.();
        if (buf?.length != null) fullBytes = buf.length;
      } catch (err) {
        // One-shot warn on full-state encode failure too.
      }

      const patchStr = this.patchInstrumentationFailed ? "n/a" : `${avgPatch}B/tick`;
      const fullStr = fullBytes >= 0 ? `${fullBytes}B` : "n/a";
      console.log(
        `[room ${this.state.code}] snapshot avg=${patchStr} full=${fullStr} enemies=${enemies} players=${players}`,
      );

      this.patchByteCount = 0;
      this.patchSampleCount = 0;
    }, SNAPSHOT_LOG_INTERVAL_MS);
  }
}
```

**Implementation-time decision (bounded, not unresolved):** the exact
Colyseus internal hook for per-tick byte counting depends on the
installed Colyseus version. The contract is fully specified above
(count bytes per emitted patch, log avg every 5 s, fail loud on
breakage). The wiring — likely overriding `broadcastPatch()` and
inspecting the encoded buffer — gets pinned down against the actual
Colyseus version during implementation, with the try/catch fallback
in AD3 ensuring graceful degradation. If the hook is genuinely
unworkable, fall back to full-state-only logging and note it.

## Client

### GameView.tsx — enemy state plumbing

Mirror the existing players block. New refs/state:

```ts
const enemyBuffers = useMemo(() => new Map<number, SnapshotBuffer>(), []);
const [enemyIds, setEnemyIds] = useState<Set<number>>(new Set());
```

In the `useEffect`, alongside the players plumbing:

```ts
const perEnemyDisposers = new Map<number, () => void>();

const onEnemyAdd = (enemy: Enemy, key: string) => {
  const id = Number(key);
  let buf = enemyBuffers.get(id);
  if (!buf) { buf = new SnapshotBuffer(); enemyBuffers.set(id, buf); }
  buf.push({ t: performance.now(), x: enemy.x, z: enemy.z });

  const offChange = $(enemy).onChange(() => {
    buf!.push({ t: performance.now(), x: enemy.x, z: enemy.z });
  });
  perEnemyDisposers.set(id, offChange);

  setEnemyIds((prev) => { const next = new Set(prev); next.add(id); return next; });
  hudState.enemyCount = enemyBuffers.size;
};

const onEnemyRemove = (_enemy: Enemy, key: string) => {
  const id = Number(key);
  perEnemyDisposers.get(id)?.();
  perEnemyDisposers.delete(id);
  enemyBuffers.delete(id);
  setEnemyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  hudState.enemyCount = enemyBuffers.size;
};

const offEnemyAdd = $(room.state).enemies.onAdd(onEnemyAdd);
const offEnemyRemove = $(room.state).enemies.onRemove(onEnemyRemove);
room.state.enemies.forEach((e, key) => onEnemyAdd(e, key));
```

Cleanup in the effect's return: dispose all `perEnemyDisposers`,
`offEnemyAdd()`, `offEnemyRemove()`.

Mount `<EnemySwarm enemyIds={enemyIds} buffers={enemyBuffers} />` once
inside the `<Canvas>`.

### EnemySwarm.tsx — single instanced renderer

```tsx
type EnemySwarmProps = {
  enemyIds: Set<number>;
  buffers: Map<number, SnapshotBuffer>;
};

const ENEMY_RENDER_Y = 0.6;

export function EnemySwarm({ enemyIds, buffers }: EnemySwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const slotForId = useRef(new Map<number, number>());
  const idAtSlot = useRef<number[]>([]);
  const activeCountRef = useRef(0);
  const matrix = useMemo(() => new Matrix4(), []);
  const { gl } = useThree();

  useEffect(() => {
    // Add new ids.
    enemyIds.forEach((id) => {
      if (slotForId.current.has(id)) return;
      const slot = activeCountRef.current++;
      slotForId.current.set(id, slot);
      idAtSlot.current[slot] = id;
    });
    // Remove dropped ids — swap-and-pop.
    for (const [id, slot] of slotForId.current) {
      if (enemyIds.has(id)) continue;
      const lastSlot = --activeCountRef.current;
      const lastId = idAtSlot.current[lastSlot]!;
      if (slot !== lastSlot) {
        idAtSlot.current[slot] = lastId;
        slotForId.current.set(lastId, slot);
      }
      slotForId.current.delete(id);
      idAtSlot.current.length = activeCountRef.current;
    }
  }, [enemyIds]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const renderTime = performance.now() - hudState.interpDelayMs;
    const count = activeCountRef.current;
    for (let i = 0; i < count; i++) {
      const id = idAtSlot.current[i]!;
      const buf = buffers.get(id);
      if (!buf) continue;
      const sample = buf.sample(renderTime);
      if (!sample) continue;
      matrix.makeTranslation(sample.x, ENEMY_RENDER_Y, sample.z);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    hudState.enemyDrawCalls = gl.info.render.calls;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_ENEMIES]} castShadow>
      <coneGeometry args={[0.5, 1.2, 6]} />
      <meshStandardMaterial color="#c44" />
    </instancedMesh>
  );
}
```

- 6-sided cone, height 1.2, radius 0.5, color `#c44`. Distinct from
  player cubes (which use 70%-saturation HSL colors).
- `ENEMY_RENDER_Y` is a render-only value, not a gameplay constant.
  Lives in the component file, not in `shared/constants.ts`.
- Slot table sync runs in `useEffect` keyed on `enemyIds` Set identity
  (which always changes when membership changes — `setEnemyIds` always
  creates a new Set). One-frame delay between Colyseus event and rendered
  position; acceptable.
- `gl.info.render.calls` is read after `useFrame` runs (which is *before*
  the actual render in R3F) — so the value is "last frame's draw calls."
  Fine for a HUD diagnostic; converges to a stable number quickly.
  Expected total: ~5–8 (1 instanced enemies + N players + 1 ground +
  R3F internals). The relevant property is "doesn't grow with enemy
  count."

### Debug HUD additions

`hudState.ts`:
```ts
enemyCount: number;          // active enemies
enemyDrawCalls: number;      // gl.info.render.calls (proxy for "instancing working")
lastSnapshotBytes: number;   // best-effort client-side; authoritative number is in server log
```

`DebugHud.tsx` adds three lines to the HUD output. The client-side
`lastSnapshotBytes` is best-effort — Colyseus's client decoder doesn't
cleanly expose received-patch byte size. If the client number turns out
to be unreliable in practice, drop the HUD line and rely on the
server-side log. Flagged as an implementation-time call.

### Debug keybinds

Extend the existing keydown handler in `GameView.tsx`. Active only when
`hudState.visible === true`. `e.preventDefault()` for all matched keys
(parity with the F3 fix in commit `bd46b50`).

| Key      | `e.code`         | `e.shiftKey` | Action                                         |
|----------|------------------|--------------|------------------------------------------------|
| `]`      | `BracketRight`   | false        | `room.send("debug_spawn", { count: 10 })`      |
| `}`      | `BracketRight`   | true         | `room.send("debug_spawn", { count: 100 })`     |
| `\`      | `Backslash`      | (any)        | `room.send("debug_clear_enemies", {})`         |

## Messages

```ts
export type DebugSpawnMessage = {
  type: "debug_spawn";
  count: number;
  kind?: number;
};

export type DebugClearEnemiesMessage = {
  type: "debug_clear_enemies";
};

export type ClientMessage =
  | InputMessage
  | PingMessage
  | DebugSpawnMessage
  | DebugClearEnemiesMessage;
```

`MessageType` constant gains `DebugSpawn` and `DebugClearEnemies` entries.

## Tests

### `packages/shared/test/rules.test.ts` — extend

Existing `tickPlayers` block stays. Add three new `describe` blocks:

**`tickEnemies`** (5 tests)
1. Single player + single enemy → enemy moves toward player by `ENEMY_SPEED * dt`.
2. Multiple players → enemy moves toward the *nearest* one.
3. Two players + three enemies (mixed positions) → each enemy moves toward its own nearest player; assert each new position exactly.
4. Zero players → no movement.
5. Enemy coincident with target player → no NaN; position unchanged.

**`tickSpawner`** (6 tests)
1. dt < interval → no spawn, accumulator advances.
2. dt = interval (with player present) → exactly one spawn; accumulator ≈ 0; enemy at radius `ENEMY_SPAWN_RADIUS` from a player.
3. Five reproducible spawns from `mulberry32(42)` → assert exact (x, z) for each. **The determinism load-bearing test.**
4. dt = 2.5 × interval → 2 spawns; accumulator at 0.5 × interval. Catch-up loop works.
5. Pre-fill to MAX_ENEMIES → no new spawn even with full interval; accumulator drains to 0 (per AD2 reasoning).
6. Empty room (Q2 / AD2): zero players + large dt → accumulator does NOT advance, no spawn. Then add a player and tick one interval → exactly one spawn.

**`spawnDebugBurst`** (3 tests)
1. N=10 → 10 enemies, all within `ENEMY_SPAWN_RADIUS` of the given player.
2. N=50 with 295 pre-existing → exactly 5 spawned (capacity-clamped).
3. Mixed sequence (auto-spawn, burst of 3, auto-spawn) → ids are 1,2,3,4,5 with no gaps.

### `packages/shared/test/schema.test.ts` — extend

Add an Enemy round-trip: construct, set fields, encode via the parent
RoomState, decode in a peer schema, assert all five fields round-trip.
Catches the esbuild field-initializer landmine specifically for Enemy.

### `packages/server/test/integration.test.ts` — extend

Add one test:

```ts
describe("integration: enemy spawn + movement over real ticks", () => {
  it("spawns ~5 enemies in 5 seconds and they move toward the connected player", async () => {
    // Single client; wait ~5.5 s wall-time; assert 4–6 enemies in state.
    // Snapshot positions, wait 200 ms (4 ticks), assert at least one enemy moved.
  }, 10_000);
});
```

The 4–6 tolerance accounts for `setSimulationInterval` timing slop.
Wider tolerance than the 5±1 in the original spec for the same reason
the existing integration tests use loose `waitFor` timing.

### Deliberate omission: client-side React tests

The new client code (EnemySwarm, slot allocator, debug keybinds) is
React + Three.js + DOM-event surface. Testing it requires jsdom + R3F
testing infrastructure we don't have. We rely on the manual
verification steps below. If the slot allocator becomes a hot-bug area,
extract it into a non-React `SlotTable` class and unit-test that.
Flagged as future-work, not done preemptively.

### Order of execution

Per the project's workflow-preferences memory and CLAUDE.md:

1. Constants + schema additions + rules functions. Run shared tests; do not touch server until green.
2. Wire server tick + debug handlers + snapshot logging. Add the integration test. Run server tests; verify with one browser tab.
3. Add `EnemySwarm.tsx`, plumb `GameView.tsx`, add HUD lines and keybinds. Verify with two browser tabs.
4. Run the perf check.

## Verification

### Manual checks (after dev loop is wired and both clients render enemies)

1. **Auto-spawn visible.** Two tabs join. Within ~5 s, enemies spawn and walk toward players. Movement is smooth.
2. **Cross-client determinism.** Pick a distinctive enemy. Same world position in both tabs. (If different: grep for `Math.random` reachable from the EnemySwarm path.)
3. **Burst (`}`).** 100 enemies appear simultaneously on both tabs within one frame. fps holds at 60.
4. **Clear (`\`).** Enemies vanish in the same frame on both tabs. No flicker, no ghost meshes. HUD `enemies` → 0.
5. **Network throttle.** DevTools → Fast 3G on one tab. 100 enemies. Throttled tab lags but shows no jitter or snap. Local player remains responsive.
6. **Reconnect mid-spawn.** 100 enemies spawned. Drop tab A to "Offline" for ~5 s (within 30 s grace). Restore. Tab A reconnects, sees current state, no duplicates, no missing enemies, no console error. Enemy ids match across tabs.
7. **`pnpm typecheck` and `pnpm test` pass.**

### Performance check (only after manual verification passes)

Two clients connected. Note baseline HUD numbers (fps, ping, snap bytes)
and server log baseline.

**Phase 1 — 200 enemies.** Press `}` twice. Wait 5 s for steady state. Record:
- Client fps in both tabs (should be 60).
- Server tick rate (should hold 20Hz; check via `serverTick` HUD line).
- Server log: per-tick patch bytes, full-state bytes.
- HUD `draw calls` value — should be small and **unchanged** from baseline.

**Phase 2 — 300 enemies.** One more `}`. We hit MAX_ENEMIES. Note any
degradation:
- fps drop?
- Server tick fall-behind?
- Snapshot size linear in enemy count (expected) or super-linear (concerning)?

**Stop conditions** (from the milestone prompt):
- If per-tick snapshot bytes > **50 KB** at 200 or 300 enemies, **stop**. Don't preemptively reach for compression / delta tricks / area-of-interest filtering. Open a discussion. (Back-of-envelope: 300 enemies × ~16 wire-bytes ≈ 5 KB worst-case full-state; per-tick deltas usually much smaller. Crossing 50 KB would be surprising.)
- If client fps drops at 200 enemies, **stop**. Diagnose first: slot allocator? SnapshotBuffer iteration? InstancedMesh matrix update?

### Record numbers in README

Append to `README.md`:

```
## Manual perf test (M3)

Run on <date>, <hardware>, 2 connected Chrome clients.

| Enemies | Client FPS | Server tick | Patch bytes/tick | Full-state bytes |
|--------:|-----------:|------------:|-----------------:|-----------------:|
| 0       | 60         | 20Hz        | <baseline>       | <baseline>       |
| 200     | <num>      | <num>       | <num>            | <num>            |
| 300     | <num>      | <num>       | <num>            | <num>            |

Notes: <observations>
```

Numbers go in honestly, even if disappointing.

## CLAUDE.md update

Append a new rule under "Architectural rules":

> 10. **Enemies are simulated server-only and rendered client-side via InstancedMesh.** Never one Three.js Mesh per enemy. The single InstancedMesh has capacity `MAX_ENEMIES`; per-instance position comes from interpolating a per-enemy `SnapshotBuffer`, identified by the server-assigned `Enemy.id` (never by `MapSchema` iteration order). Spawner state (`accumulator`, `nextEnemyId`) lives on the GameRoom instance, not on RoomState — server-only counters do not pollute the schema.

This captures the load-bearing decisions for future entity types (XP gems, projectiles when client-simulated state needs server-driven IDs, etc.).

## Future work (deliberately deferred)

- **Combat / damage / death.** Enemies have `hp` but nothing reads it. Next milestone.
- **Per-enemy rotation.** Cones currently always point straight up. Movement direction is implicit. Adding per-instance rotation is a simple extension when enemies become characters.
- **Animated character meshes.** Deferred until after combat lands.
- **Snapshot delta optimization (compression, area-of-interest filtering).** Don't add until perf check shows we need it.
- **`STEP_INTERVAL_MS` cleanup in `client/src/game/input.ts`.** Trivial: replace the magic 50 with `SIM_DT_S * 1000` from the new constants. Unrelated to M3 — separate change.
- **Extracted `SlotTable` class with unit tests.** If the slot allocator becomes a hot-bug area.
- **`ALLOW_DEBUG_MESSAGES` as runtime config.** Currently a module-level constant; later becomes env-driven.
