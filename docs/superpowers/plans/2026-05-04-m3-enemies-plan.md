# M3 — Enemies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-spawned enemies that walk toward the nearest player, synced to clients and rendered as a single InstancedMesh, proving the entity sync architecture scales to ~300 entities under the existing M2 sync model.

**Architecture:** Pure-function rules in `shared/rules.ts` (`tickEnemies`, `tickSpawner`, `spawnDebugBurst`); spawner state lives off-schema on the GameRoom; one InstancedMesh on the client with a swap-and-pop slot allocator; per-enemy `SnapshotBuffer` mirroring the existing player interpolation pattern.

**Tech Stack:** TypeScript strict, pnpm workspaces, Colyseus 0.16, `@colyseus/schema` v3, Vite + React + React Three Fiber, Three.js 0.164, Vitest 1.6.

**Spec:** `docs/superpowers/specs/2026-05-04-m3-enemies-design.md` — read it before starting; it contains the architectural decisions (AD1–AD7) that this plan implements.

**Discipline reminders (CLAUDE.md):**
- Schema fields use `declare` + constructor-body assignment (NEVER class field initializers — esbuild emits `Object.defineProperty` which shadows the prototype setters that `defineTypes` installs).
- Gameplay code never calls `Math.random` — only the seeded `mulberry32(seed)` instance owned by the GameRoom.
- Game logic stays in `shared/rules.ts`; room handlers route messages and call rules.
- Schemas are data, not behavior. No methods, no getters with logic.

**Test commands:**
- `pnpm --filter @mp/shared test` — runs Vitest in shared
- `pnpm --filter @mp/server test` — runs Vitest in server (integration tests boot a real Colyseus server in-process)
- `pnpm typecheck` — `tsc -b` over the whole solution
- `pnpm test` — all tests across the monorepo

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/constants.ts` | NEW | Single home for tuning knobs (`TICK_RATE`, `SIM_DT_S`, `PLAYER_SPEED`, `ENEMY_SPEED`, `ENEMY_SPAWN_INTERVAL_S`, `ENEMY_SPAWN_RADIUS`, `MAX_ENEMIES`) |
| `packages/shared/src/rules.ts` | MODIFY | Move `PLAYER_SPEED` + `SIM_DT_S` out (re-export). Add `SpawnerState` type, `tickEnemies`, `tickSpawner`, `spawnDebugBurst` |
| `packages/shared/src/schema.ts` | MODIFY | Fill in the empty `Enemy` placeholder with `id`, `kind`, `x`, `z`, `hp` fields |
| `packages/shared/src/messages.ts` | MODIFY | Add `DebugSpawnMessage`, `DebugClearEnemiesMessage`, extend `ClientMessage` union, extend `MessageType` const |
| `packages/shared/src/index.ts` | MODIFY | Re-export new constants module |
| `packages/shared/test/rules.test.ts` | MODIFY | Add tests for `tickEnemies`, `tickSpawner`, `spawnDebugBurst` |
| `packages/shared/test/schema.test.ts` | MODIFY | Add Enemy round-trip test |
| `packages/server/src/GameRoom.ts` | MODIFY | Wire `tickEnemies` + `tickSpawner` into tick(); instantiate room-owned `rng` and `spawner: SpawnerState`; add debug handlers; add snapshot byte logger; add `onDispose` cleanup |
| `packages/server/test/integration.test.ts` | MODIFY | Add 5-second spawn integration test |
| `packages/client/src/game/EnemySwarm.tsx` | NEW | Single `<instancedMesh>` for all enemies; swap-and-pop slot allocator; per-frame matrix update from per-enemy SnapshotBuffer |
| `packages/client/src/game/GameView.tsx` | MODIFY | Add `enemies.onAdd / onRemove / onChange` plumbing mirror of players block; mount `<EnemySwarm>`; extend keydown handler for `]`, `}`, `\` |
| `packages/client/src/game/DebugHud.tsx` | MODIFY | Add 3 lines: `enemies`, `draw calls`, `snap bytes` |
| `packages/client/src/net/hudState.ts` | MODIFY | Add `enemyCount`, `enemyDrawCalls`, `lastSnapshotBytes` fields |
| `CLAUDE.md` | MODIFY | Append rule 10 (enemies + InstancedMesh + spawner-off-schema) |
| `README.md` | MODIFY | Append "Manual perf test (M3)" section with measured numbers |

**Phasing:** Phase 1 (Tasks 1–6) is shared-only — produces no runtime behavior change but must keep all existing tests green. Phase 2 (Tasks 7–9) wires the server, gated by an integration test. Phase 3 (Tasks 10–13) lights up the client. Phase 4 (Tasks 14–15) updates docs and runs the perf test. **Do not start Phase 2 until Phase 1's tests are green.**

---

## Phase 1 — Shared package

### Task 1: Create `shared/constants.ts`; relocate `PLAYER_SPEED` and `SIM_DT_S`

**Files:**
- Create: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/rules.ts:1-10`
- Modify: `packages/shared/src/index.ts`

This is a pure refactor: existing tests must stay green. We add new constants and centralize the existing two without changing any behavior.

- [ ] **Step 1: Create `packages/shared/src/constants.ts`**

```ts
// Single home for gameplay tuning knobs. Imported by rules.ts, server,
// and (selectively) client. Values that derive from others are computed
// here, not hand-coded in two places.

export const TICK_RATE = 20;                    // Hz
export const SIM_DT_S = 1 / TICK_RATE;          // 0.05 s
// Fixed simulation step. The server runs setSimulationInterval at this dt,
// and the client's LocalPredictor advances the local player at this dt
// per input. They MUST agree exactly so reapplying unacknowledged inputs
// after a snapshot reproduces the server's authoritative position — see
// AD1 in docs/superpowers/specs/2026-05-04-sync-polish-design.md.

export const PLAYER_SPEED = 5;                  // world units/sec

export const ENEMY_SPEED = 2.0;                 // world units/sec
export const ENEMY_SPAWN_INTERVAL_S = 1.0;      // seconds between spawner ticks
export const ENEMY_SPAWN_RADIUS = 30;           // world units from a player
export const MAX_ENEMIES = 300;                 // hard cap; spawner stops here
```

- [ ] **Step 2: Replace top of `packages/shared/src/rules.ts`**

Replace lines 1–10 (everything from the import down through `export const SIM_DT_S = 0.05;`) with:

```ts
import type { RoomState } from "./schema.js";
import { PLAYER_SPEED, SIM_DT_S } from "./constants.js";

// Re-export so existing consumers (server, tests) that import these from
// "@mp/shared" via rules.ts continue to work after the relocation.
export { PLAYER_SPEED, SIM_DT_S };
```

The `tickPlayers` function below stays exactly as-is.

- [ ] **Step 3: Update `packages/shared/src/index.ts`**

Add a line before the existing exports so `constants.ts` exports are available via the package barrel:

```ts
export * from "./constants.js";
export * from "./schema.js";
export * from "./messages.js";
export * from "./rules.js";
export * from "./rng.js";
```

- [ ] **Step 4: Verify shared tests still pass (no behavior change)**

Run: `pnpm --filter @mp/shared test`
Expected: all existing tests pass (rules, schema, rng).

- [ ] **Step 5: Verify server tests still pass (it imports `SIM_DT_S` from `@mp/shared`)**

Run: `pnpm --filter @mp/server test`
Expected: all existing server tests pass.

- [ ] **Step 6: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/rules.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(shared): centralize tuning constants in constants.ts

Move PLAYER_SPEED and SIM_DT_S out of rules.ts; derive SIM_DT_S from
TICK_RATE. Adds ENEMY_* constants and MAX_ENEMIES for M3. No behavior
change — rules.ts re-exports the moved constants so existing imports
keep working.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Fill in `Enemy` schema and add round-trip test

**Files:**
- Modify: `packages/shared/src/schema.ts:65-68`
- Modify: `packages/shared/test/schema.test.ts`

The `Enemy` class is currently an empty placeholder. We give it `id`, `kind`, `x`, `z`, `hp` per AD1 / spec §Schema. Strict adherence to the [schema.ts:3-20](../packages/shared/src/schema.ts) landmines comment: `declare` fields, no class-field initializers, all assignment in constructor, `defineTypes` registers the wire types.

- [ ] **Step 1: Add `Enemy` to the imports at the top of `packages/shared/test/schema.test.ts`**

Update the existing `import { Player, RoomState, Vec2 } from "../src/schema.js";` line to:

```ts
import { Enemy, Player, RoomState, Vec2 } from "../src/schema.js";
```

- [ ] **Step 2: Write the failing Enemy encoder tests**

Append to `packages/shared/test/schema.test.ts` after the existing `describe` block. Match the exact pattern used by the existing Player tests (construct → set fields → wrap in `new Encoder(state)` → call `encodeAll()` and assert no throw). This catches the esbuild field-initializer landmine specifically for Enemy.

```ts
describe("Enemy schema", () => {
  it("sets $childType on RoomState.enemies after construction", () => {
    const state = new RoomState();
    expect(
      (state.enemies as unknown as Record<string, unknown>)["~childType"],
    ).toBe(Enemy);
  });

  it("encodes a populated Enemy without throwing", () => {
    const state = new RoomState();
    state.code = "ABCD";
    state.seed = 12345;

    const enemy = new Enemy();
    enemy.id = 42;
    enemy.kind = 0;
    enemy.x = 7.5;
    enemy.z = -3.25;
    enemy.hp = 1;
    state.enemies.set(String(enemy.id), enemy);

    const encoder = new Encoder(state);
    const bytes = encoder.encodeAll();
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("Enemy field defaults from constructor are zero", () => {
    const e = new Enemy();
    expect(e.id).toBe(0);
    expect(e.kind).toBe(0);
    expect(e.x).toBe(0);
    expect(e.z).toBe(0);
    expect(e.hp).toBe(0);
  });

  it("encodes many enemies in one state without throwing", () => {
    // Burst-add path: catches "MapSchema lost its $childType after the
    // first .set" if a class field initializer ever snuck in.
    const state = new RoomState();
    for (let i = 1; i <= 100; i++) {
      const e = new Enemy();
      e.id = i;
      e.kind = 0;
      e.x = i * 0.1;
      e.z = -i * 0.1;
      e.hp = 1;
      state.enemies.set(String(i), e);
    }
    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });
});
```

This matches the existing test discipline: `Encoder.encodeAll()` is the load-bearing call (it's the same code path the Colyseus runtime uses on first client connect), and the `~childType` check directly catches the prototype-setter landmine.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @mp/shared test test/schema.test.ts -t "Enemy schema"`
Expected: FAIL — either the encoder throws on the Enemy fields (because `defineTypes` hasn't been called for them), or the decoded fields are missing/undefined.

- [ ] **Step 4: Fill in the Enemy class in `packages/shared/src/schema.ts`**

Replace lines 65–68 (the empty Enemy placeholder including its comment) with:

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

Same `declare` + constructor-body discipline as Player and Vec2 above. **Do not** use class field initializers (`x = 0`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @mp/shared test test/schema.test.ts -t "Enemy schema"`
Expected: PASS.

- [ ] **Step 6: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass (existing + new).

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/schema.ts packages/shared/test/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): fill in Enemy schema with id/kind/x/z/hp

Enemy is now a real schema with uint32 id, uint8 kind, number x/z, and
uint16 hp. All fields use declare + constructor-body assignment per the
schema.ts landmines comment (no class field initializers — esbuild would
break the encoder). hp is set but not yet read; first combat milestone
will use it.

Round-trip test catches encoder regressions specific to Enemy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `tickEnemies` to `shared/rules.ts`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

Per spec §Rules: enemies move toward their nearest player, no-op when no players exist, no NaN when coincident with target. TDD: write the five tests, then the implementation.

- [ ] **Step 1: Read the existing rules.test.ts pattern**

Read: `packages/shared/test/rules.test.ts`
Note the `addPlayer` helper at lines 5–12 and the `describe("tickPlayers", …)` shape. Match this style.

- [ ] **Step 2: Write the failing `tickEnemies` tests**

Append to `packages/shared/test/rules.test.ts`:

```ts
import { Enemy } from "../src/schema.js";
import { tickEnemies } from "../src/rules.js";
import { ENEMY_SPEED } from "../src/constants.js";

function addEnemy(state: RoomState, id: number, x: number, z: number): Enemy {
  const e = new Enemy();
  e.id = id;
  e.kind = 0;
  e.x = x;
  e.z = z;
  e.hp = 1;
  state.enemies.set(String(id), e);
  return e;
}

describe("tickEnemies", () => {
  it("moves a single enemy toward a single player by ENEMY_SPEED * dt", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    state.players.get("p1")!.x = 10;
    state.players.get("p1")!.z = 0;
    const e = addEnemy(state, 1, 0, 0);

    tickEnemies(state, 1.0);

    expect(e.x).toBeCloseTo(ENEMY_SPEED);
    expect(e.z).toBeCloseTo(0);
  });

  it("picks the nearest player when multiple players exist", () => {
    const state = new RoomState();
    const a = addPlayer(state, "near", 0, 0);
    a.x = 5; a.z = 0;
    const b = addPlayer(state, "far", 0, 0);
    b.x = -100; b.z = 0;
    const e = addEnemy(state, 1, 0, 0);

    tickEnemies(state, 1.0);

    // Moved toward "near" (positive x), not "far" (negative x).
    expect(e.x).toBeGreaterThan(0);
  });

  it("two enemies pick their respective nearest players independently", () => {
    const state = new RoomState();
    const a = addPlayer(state, "left", 0, 0);
    a.x = -10; a.z = 0;
    const b = addPlayer(state, "right", 0, 0);
    b.x = 10; b.z = 0;
    const e1 = addEnemy(state, 1, -3, 0);   // closer to "left"
    const e2 = addEnemy(state, 2, 3, 0);    // closer to "right"
    const e3 = addEnemy(state, 3, 0, 7);    // equidistant — implementation may pick either; assert it moved

    tickEnemies(state, 1.0);

    expect(e1.x).toBeLessThan(-3);          // moved further left toward "left"
    expect(e2.x).toBeGreaterThan(3);        // moved further right toward "right"
    expect(Math.hypot(e3.x - 0, e3.z - 7)).toBeCloseTo(ENEMY_SPEED * 1.0, 5); // moved by exactly ENEMY_SPEED
  });

  it("no-op when no players exist", () => {
    const state = new RoomState();
    const e = addEnemy(state, 1, 4, 5);

    tickEnemies(state, 1.0);

    expect(e.x).toBe(4);
    expect(e.z).toBe(5);
  });

  it("does not produce NaN when enemy is coincident with target player", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const e = addEnemy(state, 1, 0, 0);

    tickEnemies(state, 1.0);

    expect(Number.isFinite(e.x)).toBe(true);
    expect(Number.isFinite(e.z)).toBe(true);
    expect(e.x).toBe(0);
    expect(e.z).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickEnemies"`
Expected: FAIL — `tickEnemies is not a function` (it doesn't exist yet).

- [ ] **Step 4: Implement `tickEnemies` in `packages/shared/src/rules.ts`**

First, replace the existing imports at the top of `packages/shared/src/rules.ts`. After Task 1, the top of the file is:

```ts
import type { RoomState } from "./schema.js";
import { PLAYER_SPEED, SIM_DT_S } from "./constants.js";

export { PLAYER_SPEED, SIM_DT_S };
```

Replace those three lines with:

```ts
import type { Enemy, Player, RoomState } from "./schema.js";
import { ENEMY_SPEED, PLAYER_SPEED, SIM_DT_S } from "./constants.js";

export { PLAYER_SPEED, SIM_DT_S };
```

Then append the `tickEnemies` function to the end of the file:

```ts
/**
 * Each enemy steps toward its nearest player by ENEMY_SPEED * dt. No-op if
 * there are no players. Coincident enemy/player produces no NaN (zero step).
 *
 * Hot loop: squared-distance comparison for "which player is nearest" (no
 * Math.hypot per pair); one Math.sqrt per enemy for the normalized step.
 * Allocates only function-scope locals.
 */
export function tickEnemies(state: RoomState, dt: number): void {
  if (state.players.size === 0) return;

  state.enemies.forEach((enemy: Enemy) => {
    let nearestDx = 0;
    let nearestDz = 0;
    let nearestSq = Infinity;

    state.players.forEach((p: Player) => {
      const dx = p.x - enemy.x;
      const dz = p.z - enemy.z;
      const sq = dx * dx + dz * dz;
      if (sq < nearestSq) {
        nearestSq = sq;
        nearestDx = dx;
        nearestDz = dz;
      }
    });

    if (nearestSq === 0) return;            // coincident: no step
    const dist = Math.sqrt(nearestSq);
    const step = ENEMY_SPEED * dt;
    enemy.x += (nearestDx / dist) * step;
    enemy.z += (nearestDz / dist) * step;
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickEnemies"`
Expected: all 5 PASS.

- [ ] **Step 6: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add tickEnemies — enemies step toward nearest player

Pure rule, mutates state in place. Squared-distance comparison for the
nearest-player choice (no Math.hypot per pair); one Math.sqrt per enemy
for the normalized step. No-op with zero players; coincident
enemy/player produces no NaN.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add `SpawnerState` and `tickSpawner` to `shared/rules.ts`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

Per AD1, AD2, and spec §Rules. The spawner is deterministic given the seeded RNG and the player set. Six tests covering: pre-interval no-op, exact-interval spawn, deterministic five-spawn sequence, catch-up loop, MAX_ENEMIES cap, and empty-room behavior.

- [ ] **Step 1: Write the failing `tickSpawner` tests**

Append to `packages/shared/test/rules.test.ts`:

```ts
import { tickSpawner, type SpawnerState } from "../src/rules.js";
import { mulberry32 } from "../src/rng.js";
import {
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  MAX_ENEMIES,
} from "../src/constants.js";

function freshSpawner(): SpawnerState {
  return { accumulator: 0, nextEnemyId: 1 };
}

describe("tickSpawner", () => {
  it("does not spawn before the interval elapses", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const spawner = freshSpawner();
    const rng = mulberry32(1);

    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S - 0.001, rng);

    expect(state.enemies.size).toBe(0);
    expect(spawner.accumulator).toBeCloseTo(ENEMY_SPAWN_INTERVAL_S - 0.001);
    expect(spawner.nextEnemyId).toBe(1);
  });

  it("spawns exactly one enemy at the spawn interval", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const spawner = freshSpawner();
    const rng = mulberry32(7);

    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(1);
    expect(spawner.accumulator).toBeCloseTo(0);
    expect(spawner.nextEnemyId).toBe(2);

    const enemy = state.enemies.get("1");
    expect(enemy).toBeDefined();
    expect(enemy!.id).toBe(1);
    expect(enemy!.kind).toBe(0);
    expect(enemy!.hp).toBe(1);
    // Spawned at radius from the only player.
    const r = Math.hypot(enemy!.x - p.x, enemy!.z - p.z);
    expect(r).toBeCloseTo(ENEMY_SPAWN_RADIUS, 5);
  });

  it("produces reproducible spawn positions from a fixed seed", () => {
    // Determinism load-bearing test. If this drifts, two clients will
    // see enemies at different positions — the verification step that
    // relies on cross-client visual agreement depends on this.
    const stateA = new RoomState();
    addPlayer(stateA, "p1", 0, 0);
    const spawnerA = freshSpawner();
    const rngA = mulberry32(42);

    for (let i = 0; i < 5; i++) {
      tickSpawner(stateA, spawnerA, ENEMY_SPAWN_INTERVAL_S, rngA);
    }
    expect(stateA.enemies.size).toBe(5);

    // Same seed, same player setup → identical positions.
    const stateB = new RoomState();
    addPlayer(stateB, "p1", 0, 0);
    const spawnerB = freshSpawner();
    const rngB = mulberry32(42);

    for (let i = 0; i < 5; i++) {
      tickSpawner(stateB, spawnerB, ENEMY_SPAWN_INTERVAL_S, rngB);
    }

    for (let id = 1; id <= 5; id++) {
      const a = stateA.enemies.get(String(id))!;
      const b = stateB.enemies.get(String(id))!;
      expect(b.x).toBeCloseTo(a.x, 10);
      expect(b.z).toBeCloseTo(a.z, 10);
    }
  });

  it("catches up when dt is several intervals", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const spawner = freshSpawner();
    const rng = mulberry32(3);

    tickSpawner(state, spawner, 2.5 * ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(2);
    expect(spawner.accumulator).toBeCloseTo(0.5 * ENEMY_SPAWN_INTERVAL_S);
    expect(spawner.nextEnemyId).toBe(3);
  });

  it("stops spawning at MAX_ENEMIES and drains the accumulator", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    // Pre-fill to MAX_ENEMIES.
    for (let i = 1; i <= MAX_ENEMIES; i++) {
      const e = new Enemy();
      e.id = i; e.kind = 0; e.x = 0; e.z = 0; e.hp = 1;
      state.enemies.set(String(i), e);
    }
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: MAX_ENEMIES + 1 };
    const rng = mulberry32(5);

    tickSpawner(state, spawner, 5 * ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(MAX_ENEMIES);     // unchanged
    expect(spawner.accumulator).toBe(0);              // drained per AD2 reasoning
    expect(spawner.nextEnemyId).toBe(MAX_ENEMIES + 1);// not incremented
  });

  it("does not advance the accumulator when the room is empty", () => {
    const state = new RoomState();
    const spawner = freshSpawner();
    const rng = mulberry32(9);

    tickSpawner(state, spawner, 100 * ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(0);
    expect(spawner.accumulator).toBe(0);

    // Now a player joins and one interval passes — exactly one spawn.
    addPlayer(state, "p1", 0, 0);
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(1);
    expect(spawner.accumulator).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickSpawner"`
Expected: FAIL — `tickSpawner is not a function`.

- [ ] **Step 3: Implement `SpawnerState` and `tickSpawner`**

First, extend the imports at the top of `packages/shared/src/rules.ts`. After Task 3, the top imports look like:

```ts
import type { Enemy, Player, RoomState } from "./schema.js";
import { ENEMY_SPEED, PLAYER_SPEED, SIM_DT_S } from "./constants.js";
```

Update them to:

```ts
import { Enemy, type Player, type RoomState } from "./schema.js";
import {
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  MAX_ENEMIES,
  PLAYER_SPEED,
  SIM_DT_S,
} from "./constants.js";
import type { Rng } from "./rng.js";
```

Note `Enemy` is now a value import (not just `type`) because `tickSpawner` constructs Enemy instances. Player and RoomState stay as type imports.

Then append the new types and function to the end of `packages/shared/src/rules.ts`:

```ts
export type SpawnerState = {
  accumulator: number;   // seconds since last spawn
  nextEnemyId: number;   // monotonic; starts at 1 so id=0 is never valid
};

/**
 * Advance the spawn timer; emit enemies when the interval elapses.
 * No-op (and does NOT advance the accumulator) when the room is empty —
 * this avoids "join into a swarm" when a player joins a long-empty room.
 *
 * When state.enemies.size >= MAX_ENEMIES, drain the accumulator on the
 * same call. Reasoning: if it stalled, the moment one enemy was removed
 * (next milestone, when combat lands) we'd flood. Drain is the right
 * default.
 */
export function tickSpawner(
  state: RoomState,
  spawner: SpawnerState,
  dt: number,
  rng: Rng,
): void {
  if (state.players.size === 0) return;

  spawner.accumulator += dt;

  while (spawner.accumulator >= ENEMY_SPAWN_INTERVAL_S) {
    if (state.enemies.size >= MAX_ENEMIES) {
      spawner.accumulator = 0;
      return;
    }

    const playerIdx = Math.floor(rng() * state.players.size);
    let i = 0;
    let target: Player | undefined;
    state.players.forEach((p) => {
      if (i === playerIdx) target = p;
      i++;
    });
    if (!target) {
      // size > 0 was checked above — this shouldn't happen, but be defensive.
      spawner.accumulator = 0;
      return;
    }

    const angle = rng() * Math.PI * 2;
    const enemy = new Enemy();
    enemy.id = spawner.nextEnemyId++;
    enemy.kind = 0;
    enemy.x = target.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
    enemy.z = target.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
    enemy.hp = 1;
    state.enemies.set(String(enemy.id), enemy);

    spawner.accumulator -= ENEMY_SPAWN_INTERVAL_S;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickSpawner"`
Expected: all 6 PASS.

- [ ] **Step 5: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add tickSpawner — deterministic enemy spawning

SpawnerState (accumulator + nextEnemyId) lives off-schema (AD1) — the
caller owns the instance and passes it in. Empty-room behavior (AD2)
freezes the accumulator so a joining player isn't flooded.

The fixed-seed reproducibility test is load-bearing: two clients seeing
the same enemy positions depends on this RNG sequence being identical
across runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add `spawnDebugBurst` to `shared/rules.ts`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

Used by the server's `debug_spawn` handler. Same RNG and same `nextEnemyId` sequence as the auto-spawner — a burst doesn't desync future spawns.

- [ ] **Step 1: Write the failing `spawnDebugBurst` tests**

Append to `packages/shared/test/rules.test.ts`:

```ts
import { spawnDebugBurst } from "../src/rules.js";

describe("spawnDebugBurst", () => {
  it("spawns N enemies around the given player at ENEMY_SPAWN_RADIUS", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 5; p.z = -3;
    const spawner = freshSpawner();
    const rng = mulberry32(11);

    spawnDebugBurst(state, spawner, rng, p, 10, 0);

    expect(state.enemies.size).toBe(10);
    state.enemies.forEach((e) => {
      const r = Math.hypot(e.x - p.x, e.z - p.z);
      expect(r).toBeCloseTo(ENEMY_SPAWN_RADIUS, 5);
      expect(e.kind).toBe(0);
      expect(e.hp).toBe(1);
    });
  });

  it("clamps the burst at remaining capacity (MAX_ENEMIES - current)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    // Pre-fill to MAX_ENEMIES - 5.
    for (let i = 1; i <= MAX_ENEMIES - 5; i++) {
      const e = new Enemy();
      e.id = i; e.kind = 0; e.x = 0; e.z = 0; e.hp = 1;
      state.enemies.set(String(i), e);
    }
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: MAX_ENEMIES - 4 };
    const rng = mulberry32(13);

    spawnDebugBurst(state, spawner, rng, p, 50, 0);

    expect(state.enemies.size).toBe(MAX_ENEMIES);     // exactly 5 added
    expect(spawner.nextEnemyId).toBe(MAX_ENEMIES + 1); // 5 ids consumed
  });

  it("shares the nextEnemyId sequence with the auto-spawner", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const spawner = freshSpawner();
    const rng = mulberry32(17);

    // 1 auto-spawn → id=1
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);
    // burst of 3 → ids 2,3,4
    spawnDebugBurst(state, spawner, rng, p, 3, 0);
    // 1 auto-spawn → id=5
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);

    expect(state.enemies.size).toBe(5);
    for (let id = 1; id <= 5; id++) {
      expect(state.enemies.get(String(id))).toBeDefined();
    }
    expect(spawner.nextEnemyId).toBe(6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "spawnDebugBurst"`
Expected: FAIL — `spawnDebugBurst is not a function`.

- [ ] **Step 3: Implement `spawnDebugBurst`**

Append to `packages/shared/src/rules.ts`:

```ts
/**
 * Used by the server's debug_spawn handler. Places `count` enemies (clamped
 * to MAX_ENEMIES - current) at random angles around centerPlayer at
 * ENEMY_SPAWN_RADIUS. Uses the same rng + nextEnemyId as the auto-spawner —
 * a burst does NOT desync future deterministic spawns.
 */
export function spawnDebugBurst(
  state: RoomState,
  spawner: SpawnerState,
  rng: Rng,
  centerPlayer: Player,
  count: number,
  kind: number,
): void {
  const remaining = MAX_ENEMIES - state.enemies.size;
  const n = Math.max(0, Math.min(count, remaining));

  for (let i = 0; i < n; i++) {
    const angle = rng() * Math.PI * 2;
    const enemy = new Enemy();
    enemy.id = spawner.nextEnemyId++;
    enemy.kind = kind;
    enemy.x = centerPlayer.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
    enemy.z = centerPlayer.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
    enemy.hp = 1;
    state.enemies.set(String(enemy.id), enemy);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "spawnDebugBurst"`
Expected: all 3 PASS.

- [ ] **Step 5: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add spawnDebugBurst for debug_spawn handler

Bursts share the auto-spawner's RNG and nextEnemyId sequence, so
triggering a burst does not desync future deterministic spawn positions.
Capacity-clamps to MAX_ENEMIES - state.enemies.size.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add debug message types to `shared/messages.ts`

**Files:**
- Modify: `packages/shared/src/messages.ts`

These are needed by both the server (handlers) and client (`room.send`) in later tasks. Add them now while we're in shared.

- [ ] **Step 1: Read the existing `messages.ts` for the pattern**

Read: `packages/shared/src/messages.ts`
Note: `InputMessage`, `PingMessage`, `ClientMessage` union, `MessageType` const. Match exactly.

- [ ] **Step 2: Replace `packages/shared/src/messages.ts`**

```ts
export type InputMessage = {
  type: "input";
  seq: number;                            // monotonic per client (required)
  dir: { x: number; z: number };
};

export type PingMessage = {
  type: "ping";
  t: number;
};

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

// Server→client one-shot, NOT a ClientMessage variant (rule 3 governs
// client→server only). Documented here so a grep on this file finds the
// shape:
//   pong: { t: number }   // echoed from PingMessage.t
export type PongMessage = {
  type: "pong";
  t: number;
};

export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
  DebugSpawn: "debug_spawn",
  DebugClearEnemies: "debug_clear_enemies",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Verify tests still pass (no behavior change)**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/messages.ts
git commit -m "$(cat <<'EOF'
feat(shared): add debug_spawn + debug_clear_enemies to ClientMessage

Adds the two debug message types to the discriminated union so server
handlers and client room.send calls can be statically typed in M3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Server

### Task 7: Wire enemy ticks into `GameRoom`; add 5-second integration test

**Files:**
- Modify: `packages/server/src/GameRoom.ts`
- Modify: `packages/server/test/integration.test.ts`

TDD style: write the failing integration test first (it spins up a real Colyseus server in-process and asserts ~5 enemies appear in 5 seconds), then wire the tick to make it pass. Per the project's workflow-preferences memory, integration tests for any real-runtime path are required.

- [ ] **Step 1: Read the existing integration test for the pattern**

Read: `packages/server/test/integration.test.ts`
Note the `beforeAll`/`afterAll`, the in-process `Server` boot at `PORT = 2598`, the `Client` from `colyseus.js`, the `waitFor` helper. Match exactly.

- [ ] **Step 2: Write the failing integration test**

Append to `packages/server/test/integration.test.ts` (after the existing `describe`):

```ts
describe("integration: enemy spawn + movement over real ticks", () => {
  it("spawns ~5 enemies in 5 seconds and they move toward the connected player", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<{
      code: string;
      enemies: { size: number; forEach: (cb: (e: { x: number; z: number }, k: string) => void) => void };
    }>("game", { name: "Solo" });

    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Server runs at 20 Hz; spawn interval is 1.0 s. Wait ~5.5 s wall time.
    await new Promise((r) => setTimeout(r, 5500));

    const enemyCount = room.state.enemies.size;
    expect(enemyCount).toBeGreaterThanOrEqual(4);
    expect(enemyCount).toBeLessThanOrEqual(6);

    // Snapshot current enemy positions; wait 4 ticks; assert at least one
    // enemy moved.
    const before = new Map<string, { x: number; z: number }>();
    room.state.enemies.forEach((e, k) => before.set(k, { x: e.x, z: e.z }));

    await new Promise((r) => setTimeout(r, 200));

    let moved = 0;
    room.state.enemies.forEach((e, k) => {
      const prev = before.get(k);
      if (!prev) return;
      if (Math.abs(e.x - prev.x) > 1e-4 || Math.abs(e.z - prev.z) > 1e-4) moved++;
    });
    expect(moved).toBeGreaterThan(0);

    await room.leave();
  }, 10_000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @mp/server test test/integration.test.ts -t "enemy spawn"`
Expected: FAIL — enemy count is 0 because the spawner isn't wired into the tick.

- [ ] **Step 4: Wire the rules into GameRoom**

In `packages/server/src/GameRoom.ts`:

a) Update the import from `@mp/shared` (currently lines 1–3) to include the new symbols:

```ts
import { Room, Client } from "colyseus";
import {
  Player,
  RoomState,
  tickPlayers,
  tickEnemies,
  tickSpawner,
  SIM_DT_S,
  mulberry32,
  type Rng,
  type SpawnerState,
} from "@mp/shared";
import type { InputMessage, PingMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";
```

b) Add two private instance fields in the `GameRoom` class body, immediately below the existing `override maxClients = MAX_PLAYERS;`:

```ts
private rng!: Rng;
private spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };
```

c) In `onCreate`, immediately after the existing `this.setState(state);` line (around line 42), add:

```ts
this.rng = mulberry32(state.seed);
```

d) Replace the `tick()` method body:

```ts
private tick(): void {
  this.state.tick += 1;
  tickPlayers(this.state, SIM_DT_S);
  tickEnemies(this.state, SIM_DT_S);
  tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `pnpm --filter @mp/server test test/integration.test.ts -t "enemy spawn"`
Expected: PASS. Enemy count is 4–6 after 5.5 s; at least one enemy moved over 200 ms.

- [ ] **Step 6: Run the full server test suite**

Run: `pnpm --filter @mp/server test`
Expected: all tests pass (existing reconnect/sync/integration tests still green).

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/GameRoom.ts packages/server/test/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(server): wire tickEnemies + tickSpawner into GameRoom

Room owns a mulberry32(state.seed) RNG and a SpawnerState instance —
neither lives on the schema (AD1). Tick order is players → enemies →
spawner: enemies see this-tick player positions; a fresh spawn does not
move on its own creation tick.

Integration test boots a real Colyseus server, asserts ~5 enemies after
5 s and that they move.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Add debug message handlers to `GameRoom`

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

Per AD6: validate `count`, clamp at `MAX_ENEMIES`, default `kind` to 0, gated behind `ALLOW_DEBUG_MESSAGES`. The handlers stay thin — actual placement logic lives in `spawnDebugBurst` (rule 4: handlers route, rules decide).

- [ ] **Step 1: Extend the import in `packages/server/src/GameRoom.ts`**

Update the `@mp/shared` import to include the message types, the burst function, and `MAX_ENEMIES`:

```ts
import {
  Player,
  RoomState,
  tickPlayers,
  tickEnemies,
  tickSpawner,
  spawnDebugBurst,
  SIM_DT_S,
  MAX_ENEMIES,
  mulberry32,
  type Rng,
  type SpawnerState,
} from "@mp/shared";
import type {
  InputMessage,
  PingMessage,
  DebugSpawnMessage,
  DebugClearEnemiesMessage,
} from "@mp/shared";
```

- [ ] **Step 2: Add module-level constant near the top of the file**

After the existing `const DEFAULT_RECONNECTION_GRACE_S = 30;` line (around line 9), add:

```ts
const ALLOW_DEBUG_MESSAGES = true;     // becomes runtime config later
```

- [ ] **Step 3: Register the debug handlers in `onCreate`**

After the existing `ping` handler (just before `this.setSimulationInterval(...)`), add:

```ts
if (ALLOW_DEBUG_MESSAGES) {
  this.onMessage<DebugSpawnMessage>("debug_spawn", (client, message) => {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const requested = Number(message?.count);
    if (!Number.isFinite(requested) || requested <= 0) return;
    const cap = Math.min(Math.floor(requested), MAX_ENEMIES);

    const kindRaw = Number(message?.kind);
    const kind = Number.isFinite(kindRaw) && kindRaw >= 0
      ? Math.floor(kindRaw)
      : 0;

    spawnDebugBurst(this.state, this.spawner, this.rng, player, cap, kind);
  });

  this.onMessage<DebugClearEnemiesMessage>("debug_clear_enemies", () => {
    this.state.enemies.clear();
  });
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Verify all tests still pass**

Run: `pnpm test`
Expected: all tests pass (no test changes — handlers exist but no client invokes them yet; the integration test in Task 7 still passes).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "$(cat <<'EOF'
feat(server): add debug_spawn + debug_clear_enemies handlers

Gated by ALLOW_DEBUG_MESSAGES (currently true; becomes runtime config
later). debug_spawn validates count as a finite positive integer and
clamps per-call to MAX_ENEMIES (AD6); kind defaults to 0 if missing or
invalid. Both handlers stay thin per CLAUDE.md rule 4 — placement logic
lives in spawnDebugBurst.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Add snapshot byte logger to `GameRoom`

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

Per AD3: full-state encoded size every 5 s (proxy for "absolute baseline") plus per-tick patch size via internal hook (more useful number, more fragile). Both wrapped in try/catch with one-shot warn so a Colyseus upgrade fails loudly, not silently.

- [ ] **Step 1: Add module-level constant**

After the `ALLOW_DEBUG_MESSAGES` constant added in Task 8, add:

```ts
const SNAPSHOT_LOG_INTERVAL_MS = 5_000;
```

- [ ] **Step 2: Add private fields to the `GameRoom` class**

Below the existing `private spawner: ...` field added in Task 7, add:

```ts
private snapshotLogTimer: NodeJS.Timeout | null = null;
private patchByteCount = 0;
private patchSampleCount = 0;
private patchInstrumentationFailed = false;
```

- [ ] **Step 3: Add the `installSnapshotLogger` and `onDispose` methods**

Add `installSnapshotLogger` as a private method on the class (placed after the existing `tick()` method), and add an `override onDispose()` method:

```ts
override onDispose(): void {
  if (this.snapshotLogTimer) clearInterval(this.snapshotLogTimer);
}

private installSnapshotLogger(): void {
  // Per-tick byte counting via broadcastPatch override. The exact internal
  // signature varies between Colyseus versions; the try/catch lets a
  // future upgrade fail loudly rather than silently logging zeros.
  try {
    const self = this as unknown as { broadcastPatch?: () => unknown };
    const original = self.broadcastPatch?.bind(this);
    if (typeof original !== "function") {
      throw new Error("Room#broadcastPatch unavailable on this Colyseus version");
    }
    self.broadcastPatch = () => {
      const result = original();
      // The encoded patch buffer is what `broadcastPatch` produces internally.
      // Some Colyseus versions return a Buffer; some return void. If it's a
      // Buffer (or has a numeric `length`), tally it. Otherwise leave the
      // counter alone — full-state encode below still gives us a baseline.
      const len = (result as { length?: number } | undefined)?.length;
      if (typeof len === "number" && Number.isFinite(len)) {
        this.patchByteCount += len;
        this.patchSampleCount += 1;
      }
      return result;
    };
  } catch (err) {
    this.patchInstrumentationFailed = true;
    console.warn(
      `[room ${this.state.code}] patch instrumentation unavailable: ${
        err instanceof Error ? err.message : String(err)
      } — snapshot log will show full-state only`,
    );
  }

  this.snapshotLogTimer = setInterval(() => {
    const enemies = this.state.enemies.size;
    const players = this.state.players.size;
    const avgPatch = this.patchSampleCount > 0
      ? Math.round(this.patchByteCount / this.patchSampleCount)
      : 0;

    let fullBytes = -1;
    try {
      const encoder = (this.state as unknown as { encodeAll?: () => Uint8Array }).encodeAll;
      const buf = encoder?.call(this.state);
      if (buf?.length != null) fullBytes = buf.length;
    } catch (err) {
      console.warn(
        `[room ${this.state.code}] full-state encode failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
```

- [ ] **Step 4: Call `installSnapshotLogger` from `onCreate`**

Add a call immediately before `this.setSimulationInterval(...)` in `onCreate`:

```ts
this.installSnapshotLogger();
this.setSimulationInterval(() => this.tick(), TICK_INTERVAL_MS);
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Verify all tests still pass**

Run: `pnpm test`
Expected: all tests pass. The integration test in Task 7 will print one or two snapshot log lines during its 5.5 s wait — that's expected output, not a failure.

- [ ] **Step 7: Smoke-check the log output manually**

Run: `pnpm --filter @mp/server test test/integration.test.ts -t "enemy spawn" 2>&1 | grep "snapshot"`
Expected: at least one line like `[room ABCD] snapshot avg=...B/tick full=...B enemies=N players=1` (or `avg=n/a` if patch instrumentation fell back). If `full=n/a` AND `avg=n/a`, the Colyseus internals are different than expected — investigate before continuing; the perf test depends on at least one of these numbers being available.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "$(cat <<'EOF'
feat(server): log snapshot byte size every 5s (per-tick + full-state)

Per AD3: per-tick patch size via broadcastPatch override (fragile,
wrapped in try/catch with one-shot warn) plus full-state encoded size
(stable, called from a 5s timer). The two numbers together cover
"what does steady-state sync cost?" and "what does a new joiner pay?"

onDispose clears the timer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Client

### Task 10: Extend `hudState` and `DebugHud` with enemy/draw-call/snap-bytes lines

**Files:**
- Modify: `packages/client/src/net/hudState.ts`
- Modify: `packages/client/src/game/DebugHud.tsx`

These show up in the HUD when F3 is pressed. Adding the fields first means later tasks can populate them without scaffolding ceremony.

- [ ] **Step 1: Replace `packages/client/src/net/hudState.ts`**

```ts
// Mutable singleton read by DebugHud each requestAnimationFrame, mutated in
// place by the network/prediction code. Avoids React state churn on the
// hot loop. Treat this as a debugging surface, not an API.

export type HudState = {
  pingMs: number;
  serverTick: number;
  snapshotsPerSec: number;
  interpDelayMs: number;
  playerCount: number;
  reconErr: number;
  enemyCount: number;          // active enemies
  enemyDrawCalls: number;      // gl.info.render.calls — proxy for "instancing working"
  lastSnapshotBytes: number;   // best-effort client-side; authoritative number is in server log
  visible: boolean;
};

export const hudState: HudState = {
  pingMs: 0,
  serverTick: 0,
  snapshotsPerSec: 0,
  interpDelayMs: 100,
  playerCount: 0,
  reconErr: 0,
  enemyCount: 0,
  enemyDrawCalls: 0,
  lastSnapshotBytes: 0,
  visible: false,
};
```

- [ ] **Step 2: Update the HUD output in `packages/client/src/game/DebugHud.tsx`**

Replace lines 34–41 (the `lines` array) with:

```ts
const lines = [
  `ping       ${hudState.pingMs.toFixed(0)} ms`,
  `server tick ${hudState.serverTick}`,
  `snapshots  ${hudState.snapshotsPerSec.toFixed(1)} / s`,
  `interp     ${hudState.interpDelayMs} ms`,
  `players    ${hudState.playerCount}`,
  `recon err  ${hudState.reconErr.toFixed(3)} u`,
  `enemies    ${hudState.enemyCount}`,
  `draw calls ${hudState.enemyDrawCalls}`,
  `snap bytes ${hudState.lastSnapshotBytes} B`,
];
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds. (We don't have client tests, so build success is the structural check.)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/net/hudState.ts packages/client/src/game/DebugHud.tsx
git commit -m "$(cat <<'EOF'
feat(client): add enemies / draw calls / snap bytes HUD lines

Three new mutable fields on hudState (enemyCount, enemyDrawCalls,
lastSnapshotBytes) and three new lines in DebugHud. Populated by
EnemySwarm and the GameView enemy plumbing in the next tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Create `EnemySwarm.tsx` (single InstancedMesh + slot allocator)

**Files:**
- Create: `packages/client/src/game/EnemySwarm.tsx`

Per AD4: swap-and-pop slot allocator keeps the InstancedMesh's active range packed at `[0, count)`. Per AD7: per-frame, sample each enemy's `SnapshotBuffer` at `now - interpDelayMs` and write the matrix.

- [ ] **Step 1: Create `packages/client/src/game/EnemySwarm.tsx`**

```tsx
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import { MAX_ENEMIES } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const ENEMY_RENDER_Y = 0.6;

export type EnemySwarmProps = {
  enemyIds: Set<number>;
  buffers: Map<number, SnapshotBuffer>;
};

/**
 * Renders all enemies in a single InstancedMesh of capacity MAX_ENEMIES.
 * Per AD4: a swap-and-pop slot allocator keeps the active range packed at
 * [0, activeCount). Per AD7: each enemy interpolates from its own
 * SnapshotBuffer (mirror of the player pattern).
 */
export function EnemySwarm({ enemyIds, buffers }: EnemySwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const slotForId = useRef(new Map<number, number>());
  const idAtSlot = useRef<number[]>([]);
  const activeCountRef = useRef(0);
  const matrix = useMemo(() => new Matrix4(), []);
  const { gl } = useThree();

  // Sync the slot table with enemyIds whenever the Set identity changes.
  // GameView's onEnemyAdd/onEnemyRemove always create a new Set instance,
  // so this effect fires on any membership change.
  useEffect(() => {
    // Add: any id in enemyIds that isn't slotted gets the next slot.
    enemyIds.forEach((id) => {
      if (slotForId.current.has(id)) return;
      const slot = activeCountRef.current++;
      slotForId.current.set(id, slot);
      idAtSlot.current[slot] = id;
    });
    // Remove: any slotted id no longer in enemyIds — swap-and-pop.
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

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors. (The component isn't mounted yet — Task 12 mounts it. Typecheck verifies the imports and types resolve.)

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/EnemySwarm.tsx
git commit -m "$(cat <<'EOF'
feat(client): add EnemySwarm — single InstancedMesh for all enemies

Capacity MAX_ENEMIES (300). Swap-and-pop slot allocator keeps the active
range packed at [0, count); mesh.count controls how many instances render
each frame. Per-instance matrix comes from interpolating each enemy's
SnapshotBuffer at now - interpDelayMs (mirrors player interpolation).

6-sided cone geometry, height 1.2, radius 0.5, color #c44 — visually
distinct from player cubes' 70%-saturation HSL hues.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Plumb enemy state in `GameView.tsx`

**Files:**
- Modify: `packages/client/src/game/GameView.tsx`

Mirror the existing players block. The `getStateCallbacks(room).enemies.onAdd / onRemove` and `$(enemy).onChange` plumbing populates the `Map<number, SnapshotBuffer>` and the `Set<number>` that `EnemySwarm` consumes. Mount one `<EnemySwarm>` inside the `<Canvas>`.

- [ ] **Step 1: Read the current `GameView.tsx` players block carefully**

Read: `packages/client/src/game/GameView.tsx`
Identify lines 55–104 (the `perPlayerDisposers`, `onAdd`, `onRemove`, `offAdd`, `offRemove`, and the initial `forEach`). The enemy plumbing is structurally identical with these substitutions:
- `players` → `enemies`
- `Player` → `Enemy`
- `sessionId: string` key → `id: number` key (so we `Number(key)` in the callbacks)
- No predictor branch (enemies have no client prediction)

- [ ] **Step 2: Update imports at the top of `GameView.tsx`**

Replace the existing `import type { Player, RoomState }` line with:

```ts
import type { Enemy, Player, RoomState } from "@mp/shared";
```

Add `EnemySwarm` import alongside the existing `PlayerCube` import:

```ts
import { EnemySwarm } from "./EnemySwarm.js";
```

- [ ] **Step 3: Add new state + ref hooks at the top of the `GameView` component**

After the existing `const [code, setCode] = useState<string>(room.state.code ?? "");` line, add:

```ts
const enemyBuffers = useMemo(() => new Map<number, SnapshotBuffer>(), []);
const [enemyIds, setEnemyIds] = useState<Set<number>>(new Set());
```

- [ ] **Step 4: Add enemy plumbing inside the existing `useEffect`**

Inside the existing `useEffect` (which currently sets up the player plumbing), after the `room.state.players.forEach(...)` line (~line 104) and before the `leaveHandler` declaration, insert the enemy block:

```ts
const perEnemyDisposers = new Map<number, () => void>();

const onEnemyAdd = (enemy: Enemy, key: string) => {
  const id = Number(key);
  let buf = enemyBuffers.get(id);
  if (!buf) {
    buf = new SnapshotBuffer();
    enemyBuffers.set(id, buf);
  }
  buf.push({ t: performance.now(), x: enemy.x, z: enemy.z });

  const existing = perEnemyDisposers.get(id);
  if (existing) existing();

  const offChange = $(enemy).onChange(() => {
    buf!.push({ t: performance.now(), x: enemy.x, z: enemy.z });
  });
  perEnemyDisposers.set(id, offChange);

  setEnemyIds((prev) => {
    const next = new Set(prev);
    next.add(id);
    return next;
  });
  hudState.enemyCount = enemyBuffers.size;
};

const onEnemyRemove = (_enemy: Enemy, key: string) => {
  const id = Number(key);
  const off = perEnemyDisposers.get(id);
  if (off) {
    off();
    perEnemyDisposers.delete(id);
  }
  enemyBuffers.delete(id);
  setEnemyIds((prev) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
  hudState.enemyCount = enemyBuffers.size;
};

const offEnemyAdd = $(room.state).enemies.onAdd(onEnemyAdd);
const offEnemyRemove = $(room.state).enemies.onRemove(onEnemyRemove);

room.state.enemies.forEach((e, key) => onEnemyAdd(e, key));
```

- [ ] **Step 5: Extend the cleanup return inside the same `useEffect`**

The existing return at the bottom of the effect disposes player listeners. Add to it (before the final `detachInput()` line):

```ts
offEnemyAdd();
offEnemyRemove();
perEnemyDisposers.forEach((off) => off());
perEnemyDisposers.clear();
enemyBuffers.clear();
```

The `enemyBuffers.clear()` matters because the `useMemo` makes the same Map identity persist across re-renders — if the effect re-runs without clearing, we'd keep stale buffers from a prior room.

Also extend the `useEffect` dependency array (currently `[room, buffers, predictor, onUnexpectedLeave]`) to include `enemyBuffers`:

```ts
}, [room, buffers, predictor, enemyBuffers, onUnexpectedLeave]);
```

- [ ] **Step 6: Mount `<EnemySwarm>` inside the `<Canvas>`**

Inside the `<Canvas>` element (at the bottom of the JSX return), after the players `.map(...)` block and before the closing `</Canvas>`, add:

```tsx
<EnemySwarm enemyIds={enemyIds} buffers={enemyBuffers} />
```

- [ ] **Step 7: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 9: Manual verification — single client**

Run `pnpm dev` (in a separate terminal). Open `http://localhost:5173`, create a room, wait ~5 seconds. Expected: cones appear and walk toward your cube. Press F3 — the HUD should show `enemies` count growing. Close the dev server when satisfied.

(If cones do NOT appear: check the browser console for errors. The likely culprits, in order, are: (a) `getStateCallbacks(room).enemies` returning undefined because the schema isn't registering Enemy correctly — re-check Task 2, (b) the `useEffect` dependency array failing to re-run the effect on initial mount, (c) `EnemySwarm` not mounted inside `<Canvas>`.)

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/game/GameView.tsx
git commit -m "$(cat <<'EOF'
feat(client): plumb enemy state and mount EnemySwarm

Mirror of the existing players block: getStateCallbacks(room).enemies
.onAdd / onRemove pushes per-enemy SnapshotBuffer snapshots and updates
a Set<number> of active enemy ids that EnemySwarm consumes for its slot
table. Cleanup on effect re-run clears per-enemy listeners and the
buffer map so a fresh room start does not inherit stale buffers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Add debug keybinds (`]`, `}`, `\`) to `GameView.tsx`

**Files:**
- Modify: `packages/client/src/game/GameView.tsx`

Per spec §Debug keybinds: active only when `hudState.visible === true`. `e.preventDefault()` for parity with the F3 fix in `bd46b50`.

- [ ] **Step 1: Read the current keydown handler in `GameView.tsx`**

Located around lines 120–125 (the `keyHandler` const and the `addEventListener("keydown", ...)` call).

- [ ] **Step 2: Replace the `keyHandler` with the extended version**

Replace the current handler:

```ts
const keyHandler = (e: KeyboardEvent) => {
  if (e.code === "F3") {
    e.preventDefault();
    hudState.visible = !hudState.visible;
  }
};
```

with:

```ts
const keyHandler = (e: KeyboardEvent) => {
  if (e.code === "F3") {
    e.preventDefault();
    hudState.visible = !hudState.visible;
    return;
  }
  if (!hudState.visible) return;

  if (e.code === "BracketRight" && !e.shiftKey) {
    e.preventDefault();
    room.send("debug_spawn", { type: "debug_spawn", count: 10 });
  } else if (e.code === "BracketRight" && e.shiftKey) {
    e.preventDefault();
    room.send("debug_spawn", { type: "debug_spawn", count: 100 });
  } else if (e.code === "Backslash") {
    e.preventDefault();
    room.send("debug_clear_enemies", { type: "debug_clear_enemies" });
  }
};
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification — keybinds**

Run `pnpm dev`. Open the client, create a room. Press `F3` to show the HUD. Press `]` — `enemies` count jumps by 10. Press `Shift+]` (`}`) — count jumps by 100. Press `\` — count drops to 0 immediately. If you press `]` without F3 first (HUD hidden), nothing happens.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/game/GameView.tsx
git commit -m "$(cat <<'EOF'
feat(client): add debug keybinds — ] / shift+] spawn, \\ clears

Active only when the F3 HUD is visible. Sends the M3 debug message
types added to ClientMessage. preventDefault for parity with the F3
handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Verification, docs, perf

### Task 14: Update `CLAUDE.md` with rule 10

**Files:**
- Modify: `CLAUDE.md`

Per spec §CLAUDE.md update.

- [ ] **Step 1: Open `CLAUDE.md` and locate the "Architectural rules" section**

Find the existing rule 9 (the tickrate / interpolation / prediction rule). Rule 10 follows it.

- [ ] **Step 2: Append rule 10 after rule 9**

Insert as item 10 in the numbered list:

```markdown
10. **Enemies are simulated server-only and rendered client-side via
    InstancedMesh.** Never one Three.js Mesh per enemy. The single
    InstancedMesh has capacity `MAX_ENEMIES`; per-instance position comes
    from interpolating a per-enemy `SnapshotBuffer`, identified by the
    server-assigned `Enemy.id` (never by `MapSchema` iteration order).
    Spawner state (`accumulator`, `nextEnemyId`) lives on the GameRoom
    instance, not on RoomState — server-only counters do not pollute the
    schema.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md rule 10 — enemy InstancedMesh + spawner-off-schema

Captures the load-bearing M3 decisions for future entity types (XP gems,
client-simulated projectiles when they need server-driven IDs):
InstancedMesh from instance one, identity by server-assigned id, and
server-only counters stay off the synced schema.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Manual verification + perf test + record numbers in README

**Files:**
- Modify: `README.md`

Run the full verification list from spec §Verification, then the perf check from spec §Performance check, then write down the numbers honestly. **Do not optimize anything** during this task — if numbers are concerning, stop and report.

- [ ] **Step 1: `pnpm typecheck` and `pnpm test` both pass**

Run: `pnpm typecheck && pnpm test`
Expected: green across the board. Stop and fix if anything fails.

- [ ] **Step 2: Run the full manual verification list**

Start `pnpm dev`. Open two browser tabs at `http://localhost:5173`. Walk through:

1. **Auto-spawn visible.** Both tabs join. Within ~5 s, cones appear and walk toward player cubes. Movement is smooth.
2. **Cross-client determinism.** Pick a distinctive cone (e.g. the leftmost). Confirm same world position in both tabs. *If different:* `grep -r "Math.random" packages/client/src/` and check anything reachable from EnemySwarm — there must be no client-side RNG affecting render.
3. **Burst (`}`).** Press F3 in either tab to show the HUD. Press `Shift+]` — 100 enemies appear simultaneously in both tabs within one frame. fps holds at 60.
4. **Clear (`\`).** Press `\`. Enemies vanish in the same frame on both tabs. No flicker, no ghost meshes. HUD `enemies` → 0.
5. **Network throttle.** DevTools → Network → "Fast 3G" on tab A. Press `Shift+]` — 100 enemies. Tab A's enemies lag behind tab B's reality (correct: more ms behind newest snapshot) but show no jitter or snap. Local cube on tab A still feels responsive (M2 prediction is unaffected).
6. **Reconnect mid-spawn.** Press `Shift+]` — 100 enemies. In tab A's DevTools, switch to "Offline" for ~5 s (within the 30 s reconnect grace). Restore. Tab A reconnects, sees the current enemy state, no duplicates, no missing enemies, no console errors. Pick an enemy id from tab B's HUD-area; verify the same id exists in tab A.

If any step fails, stop and diagnose. Do not proceed to the perf test.

- [ ] **Step 3: Run the perf check**

With both tabs still connected:

**Phase 1 — 200 enemies.** Press `\` to clear, then `Shift+]` twice (200 spawned via debug, no auto-spawn lag-in). Wait 5 s for steady state. Record from the HUD (both tabs):
- Client fps (should be 60).
- Server tick rate via `serverTick` HUD line — should advance by ~20/s.

Record from the server console (the `[room ABCD] snapshot avg=... full=... enemies=N players=2` log line):
- Per-tick patch bytes (`avg=`).
- Full-state encoded bytes (`full=`).

Record from HUD: `draw calls` value. Should be a small constant (~5–8) — **unchanged from baseline**. If it grew with enemy count, instancing is broken; stop and investigate.

**Phase 2 — 300 enemies.** Press `Shift+]` once more. We hit `MAX_ENEMIES`. Wait 5 s. Record the same numbers again.

- [ ] **Step 4: Apply the stop conditions**

- If per-tick snapshot bytes > **50 KB** at 200 or 300 enemies, **stop**. Do not preemptively reach for compression / delta tricks / area-of-interest filtering. Open a discussion with the user about strategy.
- If client fps drops below 60 at 200 enemies, **stop**. Diagnose first — slot allocator? SnapshotBuffer iteration? InstancedMesh matrix update? Don't add tricks blindly.

If both stop conditions are clear, proceed to Step 5.

- [ ] **Step 5: Append the perf table to `README.md`**

After the existing "Manual smoke test (M2 sync invariants)" section in README.md, add:

```markdown

## Manual perf test (M3)

Run on YYYY-MM-DD, <hardware> (e.g. M2 MacBook Pro), 2 connected Chrome clients.

| Enemies | Client FPS | Server tick | Patch bytes/tick | Full-state bytes |
|--------:|-----------:|------------:|-----------------:|-----------------:|
| 0       | 60         | 20Hz        | <baseline>       | <baseline>       |
| 200     | <num>      | <num>       | <num>            | <num>            |
| 300     | <num>      | <num>       | <num>            | <num>            |

Notes: <observations, e.g. "no GC stutter visible in DevTools Performance tab",
"draw calls held at 6 across all enemy counts", "patch instrumentation
returned n/a — full-state proxy used">.
```

Replace every `<...>` placeholder with actual numbers from Steps 3. **Be honest** — if a number was disappointing, write it down. The discussion that follows is where we decide whether to optimize.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: README — record M3 manual perf test results

200 and 300 enemies, 2 clients. Numbers as measured.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Final sanity sweep**

Run: `pnpm typecheck && pnpm test`
Expected: all green. M3 is done.

---

## Done criteria

All of the following are true:

- [ ] All 15 tasks above committed.
- [ ] `pnpm test` passes (shared rules, schema, server integration, server reconnect, server sync).
- [ ] `pnpm typecheck` passes.
- [ ] Manual verification steps 1–6 all pass.
- [ ] Perf table in README is filled in with real numbers.
- [ ] No `Math.random` calls reachable from any gameplay-affecting code path on the client.
- [ ] CLAUDE.md rule 10 is in place.

If a stop condition triggered during Task 15, the milestone is **paused**, not done. Report the numbers and stop.
