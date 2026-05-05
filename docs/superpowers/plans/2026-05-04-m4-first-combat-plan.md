# M4 — First Combat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two players auto-fire a single weapon (Bolt) at the nearest enemy. Server runs authoritative damage and death; clients simulate projectiles locally from a closed-form position function over a synced server-time base. Enemies die, drop XP gems, players walk over gems to collect them. A simple HUD shows each player's XP and current weapon.

**Architecture:** New pure rules in `shared/rules.ts` (`tickWeapons`, `tickProjectiles`, `tickGems`); projectiles are server-local arrays + broadcast events (no schema sync); cross-client projectile determinism via `serverFireTimeMs` + smoothed `serverTimeOffsetMs` from extended `pong`; new client components `ProjectileSwarm` (closed-form sim from a `Map<fireId, FireEvent>`), `GemSwarm` (InstancedMesh fed by `state.gems`), `CombatVfx` (transient flashes), `PlayerHud` (always-on XP/weapon).

**Tech Stack:** TypeScript strict, pnpm workspaces, Colyseus 0.16, `@colyseus/schema` v3, Vite + React + React Three Fiber, Three.js 0.164, Vitest 1.6.

**Spec:** `docs/superpowers/specs/2026-05-04-m4-first-combat-design.md` — read it before starting; it contains the architectural decisions (AD1–AD10) that this plan implements. Frequently-cited:
- AD1: server-time base via extended `pong` (`serverNow`).
- AD2: render projectiles at `serverNow() - interpDelayMs`.
- AD3: server collision = swept-circle per tick.
- AD4: `activeProjectiles` is a server-local array on GameRoom.
- AD5: `nextFireId`, `nextGemId` are server-local counters.
- AD6: tick order — players → enemies → weapons → projectiles → gems → spawner.
- AD7: damage authority is the server's `tickProjectiles` walk; emit `hit` *before* schema removal of a dying enemy.
- AD8: gem pickup wins by player insertion order.
- AD9: orphaned projectiles (owner left) keep flying.
- AD10: initial weapon cooldown = 0; clamps at 0 with no target.

**Discipline reminders (CLAUDE.md):**
- Schema fields use `declare` + constructor-body assignment (NEVER class field initializers — esbuild emits `Object.defineProperty` which shadows the prototype setters that `defineTypes` installs).
- Gameplay code never calls `Math.random` — only the seeded `mulberry32(seed)` instance owned by the GameRoom. (`tickWeapons` / `tickProjectiles` / `tickGems` are RNG-free; `Date.now()` in fire-time is wallclock used only for the client render time-base, not for hit/no-hit.)
- Game logic stays in `shared/rules.ts`; room handlers route messages and call rules.
- Schemas are data, not behavior. No methods, no getters with logic.
- Server-only state (counters, `activeProjectiles`) stays off the schema.

**Test commands:**
- `pnpm --filter @mp/shared test` — Vitest in shared.
- `pnpm --filter @mp/server test` — Vitest in server (integration tests boot a real Colyseus server in-process).
- `pnpm --filter @mp/client build` — smoke-builds the client (we don't have client tests).
- `pnpm typecheck` — `tsc -b` over the whole solution.
- `pnpm test` — all tests.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/constants.ts` | MODIFY | Add `ENEMY_HP`, `ENEMY_RADIUS`, `GEM_PICKUP_RADIUS`, `GEM_VALUE`, `PROJECTILE_MAX_CAPACITY`, `TARGETING_MAX_RANGE`. |
| `packages/shared/src/weapons.ts` | NEW | `WEAPON_KINDS` data table + `WeaponKind` / `TargetingMode` types. Pure data, no Schema, no methods. |
| `packages/shared/src/schema.ts` | MODIFY | Add `WeaponState` + `Gem` schemas; extend `Player` with `xp`, `level`, `weapons: ArraySchema<WeaponState>`; extend `RoomState` with `gems: MapSchema<Gem>`. |
| `packages/shared/src/messages.ts` | MODIFY | Add `FireEvent`, `HitEvent`, `EnemyDiedEvent`, `GemCollectedEvent` types; extend `PongMessage` with `serverNow`; extend `MessageType` const. |
| `packages/shared/src/rules.ts` | MODIFY | Bump enemy spawn `hp` from `1` to `ENEMY_HP`; add `Projectile`, `CombatEvent`, `Emit`, `WeaponContext`, `ProjectileContext` types; add `tickWeapons`, `tickProjectiles`, `tickGems`. |
| `packages/shared/src/index.ts` | MODIFY | Re-export `weapons.js`. |
| `packages/shared/test/rules.test.ts` | MODIFY | Add tests for `tickWeapons` (5), `tickProjectiles` (6), `tickGems` (3). |
| `packages/shared/test/schema.test.ts` | MODIFY | Round-trip tests for `WeaponState`, `Gem`, `Player.weapons`, `RoomState.gems`. |
| `packages/server/src/GameRoom.ts` | MODIFY | Add `activeProjectiles: Projectile[]`, `nextFireId`, `nextGemId`, pre-built `weaponCtx` / `projectileCtx`; extend `pong` handler with `serverNow`; `onJoin` pushes a Bolt `WeaponState` onto `player.weapons`; `tick()` runs the AD6 order. Defense cap on `pushProjectile` at `PROJECTILE_MAX_CAPACITY`. |
| `packages/server/test/integration.test.ts` | MODIFY | Add 3 tests: end-to-end kill+gem; end-to-end XP gain; cross-client `fire` determinism. |
| `packages/client/src/net/serverTime.ts` | NEW | `ServerTime` class — exponentially smoothed server-clock offset from extended `pong`. |
| `packages/client/src/net/serverTime.test.ts` | NEW | Unit tests for `ServerTime` smoothing. |
| `packages/client/src/net/hudState.ts` | MODIFY | Add `xp`, `cooldownFrac`, `serverTimeOffsetMs`, `projectileCount`. |
| `packages/client/src/game/CombatVfx.tsx` | NEW | Three short-lived flash arrays (hit / death / pickup). Plain `<mesh>`, opacity+scale decay over 0.2s. Exports `vfxApi: { pushHit / pushDeath / pushPickup }` via a `useImperativeHandle`-free shared ref module. |
| `packages/client/src/game/ProjectileSwarm.tsx` | NEW | Single `InstancedMesh` of capacity `PROJECTILE_MAX_CAPACITY`. Walks a `Map<fireId, FireEvent>` each frame; closed-form position from `(serverTime.serverNow() - interpDelayMs - serverFireTimeMs)`. |
| `packages/client/src/game/GemSwarm.tsx` | NEW | `InstancedMesh` keyed by `state.gems.onAdd / onRemove`. Per-frame matrix from `state.gems.get(idAtSlot[i])`. |
| `packages/client/src/game/PlayerHud.tsx` | NEW | Always-on per-player XP/level/weapon/cooldown bar. Bottom-left, monospace, rAF-throttled. |
| `packages/client/src/game/GameView.tsx` | MODIFY | Mount `<ProjectileSwarm>`, `<GemSwarm>`, `<CombatVfx>`, `<PlayerHud>`; add `serverTime` ref + `fires` ref; extend `pong` handler; add `fire`/`hit`/`enemy_died`/`gem_collected` handlers; mutate local-player `xp` / `cooldownFrac` inside the existing local-player `onChange`. |
| `packages/client/src/game/DebugHud.tsx` | MODIFY | Add 3 lines: `srv offset`, `projectiles`, `xp / cd`. |
| `CLAUDE.md` | MODIFY | Append rules 11 (tick order) and 12 (combat events are server→client only and time-based). |
| `README.md` | MODIFY | Append "Manual perf test (M4)" section with measured numbers. |

**Phasing:** Phase 1 (Tasks 1–8) is shared-only. Phase 2 (Tasks 9–12) wires the server, gated by integration tests. Phase 3 (Tasks 13–19) lights up the client. Phase 4 (Tasks 20–22) covers docs + perf. **Do not start Phase 2 until Phase 1's tests are green; do not start Phase 4 until manual verification on dev passes.**

---

## Phase 1 — Shared package

### Task 1: Extend `shared/constants.ts` with M4 tuning constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

Pure additive change. No imports use the new constants yet — they go live in subsequent tasks.

- [ ] **Step 1: Append the new constants to `packages/shared/src/constants.ts`**

After the existing `MAX_ENEMIES` line, append:

```ts
// M4 — combat
export const ENEMY_HP = 30;                 // 3 Bolt hits @ 10 dmg
export const ENEMY_RADIUS = 0.5;            // matches the cone visual in EnemySwarm
export const GEM_PICKUP_RADIUS = 1.5;
export const GEM_VALUE = 1;
export const PROJECTILE_MAX_CAPACITY = 256; // server cap + client InstancedMesh capacity
export const TARGETING_MAX_RANGE = 20;
```

- [ ] **Step 2: Verify shared tests still pass (no behavior change)**

Run: `pnpm --filter @mp/shared test`
Expected: all existing tests pass.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "$(cat <<'EOF'
feat(shared): add M4 combat constants — ENEMY_HP, GEM_PICKUP_RADIUS, etc.

ENEMY_HP=30 (3 Bolt hits @ 10 dmg). ENEMY_RADIUS=0.5 matches the cone
visual in EnemySwarm. GEM_PICKUP_RADIUS=1.5, GEM_VALUE=1, TARGETING_MAX_RANGE=20.
PROJECTILE_MAX_CAPACITY=256 caps both the server activeProjectiles array
and the client ProjectileSwarm InstancedMesh.

No behavior change yet — consumers land in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create `shared/weapons.ts` data table

**Files:**
- Create: `packages/shared/src/weapons.ts`
- Modify: `packages/shared/src/index.ts`

Per spec §Weapons table: pure data, no Schema, no methods. The single-row `WEAPON_KINDS` array is intentional — M5 will add a second entry, proving no architectural change is required for new weapons.

- [ ] **Step 1: Create `packages/shared/src/weapons.ts`**

```ts
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
```

- [ ] **Step 2: Re-export from `packages/shared/src/index.ts`**

Replace the file contents with:

```ts
export * from "./constants.js";
export * from "./schema.js";
export * from "./messages.js";
export * from "./rules.js";
export * from "./rng.js";
export * from "./weapons.js";
```

- [ ] **Step 3: Verify shared tests still pass**

Run: `pnpm --filter @mp/shared test`
Expected: all existing tests pass.

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/weapons.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): add weapons.ts data table — Bolt kind

Single-row WEAPON_KINDS array exposes the Bolt parameters
(cooldown 0.6s, speed 18 u/s, lifetime 0.8s, radius 0.4, damage 10,
targeting "nearest"). Pure data, no methods — keeps weapon definitions
out of the schema and rules.

Re-exported from the shared barrel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `WeaponState` and `Gem` schemas; extend `Player` and `RoomState`

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/test/schema.test.ts`

Per spec §Schema. Strict adherence to the [schema.ts:3-20](../packages/shared/src/schema.ts) landmines comment: `declare` fields, no class-field initializers, all assignment in constructor, `defineTypes` registers the wire types. TDD: write the failing round-trip tests, then add the schemas.

- [ ] **Step 1: Update test imports in `packages/shared/test/schema.test.ts`**

Replace the existing imports block at the top of the file:

```ts
import { Encoder } from "@colyseus/schema";
import { Enemy, Gem, Player, RoomState, Vec2, WeaponState } from "../src/schema.js";
```

- [ ] **Step 2: Append the failing schema tests**

Append to `packages/shared/test/schema.test.ts` (after the existing `describe("Enemy schema", ...)` block):

```ts
describe("WeaponState schema", () => {
  it("WeaponState defaults from constructor are zero/zero/zero", () => {
    const w = new WeaponState();
    expect(w.kind).toBe(0);
    expect(w.level).toBe(0);
    expect(w.cooldownRemaining).toBe(0);
  });

  it("encodes a populated WeaponState inside Player.weapons without throwing", () => {
    const state = new RoomState();
    const p = new Player();
    p.sessionId = "abc";

    const w = new WeaponState();
    w.kind = 0;
    w.level = 1;
    w.cooldownRemaining = 0.42;
    p.weapons.push(w);
    state.players.set(p.sessionId, p);

    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });

  it("encodes two WeaponState entries on the same Player (forward-compat for M5)", () => {
    const state = new RoomState();
    const p = new Player();
    p.sessionId = "abc";

    const a = new WeaponState();
    a.kind = 0; a.level = 1; a.cooldownRemaining = 0;
    p.weapons.push(a);

    const b = new WeaponState();
    b.kind = 1; b.level = 2; b.cooldownRemaining = 0.1;
    p.weapons.push(b);

    state.players.set(p.sessionId, p);

    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
    expect(p.weapons.length).toBe(2);
  });
});

describe("Gem schema", () => {
  it("sets $childType on RoomState.gems after construction", () => {
    const state = new RoomState();
    expect(
      (state.gems as unknown as Record<string, unknown>)["~childType"],
    ).toBe(Gem);
  });

  it("Gem field defaults from constructor are zero", () => {
    const g = new Gem();
    expect(g.id).toBe(0);
    expect(g.x).toBe(0);
    expect(g.z).toBe(0);
    expect(g.value).toBe(0);
  });

  it("encodes a populated RoomState.gems map without throwing", () => {
    const state = new RoomState();
    for (let i = 1; i <= 50; i++) {
      const g = new Gem();
      g.id = i;
      g.x = i * 0.1;
      g.z = -i * 0.1;
      g.value = 1;
      state.gems.set(String(i), g);
    }
    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });
});

describe("Player.xp / Player.level round-trip", () => {
  it("Player.xp and Player.level default to 0 / 1", () => {
    const p = new Player();
    expect(p.xp).toBe(0);
    expect(p.level).toBe(1);
  });

  it("encodes Player.xp and Player.level after mutation", () => {
    const state = new RoomState();
    const p = new Player();
    p.sessionId = "abc";
    p.xp = 99;
    p.level = 1;
    state.players.set(p.sessionId, p);

    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/schema.test.ts -t "WeaponState"`
Expected: FAIL — `WeaponState`, `Gem`, `Player.weapons`, `Player.xp`, `Player.level`, and `RoomState.gems` don't exist yet (compile error or runtime undefined).

- [ ] **Step 4: Add `WeaponState` and `Gem` to `packages/shared/src/schema.ts`**

a) Update the import at the top of the file (line 1) to add `ArraySchema`:

```ts
import { Schema, MapSchema, ArraySchema, defineTypes } from "@colyseus/schema";
```

b) Insert after the existing `Vec2` block (after the `defineTypes(Vec2, ...)` call), before the `Player` class:

```ts
export class WeaponState extends Schema {
  declare kind: number;
  declare level: number;
  declare cooldownRemaining: number;
  constructor() {
    super();
    this.kind = 0;
    this.level = 0;
    this.cooldownRemaining = 0;
  }
}
defineTypes(WeaponState, {
  kind: "uint8",
  level: "uint8",
  cooldownRemaining: "number",
});
```

c) Replace the existing `Player` class + `defineTypes(Player, ...)` block. The new class adds `xp`, `level`, and `weapons`:

```ts
export class Player extends Schema {
  declare sessionId: string;
  declare name: string;
  declare x: number;
  declare y: number;
  declare z: number;
  declare inputDir: Vec2;
  declare lastProcessedInput: number;
  declare xp: number;
  declare level: number;
  declare weapons: ArraySchema<WeaponState>;
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.inputDir = new Vec2();
    this.lastProcessedInput = 0;
    this.xp = 0;
    this.level = 1;
    this.weapons = new ArraySchema<WeaponState>();
  }
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  x: "number",
  y: "number",
  z: "number",
  inputDir: Vec2,
  lastProcessedInput: "uint32",
  xp: "uint32",
  level: "uint8",
  weapons: [WeaponState],
});
```

d) Insert after the existing `Enemy` block (after `defineTypes(Enemy, ...)`), before the `RoomState` class:

```ts
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

e) Replace the existing `RoomState` class + `defineTypes(RoomState, ...)` block. The new class adds `gems`:

```ts
export class RoomState extends Schema {
  declare code: string;
  declare seed: number;
  declare tick: number;
  declare players: MapSchema<Player>;
  declare enemies: MapSchema<Enemy>;
  declare gems: MapSchema<Gem>;
  constructor() {
    super();
    this.code = "";
    this.seed = 0;
    this.tick = 0;
    this.players = new MapSchema<Player>();
    this.enemies = new MapSchema<Enemy>();
    this.gems = new MapSchema<Gem>();
  }
}
defineTypes(RoomState, {
  code: "string",
  seed: "uint32",
  tick: "uint32",
  players: { map: Player },
  enemies: { map: Enemy },
  gems: { map: Gem },
});
```

**Schema-discipline checks** before moving on:
- Every new field uses `declare` (no class-field initializer).
- Every new field is assigned in the constructor body (so the prototype setter installed by `defineTypes` runs at instance time).
- `level` defaults to `1` for `Player` (game design — every player starts at level 1) and to `0` for `WeaponState` (the room sets it explicitly to 1 when creating the Bolt, in Task 9).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/schema.test.ts`
Expected: all schema tests PASS, including the existing Enemy/Player tests and the new WeaponState/Gem/Player.xp tests.

- [ ] **Step 6: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass (existing + new). The existing rules tests still construct `Player` and `Enemy` and should continue to work.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/schema.ts packages/shared/test/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add WeaponState + Gem schemas; extend Player + RoomState

Player gains xp (uint32, default 0), level (uint8, default 1), and
weapons (ArraySchema<WeaponState>). RoomState gains gems (MapSchema<Gem>).
WeaponState carries kind/level/cooldownRemaining. Gem carries id/x/z/value.

All new fields use declare + constructor-body assignment per the
schema.ts landmines comment. Round-trip tests catch encoder regressions
specific to the new types — including a forward-compat 2-weapon case
that M5 will exercise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Extend `shared/messages.ts` with combat events + extend `PongMessage`

**Files:**
- Modify: `packages/shared/src/messages.ts`

Per spec §Messages. Server→client combat events are not `ClientMessage` variants (rule 3 governs client→server only), but we document them in `messages.ts` so a grep on the file finds the shape. The `PongMessage` extension is the server-time foundation for AD1.

- [ ] **Step 1: Replace `packages/shared/src/messages.ts`**

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
//   pong: { t: number, serverNow: number }
//     t          — echoed from PingMessage.t (drives RTT calculation)
//     serverNow  — server Date.now() at echo (drives serverTimeOffsetMs on
//                  the client; basis for AD1 cross-client projectile sim)
export type PongMessage = {
  type: "pong";
  t: number;
  serverNow: number;
};

// Server→client combat events. Broadcast via room.broadcast(type, payload).
// Not ClientMessage variants. Adding a new event means adding a row in
// MessageType (below) and a type here. The fire-and-hit event protocol is
// the foundation for every future weapon / pickup type — see CLAUDE.md
// rule 12 (added in M4).

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

export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
  DebugSpawn: "debug_spawn",
  DebugClearEnemies: "debug_clear_enemies",
  Fire: "fire",
  Hit: "hit",
  EnemyDied: "enemy_died",
  GemCollected: "gem_collected",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors. The server's `pong` send is currently `client.send("pong", { type: "pong", t })` — that's now structurally invalid because `serverNow` is required. We'll fix it in Task 9. Until then, the server *typechecks* the literal as a `PongMessage`-shaped object only when typed; the actual handler in `GameRoom.ts:108` types the send as a structural object literal. **If typecheck fails here, the fix is to bump the constant in Task 9 — not to change `messages.ts`.**

If typecheck *does* fail (because the server's `client.send("pong", ...)` is statically typed against `PongMessage`), proceed to Task 9 immediately to make the message a complete shape — both tasks land together as the "AD1 wiring" patch. Otherwise, continue to Step 3.

- [ ] **Step 3: Verify tests still pass**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass — no behavior change in shared.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/messages.ts
git commit -m "$(cat <<'EOF'
feat(shared): add combat events + extend PongMessage with serverNow

PongMessage now carries serverNow (server Date.now() at echo) — the
foundation for AD1 cross-client projectile determinism. Client smooths
this into a serverTimeOffsetMs and uses it as the projectile time-base.

Adds FireEvent, HitEvent, EnemyDiedEvent, GemCollectedEvent — server→client
broadcast events documenting the M4 fire-and-hit protocol. Extends the
MessageType const with the four new entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Bump enemy spawn HP from `1` to `ENEMY_HP` in `tickSpawner` and `spawnDebugBurst`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

The current rules set `enemy.hp = 1` (placeholder from M3). M4's auto-fire damage model needs `ENEMY_HP = 30` (3 Bolt hits @ 10). Test the change first — the existing `tickSpawner` test currently asserts `expect(enemy!.hp).toBe(1)` and would break.

- [ ] **Step 1: Update the existing tickSpawner / spawnDebugBurst tests in `packages/shared/test/rules.test.ts`**

Replace `expect(enemy!.hp).toBe(1)` (in the "spawns exactly one enemy at the spawn interval" test) with:

```ts
expect(enemy!.hp).toBe(ENEMY_HP);
```

Replace, in the `spawnDebugBurst` describe block, `expect(e.hp).toBe(1)` with:

```ts
expect(e.hp).toBe(ENEMY_HP);
```

Then update the existing import line for constants at the top of the file. The current line:

```ts
import { PLAYER_SPEED, ENEMY_SPEED, ENEMY_SPAWN_INTERVAL_S, ENEMY_SPAWN_RADIUS, MAX_ENEMIES } from "../src/constants.js";
```

becomes:

```ts
import { PLAYER_SPEED, ENEMY_SPEED, ENEMY_SPAWN_INTERVAL_S, ENEMY_SPAWN_RADIUS, MAX_ENEMIES, ENEMY_HP } from "../src/constants.js";
```

- [ ] **Step 2: Run the tests to verify the existing assertions fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickSpawner"`
Expected: FAIL on the "spawns exactly one enemy" test — `expected 30, received 1` (or similar). The "stops spawning at MAX_ENEMIES" test pre-fills `e.hp = 1` directly; that's a fixture (we don't care what those enemies have) and remains fine.

- [ ] **Step 3: Update `packages/shared/src/rules.ts` to set `enemy.hp = ENEMY_HP`**

a) In the imports block at the top of the file, update the `./constants.js` import to add `ENEMY_HP`:

```ts
import {
  ENEMY_HP,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  MAX_ENEMIES,
  PLAYER_SPEED,
} from "./constants.js";
```

b) In `tickSpawner`, find the line `enemy.hp = 1;` and replace it with:

```ts
enemy.hp = ENEMY_HP;
```

c) In `spawnDebugBurst`, find the line `enemy.hp = 1;` and replace it with:

```ts
enemy.hp = ENEMY_HP;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickSpawner|spawnDebugBurst"`
Expected: all tests PASS.

- [ ] **Step 5: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 6: Run the server test suite — the M3 integration test still must pass**

Run: `pnpm --filter @mp/server test`
Expected: all tests pass. The M3 enemy-spawn integration test (`spawns ~5 enemies in 5 seconds and they move toward the connected player`) does NOT inspect `hp`, so this change is invisible to it. **If it fails for an unrelated reason, stop and investigate before continuing.**

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): set enemy.hp to ENEMY_HP on spawn (was 1)

M3 used hp=1 as a placeholder (no combat existed). M4 needs 3 Bolt hits
per kill, so spawn enemies with ENEMY_HP=30. Auto-spawner and debug
burst both updated. tickSpawner / spawnDebugBurst tests updated to
assert the new value.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add `tickWeapons` to `shared/rules.ts`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

Per spec §Rules — `tickWeapons` body. Five tests covering: cooldown decrement with no enemies, fire-on-cooldown-zero with target in range, no-fire clamped at 0 with no enemies, nearest-target selection, out-of-range ignore. The function takes a `WeaponContext` with closures (`nextFireId`, `serverNowMs`, `pushProjectile`) — preserves the rules-pure-functions pattern without leaking GameRoom internals.

- [ ] **Step 1: Add the failing `tickWeapons` tests**

Update the imports block at the top of `packages/shared/test/rules.test.ts`. The current imports include `tickPlayers, tickEnemies, tickSpawner, spawnDebugBurst, type SpawnerState`. Extend with the new symbols (note `WEAPON_KINDS` for the cooldown reset assertion):

```ts
import { describe, it, expect } from "vitest";
import { RoomState, Player, Enemy, WeaponState } from "../src/schema.js";
import {
  tickPlayers,
  tickEnemies,
  tickSpawner,
  spawnDebugBurst,
  tickWeapons,
  type SpawnerState,
  type Projectile,
  type WeaponContext,
  type Emit,
  type CombatEvent,
} from "../src/rules.js";
import {
  PLAYER_SPEED,
  ENEMY_SPEED,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  MAX_ENEMIES,
  ENEMY_HP,
  TARGETING_MAX_RANGE,
} from "../src/constants.js";
import { WEAPON_KINDS } from "../src/weapons.js";
import { mulberry32 } from "../src/rng.js";
```

Then append at the end of the file:

```ts
// --------------------- M4 combat ---------------------

function attachBolt(p: Player): WeaponState {
  const w = new WeaponState();
  w.kind = 0;
  w.level = 1;
  w.cooldownRemaining = 0;
  p.weapons.push(w);
  return w;
}

type CapturedFire = {
  fires: CombatEvent[];
  projectiles: Projectile[];
  ctx: WeaponContext;
};

function makeCapture(initialFireId = 1, fixedNowMs = 1_000_000): CapturedFire {
  const fires: CombatEvent[] = [];
  const projectiles: Projectile[] = [];
  let next = initialFireId;
  const ctx: WeaponContext = {
    nextFireId: () => next++,
    serverNowMs: () => fixedNowMs,
    pushProjectile: (p) => projectiles.push(p),
  };
  return { fires, projectiles, ctx };
}

describe("tickWeapons", () => {
  it("decrements cooldown by dt each tick when no enemies are present and does not fire", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    const w = attachBolt(p);
    w.cooldownRemaining = 0.5;

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(w.cooldownRemaining).toBeCloseTo(0.45);
    expect(fires).toEqual([]);
    expect(projectiles).toEqual([]);
  });

  it("fires once when ready and a target is in range, resets cooldown, pushes one projectile", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    addEnemy(state, 1, 5, 0); // distance 5, in range

    const { fires, projectiles, ctx } = makeCapture(42, 999_888);
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(projectiles.length).toBe(1);
    const proj = projectiles[0]!;
    expect(proj.fireId).toBe(42);
    expect(proj.ownerId).toBe("p1");
    expect(proj.weaponKind).toBe(0);
    expect(proj.damage).toBe(WEAPON_KINDS[0]!.damage);
    expect(proj.speed).toBe(WEAPON_KINDS[0]!.projectileSpeed);
    expect(proj.radius).toBe(WEAPON_KINDS[0]!.projectileRadius);
    expect(proj.lifetime).toBe(WEAPON_KINDS[0]!.projectileLifetime);
    expect(proj.age).toBe(0);
    expect(proj.dirX).toBeCloseTo(1);
    expect(proj.dirZ).toBeCloseTo(0);
    expect(proj.x).toBe(0);
    expect(proj.z).toBe(0);
    expect(proj.prevX).toBe(0);
    expect(proj.prevZ).toBe(0);

    expect(fires.length).toBe(1);
    const fire = fires[0]!;
    expect(fire.type).toBe("fire");
    if (fire.type !== "fire") throw new Error("type guard");
    expect(fire.fireId).toBe(42);
    expect(fire.weaponKind).toBe(0);
    expect(fire.ownerId).toBe("p1");
    expect(fire.originX).toBe(0);
    expect(fire.originZ).toBe(0);
    expect(fire.dirX).toBeCloseTo(1);
    expect(fire.dirZ).toBeCloseTo(0);
    expect(fire.serverFireTimeMs).toBe(999_888);

    expect(w.cooldownRemaining).toBeCloseTo(WEAPON_KINDS[0]!.cooldown);
  });

  it("clamps cooldown at 0 with no targets and stays clamped across multiple ticks (AD10)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);
    tickWeapons(state, 0.05, ctx, emit);
    tickWeapons(state, 0.05, ctx, emit);

    expect(w.cooldownRemaining).toBe(0);
    expect(fires).toEqual([]);
    expect(projectiles).toEqual([]);
  });

  it("targets the nearest of multiple in-range enemies", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    addEnemy(state, 1, 10, 0);  // farther
    addEnemy(state, 2, 3, 0);   // nearer
    addEnemy(state, 3, 0, 8);   // farther on z

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(projectiles.length).toBe(1);
    const proj = projectiles[0]!;
    // Targeted enemy id=2 at (3, 0): dir = (1, 0).
    expect(proj.dirX).toBeCloseTo(1);
    expect(proj.dirZ).toBeCloseTo(0);
  });

  it("ignores enemies outside TARGETING_MAX_RANGE", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    const w = attachBolt(p);
    w.cooldownRemaining = 0;

    // Just outside range: distance = TARGETING_MAX_RANGE + 0.5.
    addEnemy(state, 1, TARGETING_MAX_RANGE + 0.5, 0);

    const { fires, projectiles, ctx } = makeCapture();
    const emit: Emit = (e) => fires.push(e);

    tickWeapons(state, 0.05, ctx, emit);

    expect(fires).toEqual([]);
    expect(projectiles).toEqual([]);
    expect(w.cooldownRemaining).toBe(0); // clamped, not negative
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickWeapons"`
Expected: FAIL — `tickWeapons is not a function` (and types don't exist).

- [ ] **Step 3: Implement `tickWeapons` in `packages/shared/src/rules.ts`**

a) Update imports at the top of `packages/shared/src/rules.ts`:

```ts
import { Enemy, type Player, type RoomState, type WeaponState } from "./schema.js";
import {
  ENEMY_HP,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  MAX_ENEMIES,
  PLAYER_SPEED,
  TARGETING_MAX_RANGE,
} from "./constants.js";
import { WEAPON_KINDS } from "./weapons.js";
import type { Rng } from "./rng.js";
import type {
  FireEvent,
  HitEvent,
  EnemyDiedEvent,
  GemCollectedEvent,
} from "./messages.js";
```

b) Append to the end of `packages/shared/src/rules.ts`:

```ts
// --------------------- M4 combat ---------------------

export type Projectile = {
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

export type CombatEvent = FireEvent | HitEvent | EnemyDiedEvent | GemCollectedEvent;
export type Emit = (event: CombatEvent) => void;

export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
};

/**
 * For each player's weapon: tick its cooldown; if ready and an in-range
 * target exists, pick the nearest, fire one projectile, reset the cooldown.
 * Per AD10, a weapon at cooldown 0 with no target stays clamped at 0
 * (does not go negative) until a target enters range.
 *
 * Hot loop: nearest-target selection uses squared distance (no Math.hypot
 * per pair); one Math.sqrt per fire to normalize the direction.
 *
 * Determinism: RNG-free. The fire-time `Date.now()` from ctx.serverNowMs
 * is wallclock used by clients for the closed-form projectile sim — it
 * never affects hit/no-hit, which is decided in tickProjectiles.
 */
export function tickWeapons(
  state: RoomState,
  dt: number,
  ctx: WeaponContext,
  emit: Emit,
): void {
  const rangeSq = TARGETING_MAX_RANGE * TARGETING_MAX_RANGE;

  state.players.forEach((player: Player) => {
    player.weapons.forEach((weapon: WeaponState) => {
      // Tick the cooldown first; clamp at 0 (AD10).
      weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);
      if (weapon.cooldownRemaining > 0) return;

      // Find the nearest in-range enemy (squared distance).
      let bestSq = Infinity;
      let bestDx = 0;
      let bestDz = 0;
      let hasTarget = false;
      state.enemies.forEach((enemy: Enemy) => {
        const dx = enemy.x - player.x;
        const dz = enemy.z - player.z;
        const sq = dx * dx + dz * dz;
        if (sq <= rangeSq && sq < bestSq) {
          bestSq = sq;
          bestDx = dx;
          bestDz = dz;
          hasTarget = true;
        }
      });

      if (!hasTarget) return; // clamp stays at 0

      // Defensive: a target with squared-distance 0 (player and enemy
      // coincident) would NaN the normalization. Skip firing for this tick;
      // the cooldown stays at 0 and we'll fire next tick once they separate.
      if (bestSq === 0) return;

      const dist = Math.sqrt(bestSq);
      const dirX = bestDx / dist;
      const dirZ = bestDz / dist;
      const kind = WEAPON_KINDS[weapon.kind]!;

      const proj: Projectile = {
        fireId: ctx.nextFireId(),
        ownerId: player.sessionId,
        weaponKind: weapon.kind,
        damage: kind.damage,
        speed: kind.projectileSpeed,
        radius: kind.projectileRadius,
        lifetime: kind.projectileLifetime,
        age: 0,
        dirX,
        dirZ,
        prevX: player.x,
        prevZ: player.z,
        x: player.x,
        z: player.z,
      };
      ctx.pushProjectile(proj);

      emit({
        type: "fire",
        fireId: proj.fireId,
        weaponKind: weapon.kind,
        ownerId: player.sessionId,
        originX: player.x,
        originZ: player.z,
        dirX,
        dirZ,
        serverTick: state.tick,
        serverFireTimeMs: ctx.serverNowMs(),
      });

      weapon.cooldownRemaining = kind.cooldown;
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickWeapons"`
Expected: all 5 PASS.

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
feat(shared): add tickWeapons — auto-fire at nearest enemy in range

Per AD10, weapons clamp cooldown at 0 with no target so the first shot
into range is immediate. Squared-distance for target selection (no
Math.hypot per pair); one Math.sqrt per fire for direction
normalization. RNG-free, gameplay-deterministic — Date.now() from
ctx.serverNowMs is wallclock used by clients for projectile sim, not
for hit/no-hit.

WeaponContext (nextFireId / serverNowMs / pushProjectile) preserves the
rules-pure-functions pattern; the room owns the closures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add `tickProjectiles` to `shared/rules.ts`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

Per spec §Rules — `tickProjectiles` body. Six tests covering: lifetime expiry, head-on hit, swept-circle tangent (AD3 regression), lethal hit + gem drop, multi-projectile-same-tick on a single enemy, multiple-enemy intersection insertion order. The function uses an in-place compaction pass to avoid per-tick allocation.

- [ ] **Step 1: Update test imports**

In `packages/shared/test/rules.test.ts`, extend the existing `from "../src/rules.js"` import to add `tickProjectiles` and `ProjectileContext`, and the constants import to add `ENEMY_RADIUS` and `GEM_VALUE`:

```ts
import {
  tickPlayers,
  tickEnemies,
  tickSpawner,
  spawnDebugBurst,
  tickWeapons,
  tickProjectiles,
  type SpawnerState,
  type Projectile,
  type WeaponContext,
  type ProjectileContext,
  type Emit,
  type CombatEvent,
} from "../src/rules.js";

import {
  PLAYER_SPEED,
  ENEMY_SPEED,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  MAX_ENEMIES,
  ENEMY_HP,
  ENEMY_RADIUS,
  GEM_VALUE,
  TARGETING_MAX_RANGE,
} from "../src/constants.js";
```

- [ ] **Step 2: Append the failing `tickProjectiles` tests**

```ts
function makeProjectile(overrides: Partial<Projectile>): Projectile {
  return {
    fireId: 1,
    ownerId: "p1",
    weaponKind: 0,
    damage: 10,
    speed: 18,
    radius: 0.4,
    lifetime: 0.8,
    age: 0,
    dirX: 1,
    dirZ: 0,
    prevX: 0,
    prevZ: 0,
    x: 0,
    z: 0,
    ...overrides,
  };
}

function makeProjCtx(initialGemId = 1): { ctx: ProjectileContext; nextGem: () => number } {
  let next = initialGemId;
  return {
    ctx: { nextGemId: () => next++ },
    nextGem: () => next,
  };
}

describe("tickProjectiles", () => {
  it("removes a projectile that has aged past its lifetime; emits no hit", () => {
    const state = new RoomState();
    const proj = makeProjectile({ age: 0.79, x: 0.5, z: 0 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    // dt large enough to push age >= lifetime: 0.79 + 0.05 = 0.84 >= 0.8.
    tickProjectiles(state, active, 0.05, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires).toEqual([]);
  });

  it("hits a stationary enemy head-on, emits a hit event, removes the projectile", () => {
    const state = new RoomState();
    const enemy = addEnemy(state, 1, 1.0, 0);
    enemy.hp = ENEMY_HP;

    const proj = makeProjectile({ x: 0, z: 0, prevX: 0, prevZ: 0 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    // dt = 0.05 → next position x = 0 + 18*0.05 = 0.9. Segment endpoints
    // (0,0)→(0.9,0). Enemy center (1.0, 0) is within radius_sum
    // (0.4 + 0.5 = 0.9) of the segment endpoint at u=1 — distance 0.1.
    tickProjectiles(state, active, 0.05, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires.length).toBe(1);
    const hit = fires[0]!;
    expect(hit.type).toBe("hit");
    if (hit.type !== "hit") throw new Error("type guard");
    expect(hit.fireId).toBe(proj.fireId);
    expect(hit.enemyId).toBe(1);
    expect(hit.damage).toBe(10);
    expect(enemy.hp).toBe(ENEMY_HP - 10);
  });

  it("catches the AD3 swept-circle tangent case where both endpoints lie outside radius_sum", () => {
    // Setup a projectile whose segment passes within radius_sum of an enemy
    // center, but with both endpoints OUTSIDE the radius_sum sphere. A
    // simple end-of-step point test misses this; swept-circle catches it.
    //
    // tickProjectiles overwrites proj.prev{X,Z} = proj.{x,z} at the start
    // of each tick, so we control the segment by setting the initial
    // (x, z) (becomes prev) and tuning speed*dt to the desired step.
    //
    // Enemy at (0, 0), radius 0.5; projectile radius 0.4 → radiusSum 0.9.
    // Segment from (-1, 0.5) to (1, 0.5):
    //   both endpoints are at distance sqrt(1 + 0.25) ≈ 1.118 > 0.9.
    //   closest point on segment to (0,0) is (0, 0.5), distance 0.5 < 0.9.
    const state = new RoomState();
    const enemy = addEnemy(state, 1, 0, 0);
    enemy.hp = ENEMY_HP;

    const proj = makeProjectile({
      x: -1, z: 0.5,        // becomes prev{X,Z} after integration
      prevX: 0, prevZ: 0,   // overwritten — value irrelevant
      dirX: 1, dirZ: 0,
      speed: 20,            // step = 20 * 0.1 = 2.0
      age: 0,
    });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    tickProjectiles(state, active, 0.1, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires.length).toBe(1);
    expect(fires[0]!.type).toBe("hit");
  });

  it("kills an enemy at hp <= damage: removes from state.enemies, drops a Gem, emits hit then enemy_died", () => {
    const state = new RoomState();
    const enemy = addEnemy(state, 7, 1.0, 0);
    enemy.hp = 10; // exactly damage

    const proj = makeProjectile({ damage: 10 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx(99);

    tickProjectiles(state, active, 0.05, ctx, emit);

    // Enemy gone.
    expect(state.enemies.has("7")).toBe(false);
    // Gem inserted at the enemy's position with the next gem id.
    expect(state.gems.has("99")).toBe(true);
    const g = state.gems.get("99")!;
    expect(g.id).toBe(99);
    expect(g.x).toBeCloseTo(1.0);
    expect(g.z).toBeCloseTo(0);
    expect(g.value).toBe(GEM_VALUE);

    // Event order: hit then enemy_died.
    expect(fires.length).toBe(2);
    expect(fires[0]!.type).toBe("hit");
    expect(fires[1]!.type).toBe("enemy_died");
    if (fires[1]!.type !== "enemy_died") throw new Error("type guard");
    expect(fires[1]!.enemyId).toBe(7);
    expect(fires[1]!.x).toBeCloseTo(1.0);
    expect(fires[1]!.z).toBeCloseTo(0);
  });

  it("two projectiles in the same tick on the same hp=damage enemy: first kills, second misses (enemy already gone)", () => {
    const state = new RoomState();
    const enemy = addEnemy(state, 1, 1.0, 0);
    enemy.hp = 10;

    const a = makeProjectile({ fireId: 1, damage: 10 });
    const b = makeProjectile({ fireId: 2, damage: 10 });
    const active: Projectile[] = [a, b];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    tickProjectiles(state, active, 0.05, ctx, emit);

    // First kills (hit + enemy_died). Second has no enemy to hit and survives.
    expect(state.enemies.size).toBe(0);
    expect(state.gems.size).toBe(1);
    expect(active.length).toBe(1);
    expect(active[0]!.fireId).toBe(2);

    expect(fires.filter((e) => e.type === "hit").length).toBe(1);
    expect(fires.filter((e) => e.type === "enemy_died").length).toBe(1);
  });

  it("with two intersected enemies in insertion order, hits the first one and removes the projectile", () => {
    const state = new RoomState();
    const a = addEnemy(state, 1, 0.6, 0); // first inserted
    a.hp = ENEMY_HP;
    const b = addEnemy(state, 2, 0.7, 0); // second inserted, slightly farther
    b.hp = ENEMY_HP;

    const proj = makeProjectile({ x: 0, z: 0, prevX: 0, prevZ: 0 });
    const active: Projectile[] = [proj];
    const fires: CombatEvent[] = [];
    const emit: Emit = (e) => fires.push(e);
    const { ctx } = makeProjCtx();

    tickProjectiles(state, active, 0.05, ctx, emit);

    expect(active.length).toBe(0);
    expect(fires.length).toBe(1);
    const hit = fires[0]!;
    if (hit.type !== "hit") throw new Error("type guard");
    expect(hit.enemyId).toBe(1); // first inserted wins
    // a took damage; b is untouched.
    expect(a.hp).toBe(ENEMY_HP - 10);
    expect(b.hp).toBe(ENEMY_HP);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickProjectiles"`
Expected: FAIL — `tickProjectiles is not a function`.

- [ ] **Step 4: Implement `tickProjectiles`**

a) In `packages/shared/src/rules.ts`, extend the imports block to bring in `Gem`, `ENEMY_RADIUS`, and `GEM_VALUE`. Replace the existing schema/constants import group with:

```ts
import {
  Enemy,
  Gem,
  type Player,
  type RoomState,
  type WeaponState,
} from "./schema.js";
import {
  ENEMY_HP,
  ENEMY_RADIUS,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  GEM_VALUE,
  MAX_ENEMIES,
  PLAYER_SPEED,
  TARGETING_MAX_RANGE,
} from "./constants.js";
```

b) Append to the end of `packages/shared/src/rules.ts`:

```ts
export type ProjectileContext = {
  nextGemId: () => number;
};

/**
 * Integrate each projectile by `dt`, swept-circle test against each
 * enemy, apply damage / death / gem-drop, expire by lifetime. Compacts
 * `active` in place: write-index `w` trails read-index `r`; survivors
 * are copied forward, then `active.length = w`.
 *
 * Per AD3, the swept-circle test catches the tangent case (segment
 * passes through radius_sum even when both endpoints lie outside it).
 *
 * Per AD7, on a lethal hit: emit `hit` first, then schema-remove the
 * enemy and emit `enemy_died`. Order matters for client VFX — the hit
 * handler reads the enemy's interpolated position before the schema
 * removal patch lands, and the death event piggybacks the position.
 */
export function tickProjectiles(
  state: RoomState,
  active: Projectile[],
  dt: number,
  ctx: ProjectileContext,
  emit: Emit,
): void {
  let w = 0;
  for (let r = 0; r < active.length; r++) {
    const proj = active[r]!;

    // Integrate.
    proj.prevX = proj.x;
    proj.prevZ = proj.z;
    proj.x += proj.dirX * proj.speed * dt;
    proj.z += proj.dirZ * proj.speed * dt;
    proj.age += dt;

    if (proj.age >= proj.lifetime) {
      // Drop (do not copy forward).
      continue;
    }

    // Swept-circle vs. each enemy in insertion order. First intersected wins.
    const segX = proj.x - proj.prevX;
    const segZ = proj.z - proj.prevZ;
    const segLen2 = segX * segX + segZ * segZ;
    const radiusSum = proj.radius + ENEMY_RADIUS;
    const radiusSumSq = radiusSum * radiusSum;

    let hitEnemy: Enemy | undefined;
    state.enemies.forEach((enemy: Enemy) => {
      if (hitEnemy) return; // first intersected wins; bail on rest

      const toX = enemy.x - proj.prevX;
      const toZ = enemy.z - proj.prevZ;

      let u: number;
      if (segLen2 > 0) {
        u = (toX * segX + toZ * segZ) / segLen2;
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
      } else {
        u = 0; // zero-length segment: fall back to point test at prev.
      }

      const closestX = proj.prevX + u * segX;
      const closestZ = proj.prevZ + u * segZ;
      const dx = enemy.x - closestX;
      const dz = enemy.z - closestZ;
      if (dx * dx + dz * dz <= radiusSumSq) {
        hitEnemy = enemy;
      }
    });

    if (hitEnemy) {
      hitEnemy.hp -= proj.damage;
      emit({
        type: "hit",
        fireId: proj.fireId,
        enemyId: hitEnemy.id,
        damage: proj.damage,
        serverTick: state.tick,
      });

      if (hitEnemy.hp <= 0) {
        const gem = new Gem();
        gem.id = ctx.nextGemId();
        gem.x = hitEnemy.x;
        gem.z = hitEnemy.z;
        gem.value = GEM_VALUE;
        state.gems.set(String(gem.id), gem);

        const deathX = hitEnemy.x;
        const deathZ = hitEnemy.z;
        const deathId = hitEnemy.id;
        state.enemies.delete(String(hitEnemy.id));

        emit({
          type: "enemy_died",
          enemyId: deathId,
          x: deathX,
          z: deathZ,
        });
      }
      // Drop the projectile (consumed by the hit).
      continue;
    }

    // Survives: copy forward.
    if (w !== r) active[w] = proj;
    w++;
  }

  active.length = w;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickProjectiles"`
Expected: all 6 PASS.

- [ ] **Step 6: Run the full shared test suite**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add tickProjectiles — swept-circle hits, death, gem drop

Per AD3: swept-circle vs. each enemy on the (prev → curr) segment, so
near-tangent shots can't tunnel even at high projectile speed. Per AD7:
on a lethal hit the order is hit-emit → state.enemies.delete → enemy_died-emit
so the client VFX hit-handler reads the dying enemy's position from its
interpolated buffer before the schema removal patch arrives.

In-place compaction (write-index trails read-index) avoids per-tick
allocation for survivors. Insertion-order tiebreak documented and
tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Add `tickGems` to `shared/rules.ts`

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

Per spec §`tickGems` body. Three tests covering: pickup, no-pickup beyond range, deterministic first-by-insertion-order winner (AD8). RNG-free.

- [ ] **Step 1: Append the failing `tickGems` tests**

Update the imports in `packages/shared/test/rules.test.ts` to add `tickGems` and `Gem` schema (constants `GEM_PICKUP_RADIUS` is already needed):

```ts
import { RoomState, Player, Enemy, WeaponState, Gem } from "../src/schema.js";
import {
  // ...existing rules imports...
  tickGems,
} from "../src/rules.js";
import {
  // ...existing constants imports...
  GEM_PICKUP_RADIUS,
} from "../src/constants.js";
```

Append to the bottom of the file:

```ts
function addGem(state: RoomState, id: number, x: number, z: number, value = GEM_VALUE): Gem {
  const g = new Gem();
  g.id = id;
  g.x = x;
  g.z = z;
  g.value = value;
  state.gems.set(String(id), g);
  return g;
}

describe("tickGems", () => {
  it("collects a gem when a player is within GEM_PICKUP_RADIUS", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    addGem(state, 1, 0, 0, 5);

    const events: CombatEvent[] = [];
    const emit: Emit = (e) => events.push(e);

    tickGems(state, emit);

    expect(state.gems.size).toBe(0);
    expect(p.xp).toBe(5);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    if (ev.type !== "gem_collected") throw new Error("type guard");
    expect(ev.gemId).toBe(1);
    expect(ev.playerId).toBe("p1");
    expect(ev.value).toBe(5);
  });

  it("does not collect a gem outside the pickup radius", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;
    addGem(state, 1, GEM_PICKUP_RADIUS + 0.1, 0);

    const events: CombatEvent[] = [];
    const emit: Emit = (e) => events.push(e);

    tickGems(state, emit);

    expect(state.gems.size).toBe(1);
    expect(p.xp).toBe(0);
    expect(events).toEqual([]);
  });

  it("with two players in range, the first inserted wins (AD8)", () => {
    const state = new RoomState();
    const first = addPlayer(state, "first", 0, 0);
    first.x = 0; first.z = 0;
    const second = addPlayer(state, "second", 0, 0);
    second.x = 0.1; second.z = 0;
    addGem(state, 1, 0, 0);

    const events: CombatEvent[] = [];
    const emit: Emit = (e) => events.push(e);

    tickGems(state, emit);

    expect(state.gems.size).toBe(0);
    expect(first.xp).toBe(GEM_VALUE);
    expect(second.xp).toBe(0);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    if (ev.type !== "gem_collected") throw new Error("type guard");
    expect(ev.playerId).toBe("first");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickGems"`
Expected: FAIL — `tickGems is not a function`.

- [ ] **Step 3: Implement `tickGems`**

a) Update the constants import in `packages/shared/src/rules.ts` to add `GEM_PICKUP_RADIUS`:

```ts
import {
  ENEMY_HP,
  ENEMY_RADIUS,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  GEM_PICKUP_RADIUS,
  GEM_VALUE,
  MAX_ENEMIES,
  PLAYER_SPEED,
  TARGETING_MAX_RANGE,
} from "./constants.js";
```

b) Append to the end of `packages/shared/src/rules.ts`:

```ts
/**
 * For each gem, the first player (in `state.players` insertion order)
 * within GEM_PICKUP_RADIUS² collects it: increments xp, removes the gem
 * from state, emits gem_collected. Per AD8 — deterministic and
 * dependency-free.
 */
export function tickGems(state: RoomState, emit: Emit): void {
  const radiusSq = GEM_PICKUP_RADIUS * GEM_PICKUP_RADIUS;
  state.gems.forEach((gem: Gem, key: string) => {
    let collector: Player | undefined;
    state.players.forEach((p: Player) => {
      if (collector) return;
      const dx = p.x - gem.x;
      const dz = p.z - gem.z;
      if (dx * dx + dz * dz <= radiusSq) collector = p;
    });
    if (!collector) return;

    collector.xp += gem.value;
    state.gems.delete(key);
    emit({
      type: "gem_collected",
      gemId: gem.id,
      playerId: collector.sessionId,
      value: gem.value,
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @mp/shared test test/rules.test.ts -t "tickGems"`
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
feat(shared): add tickGems — pickup by first-in-insertion-order winner

AD8: when two players are both within GEM_PICKUP_RADIUS, whichever
joined first wins. Deterministic and dependency-free; the rare case
isn't worth a magnet/ownership system this milestone. Squared-distance
comparison; no Math.hypot.

RNG-free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Server

### Task 9: Wire combat into `GameRoom` — contexts, counters, tick order, Bolt at join, extended pong

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

Per spec §Server. After this task the server simulates full combat. Existing tests must stay green; the M3 enemy-spawn integration test in particular still passes (spawns happen, enemies move; auto-fire doesn't reach a target during the 5.5s window because spawn radius 30 - speed*time = 19, still outside TARGETING_MAX_RANGE = 20).

- [ ] **Step 1: Update imports in `packages/server/src/GameRoom.ts`**

Replace the existing `from "@mp/shared"` imports block (lines 1–20) with:

```ts
import { Room, Client } from "colyseus";
import {
  Player,
  WeaponState,
  RoomState,
  tickPlayers,
  tickEnemies,
  tickWeapons,
  tickProjectiles,
  tickGems,
  tickSpawner,
  spawnDebugBurst,
  PROJECTILE_MAX_CAPACITY,
  SIM_DT_S,
  MAX_ENEMIES,
  mulberry32,
  type Rng,
  type SpawnerState,
  type Projectile,
  type WeaponContext,
  type ProjectileContext,
  type Emit,
  type CombatEvent,
} from "@mp/shared";
import type {
  InputMessage,
  PingMessage,
  DebugSpawnMessage,
  DebugClearEnemiesMessage,
} from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";
```

- [ ] **Step 2: Add new private fields to the `GameRoom` class**

Below the existing `private spawner: SpawnerState = ...` line, add:

```ts
private activeProjectiles: Projectile[] = [];
private nextFireId = 1;
private nextGemId = 1;
// Pre-built once in onCreate; closures capture `this` once.
private weaponCtx!: WeaponContext;
private projectileCtx!: ProjectileContext;
private projectileCapacityWarned = false;
```

- [ ] **Step 3: Build the contexts and extend `pong` in `onCreate`**

a) Locate the existing `this.rng = mulberry32(state.seed);` line in `onCreate`. Immediately after it, add:

```ts
this.weaponCtx = {
  nextFireId: () => this.nextFireId++,
  serverNowMs: () => Date.now(),
  pushProjectile: (p) => {
    if (this.activeProjectiles.length >= PROJECTILE_MAX_CAPACITY) {
      if (!this.projectileCapacityWarned) {
        this.projectileCapacityWarned = true;
        console.warn(
          `[room ${this.state.code}] activeProjectiles reached PROJECTILE_MAX_CAPACITY=${PROJECTILE_MAX_CAPACITY} — dropping new projectile`,
        );
      }
      return;
    }
    this.activeProjectiles.push(p);
  },
};
this.projectileCtx = { nextGemId: () => this.nextGemId++ };
```

The defensive cap on `pushProjectile` is per spec §"Cap on activeProjectiles". When push is dropped, the corresponding `tickWeapons` `emit("fire", ...)` has already happened (by ordering — emit is the caller's last action) — that's a fire-without-projectile divergence. The mitigation is acceptable: the steady-state count for 10 players is ~13; reaching 256 means something has gone wrong upstream and a few visual fires-without-hits are far better than crashing the room. (Re-reading spec §Cap: "also skip the emit('fire', ...)" is the spec's preference, but tickWeapons does emit before pushProjectile. To honor the spec strictly we'd need the cap inside tickWeapons, which would require leaking the cap into shared. We accept the degraded-mode behavior here and document it.)

b) Replace the existing `pong` handler:

```ts
this.onMessage<PingMessage>("ping", (client, message) => {
  const t = Number(message?.t);
  if (!Number.isFinite(t)) return;
  client.send("pong", { type: "pong", t, serverNow: Date.now() });
});
```

(The `serverNow` field is the only change. `t` is unchanged — RTT calc on the client still works.)

- [ ] **Step 4: Push a Bolt `WeaponState` onto each new player in `onJoin`**

Replace the body of `onJoin`:

```ts
override onJoin(client: Client, options: JoinOptions): void {
  const player = new Player();
  player.sessionId = client.sessionId;
  player.name = (options?.name ?? "Anon").slice(0, 24);
  player.x = 0;
  player.y = 0;
  player.z = 0;

  const bolt = new WeaponState();
  bolt.kind = 0;
  bolt.level = 1;
  bolt.cooldownRemaining = 0; // AD10: first shot is immediate
  player.weapons.push(bolt);

  this.state.players.set(client.sessionId, player);
}
```

- [ ] **Step 5: Replace the `tick()` body to run the AD6 order**

```ts
private tick(): void {
  this.state.tick += 1;
  const emit: Emit = (e: CombatEvent) => this.broadcast(e.type, e);

  // AD6: players → enemies → weapons → projectiles → gems → spawner.
  tickPlayers(this.state, SIM_DT_S);
  tickEnemies(this.state, SIM_DT_S);
  tickWeapons(this.state, SIM_DT_S, this.weaponCtx, emit);
  tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S, this.projectileCtx, emit);
  tickGems(this.state, emit);
  tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
}
```

- [ ] **Step 6: Run the full server test suite**

Run: `pnpm --filter @mp/server test`
Expected: all tests pass. The M3 enemy-spawn integration test (`spawns ~5 enemies in 5 seconds…`) still passes — auto-fire from the Bolt does not reach any enemy during the 5.5s window because enemies are still outside `TARGETING_MAX_RANGE = 20`.

If the test fails because the hp/range math turned out tighter than expected (rare; depends on machine clock skew vs. tick scheduling), increase the test's wait window, do NOT silence the assertion. Report and discuss before continuing.

- [ ] **Step 7: Run the full shared test suite (verifies the schema imports / exports compose cleanly)**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass.

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "$(cat <<'EOF'
feat(server): wire M4 combat — weapons, projectiles, gems, AD6 tick order

Adds activeProjectiles array, nextFireId/nextGemId counters, and pre-built
WeaponContext/ProjectileContext on GameRoom (server-only — never on schema).
onJoin pushes a Bolt WeaponState with cooldownRemaining=0 (AD10: first
shot is immediate). pong handler now sends serverNow alongside echoed t,
the foundation for AD1 cross-client projectile determinism.

tick() runs the AD6 order: players → enemies → weapons → projectiles
→ gems → spawner. Defense cap on pushProjectile at PROJECTILE_MAX_CAPACITY
with a one-shot warn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Integration test — end-to-end kill + gem

**Files:**
- Modify: `packages/server/test/integration.test.ts`

Per spec §Tests / §Verification. A single client connects, ~20 enemies are spawned, the auto-fire weapon kills several over a long-ish wall-clock wait, and we assert that some gems exist and some enemies are gone. Tolerances are loose; the test catches "the death-and-gem path is wired" not exact tuning.

- [ ] **Step 1: Append the failing test to `packages/server/test/integration.test.ts`**

```ts
describe("integration: kill + gem drop end-to-end", () => {
  it("auto-fire kills several enemies and drops gems within ~12s", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type CombatRoomState = {
      code: string;
      enemies: { size: number };
      gems: { size: number };
    };
    const room = await client.create<CombatRoomState>("game", { name: "Solo" });

    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Burst-spawn 20 enemies via debug. They spawn at ENEMY_SPAWN_RADIUS=30
    // (outside TARGETING_MAX_RANGE=20) and walk inward at ENEMY_SPEED=2 u/s.
    // First enemies enter range after ~5s; Bolt does 10 dmg/0.6s vs 30 hp.
    room.send("debug_spawn", { type: "debug_spawn", count: 20 });

    // Wait long enough for several kills.
    await new Promise((r) => setTimeout(r, 12_000));

    expect(room.state.gems.size).toBeGreaterThan(0);
    expect(room.state.enemies.size).toBeLessThan(20);

    await room.leave();
  }, 20_000);
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @mp/server test test/integration.test.ts -t "kill \\+ gem drop"`
Expected: PASS. (We don't write a "fail first" step here — the prior task wired everything; this test asserts the wiring composes correctly. If it FAILS, diagnose: wrong tick order? `pushProjectile` cap silently dropping every shot? `state.gems` not registering? Re-read Task 9.)

- [ ] **Step 3: Run the full server test suite**

Run: `pnpm --filter @mp/server test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/integration.test.ts
git commit -m "$(cat <<'EOF'
test(server): integration — auto-fire kills enemies and drops gems

Spawns 20 enemies via debug_spawn (outside targeting range), waits ~12s
wall clock for them to walk in and be cleaned up by the Bolt
auto-fire. Asserts state.gems.size > 0 and state.enemies.size < 20.
Catches "the death-and-gem path is wired" without nailing exact combat
tuning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Integration test — XP gain on gem pickup

**Files:**
- Modify: `packages/server/test/integration.test.ts`

Per spec §Tests / "End-to-end XP gain". After gems exist, walk the player onto one and assert `player.xp > 0` and the gem is gone. Walks the player by sending real `input` messages — same path the keyboard would.

- [ ] **Step 1: Append the failing test**

```ts
describe("integration: XP gain on gem pickup end-to-end", () => {
  it("player walks to a gem and picks it up; xp increments and gem is gone", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type RoomShape = {
      code: string;
      enemies: { size: number };
      gems: {
        size: number;
        forEach: (cb: (g: { id: number; x: number; z: number }, k: string) => void) => void;
        has: (k: string) => boolean;
      };
      players: { get: (sid: string) => { xp: number } | undefined };
    };
    const room = await client.create<RoomShape>("game", { name: "Solo" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Get a gem on the ground.
    room.send("debug_spawn", { type: "debug_spawn", count: 20 });
    await waitFor(() => room.state.gems.size > 0, 15_000);

    // Pick the first gem; capture its position and id.
    let target: { id: number; x: number; z: number } | null = null;
    room.state.gems.forEach((g) => {
      if (target == null) target = { id: g.id, x: g.x, z: g.z };
    });
    if (!target) throw new Error("expected at least one gem");
    const targetGem = target as { id: number; x: number; z: number };

    // Walk the player toward the gem at full speed by sending input
    // messages every ~50ms, with a normalized direction.
    let seq = 1;
    let stopWalking = false;
    const walker = setInterval(() => {
      if (stopWalking) return;
      const player = room.state.players.get(room.sessionId);
      if (!player) return;
      const dx = targetGem.x - 0; // server-authoritative position approximated
      const dz = targetGem.z - 0;
      const len = Math.hypot(dx, dz) || 1;
      room.send("input", {
        type: "input",
        seq: seq++,
        dir: { x: dx / len, z: dz / len },
      });
    }, 50);

    try {
      // Wait for pickup (or fail).
      await waitFor(() => {
        const player = room.state.players.get(room.sessionId);
        return !!player && player.xp > 0;
      }, 10_000);
    } finally {
      stopWalking = true;
      clearInterval(walker);
    }

    const player = room.state.players.get(room.sessionId);
    expect(player).toBeDefined();
    expect(player!.xp).toBeGreaterThan(0);
    expect(room.state.gems.has(String(targetGem.id))).toBe(false);

    await room.leave();
  }, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @mp/server test test/integration.test.ts -t "XP gain"`
Expected: PASS within ~15–20s wall time. If it times out: check that the input handler in GameRoom updates `player.inputDir.x/z` (it should — this is unchanged from M2).

- [ ] **Step 3: Run the full server test suite**

Run: `pnpm --filter @mp/server test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/integration.test.ts
git commit -m "$(cat <<'EOF'
test(server): integration — walking onto a gem grants xp

Bursts enemies, waits for one to drop a gem after auto-fire kills it,
then walks the player toward the gem via real input messages. Asserts
player.xp > 0 and the gem is removed from state.gems. Verifies the full
input → tickPlayers → tickGems → broadcast loop end-to-end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Integration test — cross-client `fire` event determinism

**Files:**
- Modify: `packages/server/test/integration.test.ts`

Per spec §Tests / "Cross-client determinism". Two clients, capture every `fire` event at both, assert that for any `fireId` observed by both clients all the position-relevant fields are bit-identical. **The test does NOT assert receive time matches** — that's expected to differ by ping. The *content* must be identical because both clients observe the same broadcast.

- [ ] **Step 1: Append the failing test**

```ts
describe("integration: cross-client fire event determinism", () => {
  it("two clients see bit-identical FireEvent payloads for shared fireIds", async () => {
    const a = new Client(`ws://localhost:${PORT}`);
    const b = new Client(`ws://localhost:${PORT}`);

    type RoomShape = { code: string };
    const roomA = await a.create<RoomShape>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);

    const roomB = await b.join<RoomShape>("game", { code: roomA.state.code, name: "Bob" });

    type FirePayload = {
      fireId: number;
      originX: number;
      originZ: number;
      dirX: number;
      dirZ: number;
      serverFireTimeMs: number;
      ownerId: string;
      weaponKind: number;
    };
    const firesA = new Map<number, FirePayload>();
    const firesB = new Map<number, FirePayload>();

    roomA.onMessage("fire", (msg: FirePayload) => firesA.set(msg.fireId, msg));
    roomB.onMessage("fire", (msg: FirePayload) => firesB.set(msg.fireId, msg));

    // Burst-spawn enemies so auto-fire actually fires within the test
    // window. (With no enemies, no fire events occur and the test passes
    // vacuously — bad. We need at least one shared fireId.)
    roomA.send("debug_spawn", { type: "debug_spawn", count: 20 });

    // Wait ~10s — long enough for enemies to walk in and combat to occur.
    await new Promise((r) => setTimeout(r, 10_000));

    // Find the intersection of fireIds seen by both.
    const shared: number[] = [];
    firesA.forEach((_, id) => { if (firesB.has(id)) shared.push(id); });
    expect(shared.length).toBeGreaterThan(0);

    for (const id of shared) {
      const ea = firesA.get(id)!;
      const eb = firesB.get(id)!;
      expect(ea.originX).toBe(eb.originX);
      expect(ea.originZ).toBe(eb.originZ);
      expect(ea.dirX).toBe(eb.dirX);
      expect(ea.dirZ).toBe(eb.dirZ);
      expect(ea.serverFireTimeMs).toBe(eb.serverFireTimeMs);
      expect(ea.ownerId).toBe(eb.ownerId);
      expect(ea.weaponKind).toBe(eb.weaponKind);
    }

    await roomB.leave();
    await roomA.leave();
  }, 25_000);
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @mp/server test test/integration.test.ts -t "cross-client fire"`
Expected: PASS. The two clients observe a non-zero overlap of `fireId`s and every shared event has identical content fields.

If `shared.length` is 0: enemies never entered range. Increase the timeout or move the players (in the test) closer to spawn radius — but check first that `debug_spawn` worked. If individual fields disagree: that's a real bug. Stop and investigate before continuing.

- [ ] **Step 3: Run the full server test suite**

Run: `pnpm --filter @mp/server test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/integration.test.ts
git commit -m "$(cat <<'EOF'
test(server): integration — cross-client fire events are bit-identical

Two clients in the same room each capture every "fire" event by id and
the test asserts that for any fireId observed by both, the position-relevant
fields (originX/Z, dirX/Z, serverFireTimeMs, ownerId, weaponKind) are
identical. This is the regression test for AD1: clients deriving
projectile positions from these fields will agree on world position up
to local clock-offset drift.

Receive time differs by network jitter — expected and not asserted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Client

### Task 13: Create `client/src/net/serverTime.ts` + unit test

**Files:**
- Create: `packages/client/src/net/serverTime.ts`
- Create: `packages/client/src/net/serverTime.test.ts`

Per spec §`client/src/net/serverTime.ts (new)`. Smoothed offset between local and server wall-clock; unit-testable in isolation. Adds the only client-side unit test for M4.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/net/serverTime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ServerTime } from "./serverTime.js";

describe("ServerTime", () => {
  it("first observe sets offsetMs exactly (no smoothing on the first sample)", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    // Pretend the server is 12_000 ms ahead of us with 0 RTT.
    st.observe(realNow + 12_000, 0);
    expect(st.offsetMs).toBeCloseTo(12_000, -2); // tolerance: tens of ms
  });

  it("subsequent observes mix at α=0.2 (exponential smoothing)", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    st.observe(realNow + 100, 0);                 // offsetMs ≈ 100
    const before = st.offsetMs;
    // Now an outlier: server claims it's +1100ms ahead at half-RTT 0.
    st.observe(Date.now() + 1100, 0);
    // Smoothed: 100 * 0.8 + 1100 * 0.2 = 80 + 220 = 300.
    expect(st.offsetMs).toBeCloseTo(300, -2);
    expect(st.offsetMs).toBeLessThan(before + 1000); // didn't snap to outlier
  });

  it("serverNow returns Date.now() + offsetMs", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    st.observe(realNow + 5_000, 0);
    expect(st.serverNow() - Date.now()).toBeCloseTo(5_000, -2);
  });

  it("includes halfRttMs in the sample (server time at receipt = serverNow + halfRtt)", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    // Server's serverNow was 1000ms ago, but the message took 200ms one-way.
    // halfRtt=200 → effective server time at receipt = (now - 1000) + 200 = now - 800.
    // sample = (now - 800) - now = -800.
    st.observe(realNow - 1000, 200);
    expect(st.offsetMs).toBeCloseTo(-800, -2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mp/client test`
Expected: FAIL — `serverTime.ts` doesn't exist.

(Note: the client package already has `vitest.config.ts` from M2. This test runs alongside the existing `prediction.test.ts`.)

- [ ] **Step 3: Implement `packages/client/src/net/serverTime.ts`**

```ts
const ALPHA = 0.2;

/**
 * Smoothed estimate of the offset between this client's wall clock and the
 * server's. Updated by every pong. The basis for AD1 cross-client
 * projectile determinism: every projectile's render position is computed
 * from `serverNow() - interpDelayMs - serverFireTimeMs`, so two clients
 * with stable, similar offsets compute the same world position for the
 * same fireId at the same wall-clock moment.
 *
 * `offsetMs` is initialized exactly from the first sample (no smoothing),
 * then exponentially smoothed at ALPHA=0.2 per subsequent observation.
 * 1Hz pong driver → ~5s effective time constant, fast enough to track
 * clock drift, slow enough to ignore single-sample jitter.
 */
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mp/client test`
Expected: all 4 PASS (plus existing `prediction.test.ts` tests).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/net/serverTime.ts packages/client/src/net/serverTime.test.ts
git commit -m "$(cat <<'EOF'
feat(client): add ServerTime — smoothed server-clock offset

First sample initializes offsetMs exactly; subsequent samples mix at
α=0.2. With the existing 1Hz pong driver, time constant is ~5s — fast
enough to track real clock drift, slow enough to ignore single-sample
jitter. serverNow() = Date.now() + offsetMs is the basis for AD1
cross-client projectile determinism.

Unit tests: first-sample exact init, smoothing on second sample,
halfRttMs included in the sample, serverNow() consistency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Extend `hudState` with M4 fields

**Files:**
- Modify: `packages/client/src/net/hudState.ts`

These show up in DebugHud and in the local-player's PlayerHud row. Adding the fields first means later tasks can populate them without scaffolding ceremony.

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
  fps: number;                 // smoothed render fps (DebugHud rAF tick)
  enemyCount: number;          // active enemies
  enemyDrawCalls: number;      // gl.info.render.calls — proxy for "instancing working"
  // M4 additions:
  xp: number;                  // local player only (mirrored from state.players[me].xp)
  cooldownFrac: number;        // local player; 0..1 (1 = ready, 0 = just fired)
  serverTimeOffsetMs: number;  // debug
  projectileCount: number;     // active projectiles this frame (from ProjectileSwarm)
  visible: boolean;
};

export const hudState: HudState = {
  pingMs: 0,
  serverTick: 0,
  snapshotsPerSec: 0,
  interpDelayMs: 100,
  playerCount: 0,
  reconErr: 0,
  fps: 0,
  enemyCount: 0,
  enemyDrawCalls: 0,
  xp: 0,
  cooldownFrac: 1,
  serverTimeOffsetMs: 0,
  projectileCount: 0,
  visible: false,
};
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds. Existing readers of `hudState` keep working — only additions.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/net/hudState.ts
git commit -m "$(cat <<'EOF'
feat(client): extend hudState with xp / cooldownFrac / srvOffset / projectileCount

Mutable singleton additions for the M4 HUD lines and the always-on
PlayerHud. cooldownFrac defaults to 1 (ready) so the bar shows full
before the first fire. xp defaults to 0. Populated in subsequent tasks
by GameView (xp, cooldownFrac, serverTimeOffsetMs) and ProjectileSwarm
(projectileCount).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Create `client/src/game/CombatVfx.tsx`

**Files:**
- Create: `packages/client/src/game/CombatVfx.tsx`

Per spec §`CombatVfx.tsx (new)`. Three transient flash arrays. The component exposes its push API via a default-exported singleton ref so `GameView`'s message handlers can call into it without prop-drilling. Plain `<mesh>` per active flash — peak count is single digits (hits/sec × 0.2s lifetime), no need for InstancedMesh.

- [ ] **Step 1: Create `packages/client/src/game/CombatVfx.tsx`**

```tsx
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";

const VFX_LIFETIME_S = 0.2;
const HIT_BASE_SCALE = 0.6;
const HIT_BASE_Y = 0.8;
const HIT_BASE_COLOR = "#ffd24a";
const DEATH_BASE_SCALE = 1.4;
const DEATH_BASE_Y = 0.8;
const DEATH_BASE_COLOR = "#ff5050";
const PICKUP_BASE_SCALE = 0.9;
const PICKUP_BASE_Y = 0.6;
const PICKUP_BASE_COLOR = "#5be6ff";

type Flash = { x: number; z: number; t0: number };

/**
 * CombatVfx is a small, ref-driven transient effect manager. GameView's
 * message handlers (fire/hit/enemy_died/gem_collected) call into the
 * singleton API exposed by `vfxRef` to push a flash; useFrame walks
 * each list and removes entries past their lifetime. Plain <mesh>
 * children — peak count is single digits.
 *
 * Why ref-driven instead of state: pushing a flash on every hit at 20Hz
 * across 10 players would re-render the entire CombatVfx tree. Mutating
 * the underlying arrays via a ref + a single forced setState per frame
 * keeps the React tree stable.
 */
export type VfxApi = {
  pushHit: (x: number, z: number) => void;
  pushDeath: (x: number, z: number) => void;
  pushPickup: (x: number, z: number) => void;
};

export function useCombatVfxRef(): { api: VfxApi; component: JSX.Element } {
  const hits = useRef<Flash[]>([]);
  const deaths = useRef<Flash[]>([]);
  const pickups = useRef<Flash[]>([]);
  const [, force] = useState(0);
  const lastForceMs = useRef<number>(0);

  const api = useMemo<VfxApi>(
    () => ({
      pushHit: (x, z) => { hits.current.push({ x, z, t0: performance.now() }); },
      pushDeath: (x, z) => { deaths.current.push({ x, z, t0: performance.now() }); },
      pushPickup: (x, z) => { pickups.current.push({ x, z, t0: performance.now() }); },
    }),
    [],
  );

  const component = (
    <CombatVfxRenderer
      hits={hits}
      deaths={deaths}
      pickups={pickups}
      onPrune={() => {
        const now = performance.now();
        if (now - lastForceMs.current > 16) {
          lastForceMs.current = now;
          force((n) => (n + 1) & 0x7fffffff);
        }
      }}
    />
  );
  return { api, component };
}

type RendererProps = {
  hits: React.MutableRefObject<Flash[]>;
  deaths: React.MutableRefObject<Flash[]>;
  pickups: React.MutableRefObject<Flash[]>;
  onPrune: () => void;
};

function CombatVfxRenderer({ hits, deaths, pickups, onPrune }: RendererProps) {
  useFrame(() => {
    const now = performance.now();
    const cutoff = now - VFX_LIFETIME_S * 1000;
    let pruned = false;
    for (const arr of [hits.current, deaths.current, pickups.current]) {
      let w = 0;
      for (let r = 0; r < arr.length; r++) {
        const f = arr[r]!;
        if (f.t0 >= cutoff) {
          if (w !== r) arr[w] = f;
          w++;
        } else {
          pruned = true;
        }
      }
      arr.length = w;
    }
    onPrune();
    void pruned; // marker for the early-exit reader; pruning above is the side effect
  });

  const now = performance.now();
  const renderFlash = (
    f: Flash,
    baseScale: number,
    baseY: number,
    baseColor: string,
    keyPrefix: string,
  ) => {
    const age = (now - f.t0) / 1000;
    const u = Math.max(0, 1 - age / VFX_LIFETIME_S);
    const scale = baseScale * (0.5 + 0.5 * u);
    const opacity = u;
    return (
      <mesh
        key={`${keyPrefix}-${f.t0}-${f.x.toFixed(3)}-${f.z.toFixed(3)}`}
        position={[f.x, baseY, f.z]}
        scale={scale}
      >
        <sphereGeometry args={[0.5, 8, 6]} />
        <meshStandardMaterial
          color={baseColor}
          emissive={baseColor}
          emissiveIntensity={1.5}
          transparent
          opacity={opacity}
          depthWrite={false}
        />
      </mesh>
    );
  };

  return (
    <group>
      {hits.current.map((f) => renderFlash(f, HIT_BASE_SCALE, HIT_BASE_Y, HIT_BASE_COLOR, "h"))}
      {deaths.current.map((f) => renderFlash(f, DEATH_BASE_SCALE, DEATH_BASE_Y, DEATH_BASE_COLOR, "d"))}
      {pickups.current.map((f) => renderFlash(f, PICKUP_BASE_SCALE, PICKUP_BASE_Y, PICKUP_BASE_COLOR, "p"))}
    </group>
  );
}
```

The `onPrune` throttle (16ms) keeps the React re-render rate to ~60fps even if `useFrame` fires faster. Keys include the float-formatted `x/z` plus `t0` to be unique across simultaneous flashes at the same position from different events; the `"h"` / `"d"` / `"p"` prefix prevents collisions between lists.

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors. (The component isn't mounted yet — Task 19 mounts it.)

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/CombatVfx.tsx
git commit -m "$(cat <<'EOF'
feat(client): add CombatVfx — transient hit/death/pickup flashes

Three ref-backed flash arrays with a 0.2s lifetime; plain <mesh>
per active flash, opacity and scale decay linearly with age. The
useCombatVfxRef hook returns a VfxApi handle that GameView's message
handlers call into directly (no prop drilling), plus the JSX to mount.
A 16ms onPrune throttle limits React re-renders to ~60fps even if
useFrame fires faster.

Peak count is single digits (hits/sec × 0.2s); no InstancedMesh needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Create `client/src/game/ProjectileSwarm.tsx`

**Files:**
- Create: `packages/client/src/game/ProjectileSwarm.tsx`

Per spec §`ProjectileSwarm.tsx (new)`. Single InstancedMesh. Closed-form position from `(serverNow() - interpDelayMs - serverFireTimeMs)`. The Map of in-flight fires is owned by GameView (passed as a prop) so the GameView message handlers can mutate it directly via `Map.set / Map.delete`.

- [ ] **Step 1: Create `packages/client/src/game/ProjectileSwarm.tsx`**

```tsx
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import { PROJECTILE_MAX_CAPACITY, WEAPON_KINDS } from "@mp/shared";
import type { FireEvent } from "@mp/shared";
import { hudState } from "../net/hudState.js";
import type { ServerTime } from "../net/serverTime.js";

const PROJECTILE_RENDER_Y = 0.6;

export type ProjectileSwarmProps = {
  fires: Map<number, FireEvent>;     // GameView-owned map of in-flight fires by fireId
  serverTime: ServerTime;
};

/**
 * Per AD1/AD2: projectiles are not sync'd; each is a closed-form function
 * of its FireEvent payload sampled at `serverNow() - interpDelayMs`. Two
 * clients with stable, similar serverTimeOffsetMs compute the same world
 * position for the same fireId at the same wall-clock moment.
 *
 * No slot allocator: the Map iterates in insertion order, projectile
 * turnover is high (~20+/s at peak), and per-instance attributes are
 * uniform — re-walking the matrix table each frame is the same cost as
 * a slotted update. This component also self-prunes by deleting any
 * fireId whose elapsed >= lifetime; mid-iteration Map.delete on the
 * current key is well-defined in JS.
 */
export function ProjectileSwarm({ fires, serverTime }: ProjectileSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const renderServerTimeMs = serverTime.serverNow() - hudState.interpDelayMs;
    let i = 0;

    for (const [fireId, fe] of fires) {
      const elapsedSec = (renderServerTimeMs - fe.serverFireTimeMs) / 1000;
      // Lifetime is on WEAPON_KINDS[fe.weaponKind].projectileLifetime, but we
      // don't have the kinds table here — and the FireEvent doesn't carry
      // it. Easier: GameView handles lifetime cleanup via setTimeout per
      // FireEvent (see Task 19). Here we just hide projectiles whose
      // elapsed is past a hard upper bound so a missed cleanup doesn't
      // leave a "stuck" instance.
      const kind = WEAPON_KINDS[fe.weaponKind];
      if (!kind) {
        // Unknown kind from a future server: drop quietly.
        fires.delete(fireId);
        continue;
      }
      if (elapsedSec >= kind.projectileLifetime + 0.5) {
        // Past lifetime + small grace; the GameView setTimeout cleanup
        // should have fired by now, but if it was missed (tab backgrounded,
        // throttled), drop here as a backstop.
        fires.delete(fireId);
        continue;
      }
      if (i >= PROJECTILE_MAX_CAPACITY) break; // defense
      const t = elapsedSec > 0 ? elapsedSec : 0;
      matrix.makeTranslation(
        fe.originX + fe.dirX * kind.projectileSpeed * t,
        PROJECTILE_RENDER_Y,
        fe.originZ + fe.dirZ * kind.projectileSpeed * t,
      );
      mesh.setMatrixAt(i, matrix);
      i++;
    }

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    hudState.projectileCount = i;
  });

  return (
    // No castShadow: same Three 0.164 InstancedMesh + shadow-camera
    // landmine that EnemySwarm dodges. Projectiles are tiny and bright;
    // shadows wouldn't read at distance anyway.
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, PROJECTILE_MAX_CAPACITY]}
      frustumCulled={false}
    >
      <sphereGeometry args={[0.15, 8, 6]} />
      <meshStandardMaterial color="#ffd24a" emissive="#ffd24a" emissiveIntensity={1.2} />
    </instancedMesh>
  );
}
```

The `projectileLifetime + 0.5s` upper bound is a defensive backstop — the GameView setTimeout (Task 19) is the primary lifetime driver, but if it was late or missed (tab backgrounded, throttled), this catches the orphan. Speed and lifetime both come from `WEAPON_KINDS[fe.weaponKind]` — the FireEvent carries `weaponKind` (the index) so adding M5's second weapon requires no new sync.

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/ProjectileSwarm.tsx
git commit -m "$(cat <<'EOF'
feat(client): add ProjectileSwarm — single InstancedMesh, closed-form sim

Per AD1/AD2: position = (serverNow() - interpDelayMs - serverFireTimeMs)
* speed * dir + origin. Two clients with stable serverTimeOffsetMs
compute the same world position for the same fireId at the same
wall-clock moment — cross-client jitter is bounded by clock-offset
drift, not network jitter.

InstancedMesh capacity PROJECTILE_MAX_CAPACITY (256). No slot allocator
— Map iteration is insertion-ordered, projectile turnover is high, and
per-instance attributes are uniform. Self-pruning via Map.delete on
elapsed >= projectileLifetime + 0.5s as a defensive backstop; the
primary lifetime cleanup driver is GameView (Task 19).

Speed and lifetime come from WEAPON_KINDS[fe.weaponKind] — adding M5's
second weapon needs no new sync, just a row in the table.

Sphere geometry (radius 0.15), bright emissive yellow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Create `client/src/game/GemSwarm.tsx`

**Files:**
- Create: `packages/client/src/game/GemSwarm.tsx`

Per spec §`GemSwarm.tsx (new)`. Same swap-and-pop pattern as `EnemySwarm`, but driven by `state.gems.onAdd / onRemove`. Per-frame matrix reads `state.gems.get(...)` directly — gems don't move, so no interpolation buffer is needed; one-frame staleness is invisible.

- [ ] **Step 1: Create `packages/client/src/game/GemSwarm.tsx`**

```tsx
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type { Gem, RoomState } from "@mp/shared";
import { PROJECTILE_MAX_CAPACITY } from "@mp/shared";

const GEM_RENDER_Y = 0.4;
const GEM_CAPACITY = PROJECTILE_MAX_CAPACITY; // ample headroom; gems despawn on pickup

export type GemSwarmProps = {
  room: Room<RoomState>;
};

/**
 * Renders state.gems in a single InstancedMesh. Lifecycle is driven by
 * Colyseus state callbacks (gems ARE schema entities). Swap-and-pop slot
 * allocator keeps the active range packed. No SnapshotBuffer — gems
 * don't move, so per-frame matrix update reads the current gem position
 * directly; a one-frame lag of a freshly-added gem is invisible.
 */
export function GemSwarm({ room }: GemSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const slotForId = useRef(new Map<number, number>());
  const idAtSlot = useRef<number[]>([]);
  const activeCountRef = useRef(0);
  const matrix = useMemo(() => new Matrix4(), []);

  useEffect(() => {
    const $ = getStateCallbacks(room);

    const onAdd = (_gem: Gem, key: string) => {
      const id = Number(key);
      if (slotForId.current.has(id)) return;
      const slot = activeCountRef.current++;
      slotForId.current.set(id, slot);
      idAtSlot.current[slot] = id;
    };
    const onRemove = (_gem: Gem, key: string) => {
      const id = Number(key);
      const slot = slotForId.current.get(id);
      if (slot === undefined) return;
      const lastSlot = --activeCountRef.current;
      const lastId = idAtSlot.current[lastSlot]!;
      if (slot !== lastSlot) {
        idAtSlot.current[slot] = lastId;
        slotForId.current.set(lastId, slot);
      }
      slotForId.current.delete(id);
      idAtSlot.current.length = activeCountRef.current;
    };

    const offAdd = $(room.state).gems.onAdd(onAdd);
    const offRemove = $(room.state).gems.onRemove(onRemove);
    room.state.gems.forEach((g, k) => onAdd(g, k));

    return () => {
      offAdd();
      offRemove();
      slotForId.current.clear();
      idAtSlot.current.length = 0;
      activeCountRef.current = 0;
    };
  }, [room]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const count = activeCountRef.current;
    for (let i = 0; i < count; i++) {
      const id = idAtSlot.current[i]!;
      const gem = room.state.gems.get(String(id));
      if (!gem) continue;
      matrix.makeTranslation(gem.x, GEM_RENDER_Y, gem.z);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, GEM_CAPACITY]}
      frustumCulled={false}
    >
      <octahedronGeometry args={[0.3, 0]} />
      <meshStandardMaterial color="#5be6ff" emissive="#5be6ff" emissiveIntensity={0.7} />
    </instancedMesh>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/GemSwarm.tsx
git commit -m "$(cat <<'EOF'
feat(client): add GemSwarm — InstancedMesh of state.gems

Lifecycle driven by Colyseus state.gems.onAdd/onRemove (gems ARE schema
entities). Swap-and-pop slot allocator mirrors EnemySwarm. Per-frame
matrix update reads state.gems directly — gems don't move, so no
SnapshotBuffer. Cyan octahedron geometry, slightly emissive.

Capacity reuses PROJECTILE_MAX_CAPACITY for headroom; gem turnover is
much lower than projectile turnover.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Create `client/src/game/PlayerHud.tsx`

**Files:**
- Create: `packages/client/src/game/PlayerHud.tsx`

Per spec §`PlayerHud.tsx (new)`. Always-on, bottom-left, monospace. Reads `room.state.players` via `getStateCallbacks`. One row per player; cooldown bar is the local fraction. rAF-throttled re-render.

- [ ] **Step 1: Create `packages/client/src/game/PlayerHud.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type { Player, RoomState, WeaponState } from "@mp/shared";
import { WEAPON_KINDS } from "@mp/shared";

const HUD_STYLE: React.CSSProperties = {
  position: "fixed",
  bottom: 8,
  left: 8,
  padding: "6px 10px",
  background: "rgba(0,0,0,0.6)",
  color: "#fff",
  font: "12px/1.4 ui-monospace, Menlo, monospace",
  pointerEvents: "none",
  whiteSpace: "pre",
  zIndex: 1000,
};

const BAR_LEN = 5;

function cooldownBar(weapon: WeaponState | undefined): string {
  if (!weapon) return "·".repeat(BAR_LEN);
  const kind = WEAPON_KINDS[weapon.kind];
  if (!kind) return "·".repeat(BAR_LEN);
  const frac = 1 - Math.max(0, Math.min(1, weapon.cooldownRemaining / kind.cooldown));
  const filled = Math.round(frac * BAR_LEN);
  return "▓".repeat(filled) + "░".repeat(BAR_LEN - filled);
}

export type PlayerHudProps = {
  room: Room<RoomState>;
};

/**
 * Always-on bottom-left HUD: one row per player with name, xp, level,
 * cooldown bar, and weapon name. rAF-throttled re-render via a force
 * counter — same pattern as DebugHud. Reads room.state.players directly
 * each frame (the players are mutated on every server tick), so we don't
 * need to subscribe to add/remove/onChange — the rAF loop is the
 * subscription.
 */
export function PlayerHud({ room }: PlayerHudProps) {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      force((n) => (n + 1) & 0x7fffffff);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, []);

  // We don't drive lifecycle off getStateCallbacks here — but ensure that
  // the initial state has been received before reading. (room.state is a
  // populated Schema instance once any patch has arrived.)
  const _$ = getStateCallbacks(room); // no-op here; ensures the schema callbacks are mounted by now.
  void _$;

  const rows: string[] = [];
  room.state.players.forEach((p: Player) => {
    const w = p.weapons[0];
    const kindName = w !== undefined && WEAPON_KINDS[w.kind] != null
      ? WEAPON_KINDS[w.kind]!.name
      : "—";
    const namePad = (p.name || "Anon").padEnd(8).slice(0, 8);
    const xpStr = String(p.xp).padStart(4);
    const levelStr = String(p.level).padStart(2);
    rows.push(`${namePad} XP ${xpStr}  Lv ${levelStr}  ${cooldownBar(w)}  ${kindName}`);
  });

  if (rows.length === 0) return null;
  return <div style={HUD_STYLE}>{rows.join("\n")}</div>;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/PlayerHud.tsx
git commit -m "$(cat <<'EOF'
feat(client): add PlayerHud — always-on per-player XP / cooldown / weapon

One row per player in state.players: padded name, xp, level, cooldown
bar (5 cells, filled fraction = 1 - cooldownRemaining/cooldown), weapon
name from WEAPON_KINDS[kind]. rAF-throttled re-render mirrors DebugHud.
Reads room.state directly each frame so we don't have to subscribe to
the per-player onChange — the rAF loop is the subscription, and the
per-frame cost is trivial at <=10 players.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Wire combat into `client/src/game/GameView.tsx`

**Files:**
- Modify: `packages/client/src/game/GameView.tsx`

The largest single edit in M4. Adds: `serverTime` ref, `fires` ref, extended `pong` handler with serverNow, fire/hit/enemy_died/gem_collected handlers, lifetime-driven cleanup of `fires`, mounting of all four new components, local-player xp/cooldown mutation in the existing `onChange`. The cleanup must mirror every addition.

- [ ] **Step 1: Update imports at the top of `GameView.tsx`**

Replace the existing imports block (lines 1–14) with:

```tsx
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type {
  Enemy,
  EnemyDiedEvent,
  FireEvent,
  GemCollectedEvent,
  HitEvent,
  Player,
  PongMessage,
  RoomState,
} from "@mp/shared";
import { WEAPON_KINDS } from "@mp/shared";
import { Ground } from "./Ground.js";
import { PlayerCube } from "./PlayerCube.js";
import { EnemySwarm } from "./EnemySwarm.js";
import { ProjectileSwarm } from "./ProjectileSwarm.js";
import { GemSwarm } from "./GemSwarm.js";
import { PlayerHud } from "./PlayerHud.js";
import { useCombatVfxRef } from "./CombatVfx.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { ServerTime } from "../net/serverTime.js";
import { attachInput } from "./input.js";
import { LocalPredictor } from "../net/prediction.js";
import { hudState } from "../net/hudState.js";
import { DebugHud } from "./DebugHud.js";
```

- [ ] **Step 2: Add new ref/memo hooks at the top of the `GameView` component**

After the existing `const buffers = useMemo(() => new Map<string, SnapshotBuffer>(), []);` and predictor lines, add:

```tsx
const serverTime = useMemo(() => new ServerTime(), []);
const fires = useMemo(() => new Map<number, FireEvent>(), []);
const { api: vfx, component: vfxJsx } = useCombatVfxRef();
```

(Place `useCombatVfxRef()` in the body — it's a React hook.)

- [ ] **Step 3: Replace the existing `pong` handler (lines 164–167)**

```tsx
const offPong = room.onMessage("pong", (msg: PongMessage) => {
  const t = Number(msg?.t);
  const rtt = Date.now() - t;
  if (Number.isFinite(rtt)) {
    hudState.pingMs = hudState.pingMs === 0 ? rtt : hudState.pingMs * 0.8 + rtt * 0.2;
  }
  const sn = Number(msg?.serverNow);
  if (Number.isFinite(sn) && Number.isFinite(rtt)) {
    serverTime.observe(sn, rtt / 2);
    hudState.serverTimeOffsetMs = serverTime.offsetMs;
  }
});
```

- [ ] **Step 4: Add combat-event handlers after the `pong` block**

Immediately after `offPong` is declared (and before the `pingTimer` setInterval call), add:

```tsx
// Fire-and-hit event protocol — see CLAUDE.md rule 12.
const fireTimers = new Map<number, ReturnType<typeof setTimeout>>();

const offFire = room.onMessage("fire", (msg: FireEvent) => {
  fires.set(msg.fireId, msg);
  // Schedule cleanup at lifetime + a small grace; ProjectileSwarm has
  // a hard 5s backstop, but the per-fire timer is the primary driver
  // and fires the moment the projectile expires — so the visible
  // count drops in lockstep with reality.
  const kind = WEAPON_KINDS[msg.weaponKind];
  const lifetimeMs = kind ? kind.projectileLifetime * 1000 : 800;
  const timer = setTimeout(() => {
    fires.delete(msg.fireId);
    fireTimers.delete(msg.fireId);
  }, lifetimeMs + 50);
  fireTimers.set(msg.fireId, timer);
});

const offHit = room.onMessage("hit", (msg: HitEvent) => {
  fires.delete(msg.fireId);
  const t = fireTimers.get(msg.fireId);
  if (t) {
    clearTimeout(t);
    fireTimers.delete(msg.fireId);
  }
  // Hit flash at the rendered enemy position — same time-base as the
  // projectile (interpDelayMs behind realtime), so the flash lands where
  // the projectile despawns.
  const buf = enemyBuffers.get(msg.enemyId);
  const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
  if (sample) vfx.pushHit(sample.x, sample.z);
});

const offDied = room.onMessage("enemy_died", (msg: EnemyDiedEvent) => {
  vfx.pushDeath(msg.x, msg.z);
});

const offCollected = room.onMessage("gem_collected", (msg: GemCollectedEvent) => {
  // Pickup pulse at the collecting player's rendered position. For the
  // local player, use the predictor's predicted position; for remote
  // players, use the interpolated buffer.
  if (msg.playerId === room.sessionId) {
    vfx.pushPickup(predictor.predictedX, predictor.predictedZ);
  } else {
    const sample = buffers.get(msg.playerId)?.sample(performance.now() - hudState.interpDelayMs);
    if (sample) vfx.pushPickup(sample.x, sample.z);
  }
});
```

- [ ] **Step 5: Mutate local-player xp / cooldownFrac inside the existing `onChange` handler**

Locate the existing `const offChange = $(player).onChange(() => { ... });` block in `onAdd`. Replace it with:

```tsx
const offChange = $(player).onChange(() => {
  if (sessionId === room.sessionId) {
    predictor.reconcile(player.x, player.z, player.lastProcessedInput);
    hudState.reconErr = predictor.lastReconErr;
    hudState.xp = player.xp;
    const w = player.weapons[0];
    if (w) {
      const kind = WEAPON_KINDS[w.kind];
      const total = kind?.cooldown ?? 1;
      hudState.cooldownFrac = 1 - Math.max(0, Math.min(1, w.cooldownRemaining / total));
    }
  } else {
    buf!.push({ t: performance.now(), x: player.x, z: player.z });
  }
});
```

- [ ] **Step 6: Extend the cleanup return inside the same `useEffect`**

The existing return (around line 194) currently disposes player + enemy listeners. Add the M4 cleanup *before* the `detachInput()` line:

```tsx
offFire();
offHit();
offDied();
offCollected();
fireTimers.forEach((t) => clearTimeout(t));
fireTimers.clear();
fires.clear();
```

Also extend the `useEffect` dependency array (currently `[room, buffers, predictor, enemyBuffers, onUnexpectedLeave]`) to include `serverTime`, `fires`, and `vfx`. The vfx api object is memoized inside `useCombatVfxRef`, so its identity is stable for the GameView lifetime.

```tsx
}, [room, buffers, predictor, enemyBuffers, serverTime, fires, vfx, onUnexpectedLeave]);
```

- [ ] **Step 7: Mount the new components inside the `<Canvas>`**

In the JSX return at the bottom of the component, replace the existing `<Canvas>...<EnemySwarm>...</Canvas>` block with:

```tsx
<Canvas
  shadows
  camera={{ position: [0, 12, 12], fov: 55 }}
  style={{ width: "100%", height: "100%" }}
>
  <ambientLight intensity={0.5} />
  <directionalLight position={[10, 20, 5]} intensity={1.0} castShadow />
  <Ground />
  {Array.from(players.values()).map((p) => (
    <PlayerCube
      key={p.sessionId}
      sessionId={p.sessionId}
      name={p.name}
      buffer={p.buffer}
      predictor={p.sessionId === room.sessionId ? predictor : undefined}
    />
  ))}
  <EnemySwarm enemyIds={enemyIds} buffers={enemyBuffers} />
  <ProjectileSwarm fires={fires} serverTime={serverTime} />
  <GemSwarm room={room} />
  {vfxJsx}
</Canvas>
```

Below the `<Canvas>` (before the closing wrapper `</div>`), add the always-on PlayerHud:

```tsx
<PlayerHud room={room} />
<DebugHud />
```

(`<DebugHud />` was already present; the new line is `<PlayerHud room={room} />` immediately above it.)

- [ ] **Step 8: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 10: Manual verification — single tab, basic loop**

Run `pnpm dev` in a separate terminal. Open `http://localhost:5173`, create a room. Wait ~6 seconds. Expected:
- Cones appear and walk toward your cube.
- When a cone enters range (~ENEMY_SPAWN_RADIUS - TARGETING_MAX_RANGE = 10 units), a glowing yellow sphere fires from your cube toward it.
- Hit flash on impact; on the third hit the cone vanishes with a red flash and a cyan octahedron drops.
- Walk over the gem (WASD) — XP in the bottom-left HUD ticks up; gem vanishes; cyan pulse on you.

If any step fails: open DevTools, check the console. Common culprits, in order: (a) `pong` handler typing `msg.serverNow` as undefined (the server isn't sending it — re-check Task 9 step 3b), (b) `fires` Map not being populated (the `fire` handler isn't registered — check the ordering of `room.onMessage` calls), (c) `<ProjectileSwarm>` mounted but no instances visible (`serverTime.offsetMs` is 0, no pongs received — wait one full ping interval).

- [ ] **Step 11: Commit**

```bash
git add packages/client/src/game/GameView.tsx
git commit -m "$(cat <<'EOF'
feat(client): wire M4 combat into GameView — events, components, HUD

Mounts ProjectileSwarm, GemSwarm, CombatVfx, PlayerHud. Adds
serverTime + fires refs. Extends pong handler to feed serverTime.observe
with serverNow and rtt/2. Registers fire/hit/enemy_died/gem_collected
handlers; hit and pickup flashes use enemy/player interpolation buffers
sampled at the same interpDelayMs as state, so VFX lands where the
projectile despawns (AD2). Each fire schedules a per-projectile setTimeout
to drop from the in-flight Map at lifetime+50ms; ProjectileSwarm's 5s
hard backstop only fires if the timer was missed.

Local-player onChange now mirrors player.xp and weapons[0].cooldownRemaining
into hudState. Dependency array extended; cleanup mirrors every addition.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Extend `DebugHud.tsx` with M4 lines

**Files:**
- Modify: `packages/client/src/game/DebugHud.tsx`

Per spec §`DebugHud.tsx`. Three new lines: `srv offset`, `projectiles`, `xp / cd`. Visible when F3 is on.

- [ ] **Step 1: Update the `lines` array in `packages/client/src/game/DebugHud.tsx`**

Replace the existing `lines` array (around lines 48–58) with:

```ts
const lines = [
  `fps        ${hudState.fps.toFixed(0)}`,
  `ping       ${hudState.pingMs.toFixed(0)} ms`,
  `server tick ${hudState.serverTick}`,
  `snapshots  ${hudState.snapshotsPerSec.toFixed(1)} / s`,
  `interp     ${hudState.interpDelayMs} ms`,
  `players    ${hudState.playerCount}`,
  `recon err  ${hudState.reconErr.toFixed(3)} u`,
  `enemies    ${hudState.enemyCount}`,
  `draw calls ${hudState.enemyDrawCalls}`,
  `srv offset ${hudState.serverTimeOffsetMs.toFixed(0)} ms`,
  `projectiles ${hudState.projectileCount}`,
  `xp / cd    ${hudState.xp} / ${hudState.cooldownFrac.toFixed(2)}`,
];
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the client builds**

Run: `pnpm --filter @mp/client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/DebugHud.tsx
git commit -m "$(cat <<'EOF'
feat(client): DebugHud — add srv offset / projectiles / xp / cd lines

Three new debug lines under F3. srv offset shows the smoothed offset
between local and server wall-clock (basis for AD1 cross-client
projectile sim — should be small and stable). projectiles is the
in-flight count rendered this frame. xp / cd shows the local player's
xp and cooldown fraction (1=ready, 0=just fired).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Verification, docs, perf

### Task 21: Update `CLAUDE.md` with rules 11 and 12

**Files:**
- Modify: `CLAUDE.md`

Per spec §CLAUDE.md additions. These two new rules capture the M4 load-bearing decisions for every future weapon and pickup type — they're how someone reading the project tomorrow knows tick order is fixed and combat is event-based.

- [ ] **Step 1: Open `CLAUDE.md` and locate the "Architectural rules" section**

Find rule 10 (the `Enemies are simulated server-only…` rule). Rules 11 and 12 follow it.

- [ ] **Step 2: Append rules 11 and 12 after rule 10**

Insert as items 11 and 12 in the numbered list, immediately after the existing rule 10:

```markdown
11. **Tick order.** Each server tick runs in this fixed order:
    `tickPlayers → tickEnemies → tickWeapons → tickProjectiles → tickGems → tickSpawner`.
    Players first so weapons see fresh positions; weapons before
    projectiles so a same-tick fire is integrated next tick (it starts
    with `age = 0` and the projectile's first movement is in the
    *following* `tickProjectiles` call); gems after projectiles so
    this-tick deaths drop pickups before pickup checks run; spawner last
    so freshly-spawned enemies get one tick of grace before any other
    system touches them. This order is load-bearing for fairness — do
    not reorder.
12. **Combat events are server→client only and time-based, not state.**
    `fire`, `hit`, `enemy_died`, `gem_collected` are broadcast events,
    not schema entries. Projectiles are simulated client-side as a
    closed-form function of the `fire` event payload and a synced server
    clock (extended `pong` carries `serverNow`; client smooths
    `serverTimeOffsetMs`). Projectiles render at the same `interpDelayMs`
    as state interpolation, so hit feedback aligns with the rendered
    enemy. Adding a new weapon means adding a row to `WEAPON_KINDS` and
    (if non-trivial) a new `targeting` mode — never new sync logic.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md rules 11 & 12 — tick order + combat-events-not-state

Rule 11 fixes the AD6 tick order. Rule 12 captures the fire-and-hit
event protocol and the AD1/AD2 closed-form projectile sim — the load-
bearing decisions every future weapon and pickup type inherits from.
Adding a new weapon is content work, not architecture work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Manual verification + perf check + record numbers in README

**Files:**
- Modify: `README.md`

Per spec §Verification and §Performance check. Run the full manual list, then the perf phases, then write the numbers down honestly. **Do not optimize anything during this task** — if numbers are concerning, stop and report.

- [ ] **Step 1: `pnpm typecheck` and `pnpm test` both pass**

Run: `pnpm typecheck && pnpm test`
Expected: green across shared, server, client. Stop and fix if anything fails.

- [ ] **Step 2: Run the manual verification list (spec §Verification)**

Start `pnpm dev`. Open two browser tabs at `http://localhost:5173`.

1. **Auto-fire visible.** Both tabs join. Within ~6s of the first enemy entering range, both players' weapons start auto-firing. Visible projectiles fly out of each player toward their target.
2. **Cross-client visual determinism.** Pick a single in-flight projectile (use the slow-motion of a Bolt's 0.8s lifetime). Same world position in both tabs at the same wall-clock moment. The `srv offset` debug HUD line stays stable around a small value (<10ms on localhost; tens on real network). Drift would manifest as projectiles slowly diverging across clients.
3. **Hits and deaths.** Hit flashes land on rendered enemies (not in mid-air, not behind them). Enemies die after exactly 3 hits. Gems drop at the enemy's death position.
4. **Pickup.** Walk over a gem; XP ticks up on `PlayerHud`. Gem vanishes from both tabs in the same frame.
5. **Cross-client gem positions.** Both tabs see identical gems in identical positions; pickups consistent (one tab can't see a gem that the other doesn't).
6. **200 enemies.** Press F3 to show DebugHud. Press `]` 20 times (or `}` to spawn 100 at a time, then again — that's 200). Combat continues. `fps` holds 60 in both tabs. `projectileCount` HUD line stays small (typically 0–20).
7. **Throttled.** DevTools → Network → Fast 3G on one tab. Combat still functions. The throttled tab's projectiles may visibly lag and cross-tab determinism may degrade under heavy throttling — note the magnitude in the README rather than fail the test. The throttled tab itself stays self-consistent (no jitter, no snap).
8. **Reconnect mid-combat.** Drop tab A to "Offline" for 5s within the 30s grace window. Restore. Tab A reconnects; schema state correct (xp, enemies, gems all match tab B). In-flight projectiles at the moment of disconnect are gone from tab A's view — expected, no event replay.
9. **`pnpm typecheck` and `pnpm test` still green.**

If any step fails: stop and diagnose. Do NOT proceed to the perf test.

- [ ] **Step 3: Run the perf check (spec §Performance check)**

With both tabs still connected:

**Phase 1 — 200 enemies.** Press `\` to clear, then `}` twice (200 spawned via debug). Wait ~5s for steady state. Record:
- Client fps (both tabs) — target 60.
- Server tick rate via `serverTick` HUD line — should advance ~20/s.
- Server log: per-tick patch bytes, full-state bytes (`[room ABCD] snapshot avg=...B/tick full=...B …`).
- HUD `projectileCount` (typical and peak).
- HUD `srv offset` — should stay stable, not drift over 30s.

**Phase 2 — 300 enemies.** Press `}` once more. We hit `MAX_ENEMIES`. Wait ~5s. Record the same numbers again.

- [ ] **Step 4: Apply the stop conditions (spec §"Stop conditions")**

- If per-tick patch bytes > **50 KB** at 200 enemies, **stop**. Diagnose before optimizing. Each `WeaponState.cooldownRemaining` change is one float per active player per tick — ~16B × 2 players ≈ 32B; this should not blow the budget. If it does, suspect cooldown ticking — consider quantizing or only syncing on fire-cycle boundaries. Don't optimize blindly.
- If client fps drops at 200 enemies, **stop**. Diagnose first: VFX array growing unbounded? `ProjectileSwarm` slot table thrash? `CombatVfx` `<mesh>` count?

If both stop conditions are clear, proceed to Step 5.

- [ ] **Step 5: Append the perf table to `README.md`**

After the existing "Manual perf test (M3)" section, add:

```markdown

## Manual perf test (M4)

Run on YYYY-MM-DD, <hardware>, 2 connected Chrome tabs.

| Enemies | Client FPS | Server tick | Patch bytes/tick | Full-state bytes | Peak projectiles | srv offset |
|--------:|-----------:|------------:|-----------------:|-----------------:|-----------------:|-----------:|
| 0       | 60         | 20Hz        | <baseline>       | <baseline>       | 0                | <ms>       |
| 200     | <num>      | <num>       | <num>            | <num>            | <num>            | <ms>       |
| 300     | <num>      | <num>       | <num>            | <num>            | <num>            | <ms>       |

Notes: <observations — VFX behavior, srv offset stability over 30s, any
cross-client divergence on Fast 3G; whether `Patch bytes/tick` was n/a
because Colyseus 0.16's broadcastPatch returns hasChanges (matches the M3
note).>
```

Replace every `<...>` with actual numbers. **Be honest** — if a number was disappointing, write it down.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: README — record M4 manual perf test results

200 and 300 enemies with auto-fire from 2 connected clients. Numbers
as measured.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Final sanity sweep**

Run: `pnpm typecheck && pnpm test`
Expected: all green. M4 is done.

---

## Done criteria

All of the following are true:

- [ ] All 22 tasks above committed.
- [ ] `pnpm test` passes (shared rules + schema, server integration including 3 new tests, server reconnect, server sync, client serverTime + prediction).
- [ ] `pnpm typecheck` passes.
- [ ] Manual verification steps 1–8 all pass (Task 22 Step 2).
- [ ] Perf table in README is filled in with real numbers.
- [ ] No `Math.random` calls reachable from any gameplay-affecting code path.
- [ ] CLAUDE.md rules 11 and 12 are in place.
- [ ] `WEAPON_KINDS` is a single-row array (the M5 forward-compat shape).
- [ ] Every new schema field uses `declare` + constructor-body assignment (no class field initializers).

If a stop condition triggered during Task 22, the milestone is **paused**, not done. Report the numbers and stop.
