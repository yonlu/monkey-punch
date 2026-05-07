# M6 Playability Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle five non-architectural playability items (third-person camera with mouse-aim facing, larger map with despawn, player HP + spectator-mode downed state + run-end, billboarded names + per-player HP bars, 2D-canvas minimap) into a single shipping change set.

**Architecture:** Server-authoritative with deterministic ticks remains untouched. Schema gains 8 Player fields and 2 RoomState fields, all through the `declare` + `defineTypes` dance documented in the schema landmine. Two new tick functions (`tickContactDamage`, `tickRunEndCheck`) slot between `tickEnemies` and `tickWeapons`; every tick function gains a `state.runEnded` early-out. The `orbitHitCooldown.ts` shape is mirrored for contact damage. Client gains a `<CameraRig>` component, mouse-aim raycast input, drei-billboarded nameplates, a 2D-canvas minimap overlay, and a run-over panel.

**Tech Stack:** TypeScript 5.x strict, pnpm workspaces, Colyseus 0.16 + `@colyseus/schema`, Vitest, Vite + React + React Three Fiber 8 + drei 9, Three.js 0.164.

**Spec:** `docs/superpowers/specs/2026-05-06-m6-playability-design.md` (commit `30f80b4`).

---

## File Structure

### New files (7)

| File | Responsibility |
|---|---|
| `packages/server/src/contactCooldown.ts` | Per-(playerId, enemyId) hit cooldown store. Mirrors `orbitHitCooldown.ts` exactly. |
| `packages/client/src/game/CameraRig.tsx` | Lerp-follow camera + spectator-mode target switching when local player downed. |
| `packages/client/src/game/Crosshair.tsx` | In-world ground-plane reticle at mouse-raycast point; hidden when local player downed. |
| `packages/client/src/game/BoundaryRing.tsx` | Emissive torus at `MAP_RADIUS` so players can see the edge. |
| `packages/client/src/game/DamageNumberPool.tsx` | 30-slot pool of drei `<Text>` floaters; reads `hit` and `player_damaged` events. |
| `packages/client/src/game/MinimapCanvas.tsx` | 200×200 DOM `<canvas>` overlay top-right; reads `room.state` directly each frame. |
| `packages/client/src/game/RunOverPanel.tsx` | DOM overlay reading `runEnded` + per-player recap; "Leave room" button. |

### Edited files

| File | Changes |
|---|---|
| `packages/shared/src/constants.ts` | 7 new tuning constants. |
| `packages/shared/src/schema.ts` | 8 Player fields + 2 RoomState fields. |
| `packages/shared/src/messages.ts` | `InputMessage.facing`, 3 new events, `MessageType` entries. |
| `packages/shared/src/index.ts` | Re-exports for new types. |
| `packages/shared/src/rules.ts` | `runEnded` early-out everywhere; new `tickContactDamage`, `tickRunEndCheck`; updates to `tickPlayers`, `tickEnemies`, `tickWeapons`, `tickProjectiles`, `tickGems`, `tickSpawner`; new `ContactCooldownLike` interface. |
| `packages/shared/test/rules.test.ts` | New test groups for everything in `rules.ts`. |
| `packages/server/src/input.ts` | New `clampFacing`. |
| `packages/server/src/GameRoom.ts` | New field init in `onJoin`; downed-gate in input handler; facing write; contactCooldown wiring; sweep + evict; new tick wiring; consent-leave path unchanged. |
| `packages/server/test/integration.test.ts` | End-to-end `player_damaged → player_downed → run_ended` test. |
| `packages/server/test/reconnect.test.ts` | Downed-survives-reconnect test. |
| `packages/client/src/game/input.ts` | Mouse listener, `getLiveFacing`, send `facing` in 20Hz step. |
| `packages/client/src/game/PlayerCube.tsx` | Facing rotation, nose, downed visual, drei `<Billboard>` with `<Text>` + HP bar. |
| `packages/client/src/game/PlayerHud.tsx` | Main HP bar, damage flash overlay. |
| `packages/client/src/game/Ground.tsx` | Plane size to `MAP_RADIUS * 2.2`. |
| `packages/client/src/game/LevelUpOverlay.tsx` | Hide when local player downed; short-circuit 1/2/3 keys. |
| `packages/client/src/game/GameView.tsx` | Wire `<CameraRig>`, `<Crosshair>`, `<BoundaryRing>`, `<DamageNumberPool>`, `<MinimapCanvas>`, `<RunOverPanel>`; subscribe to new events; remove static camera. |
| `packages/client/src/App.tsx` | `onConsentLeave` callback wired from `<RunOverPanel>`. |
| `CLAUDE.md` | Rule 11 tick-order extension; rule 12 broadcast-event additions. |

---

## Phase 0 — Documentation foundations (do first; cheap and prevents drift)

### Task 0.1: Update CLAUDE.md rule 11 (tick order)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read current rule 11 to anchor the edit**

Run: `grep -n "Tick order" CLAUDE.md`

- [ ] **Step 2: Replace the rule 11 tick-order list and rationale**

Open `CLAUDE.md` and replace the rule 11 paragraph with:

```markdown
11. **Tick order.** Each server tick runs in this fixed order:
    `tickPlayers → tickEnemies → tickContactDamage → tickRunEndCheck
    → tickWeapons → tickProjectiles → tickGems → tickXp
    → tickLevelUpDeadlines → tickSpawner`.
    Players first so weapons see fresh positions; contact damage after
    enemies so contact tests see post-movement positions; run-end check
    immediately after so weapons/projectiles/spawner all see the
    post-end state; weapons before projectiles so a same-tick fire is
    integrated next tick (it starts with `age = 0` and the projectile's
    first movement is in the *following* `tickProjectiles` call); gems
    after projectiles so this-tick deaths drop pickups before pickup
    checks run; xp after gems so this-tick gem pickups feed the
    level-up threshold check; deadlines immediately after xp so an
    auto-pick that fires this tick uses fresh choices; spawner last so
    the rng schedule is fixed (xp + spawner both consume the room rng
    — reordering forks the seed). This order is load-bearing for
    fairness AND for cross-client determinism — do not reorder.
    Universal invariant (M6 onward): every tick function early-outs at
    its top with `if (state.runEnded) return;`. The frozen-world recap
    state is one branch in each function, not a per-system gate.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claudemd): rule 11 — extend tick order for M6 contact damage + run-end"
```

---

### Task 0.2: Update CLAUDE.md rule 12 (broadcast events)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the events list in rule 12**

Find the rule 12 paragraph that lists combat events. Replace the list line with:

```
`fire`, `hit`, `enemy_died`, `gem_collected`, `level_up_offered`,
`level_up_resolved`, `player_damaged`, `player_downed`, `run_ended`
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claudemd): rule 12 — add player_damaged, player_downed, run_ended"
```

---

## Phase 1 — Shared foundation (must land cleanly: encoder must remain consistent)

### Task 1.1: Add tuning constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Append new constants**

At the bottom of `packages/shared/src/constants.ts` add:

```ts
// M6 — playability pass
export const MAP_RADIUS = 60;                  // world units
export const PLAYER_RADIUS = 0.5;              // matches cube half-extent
export const PLAYER_MAX_HP = 100;
export const ENEMY_CONTACT_DAMAGE = 5;         // hp per contact
export const ENEMY_CONTACT_COOLDOWN_S = 0.5;   // per-(player, enemy) pair
export const ENEMY_DESPAWN_RADIUS = 50;        // beyond this from any non-downed player
export const PLAYER_NAME_MAX_LEN = 16;
```

- [ ] **Step 2: Build shared so consumers see the new exports**

Run: `pnpm --filter @mp/shared build`
Expected: clean build, no TypeScript errors.

- [ ] **Step 3: Confirm constants test still passes**

Run: `pnpm --filter @mp/shared test -- constants`
Expected: PASS (existing constants test should be unaffected).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): M6 tuning constants — MAP_RADIUS, PLAYER_MAX_HP, contact damage"
```

---

### Task 1.2: Extend messages.ts (InputMessage facing + 3 new events)

**Files:**
- Modify: `packages/shared/src/messages.ts`

- [ ] **Step 1: Extend `InputMessage` with `facing`**

Replace the existing `InputMessage` type with:

```ts
export type InputMessage = {
  type: "input";
  seq: number;                                 // monotonic per client (required)
  dir: { x: number; z: number };
  facing: { x: number; z: number };            // unit vector; server clamps; defaults (0,1)
};
```

- [ ] **Step 2: Add three broadcast event types**

Above the `MessageType` const at the bottom of the file, add:

```ts
export type PlayerDamagedEvent = {
  type: "player_damaged";
  playerId: string;
  damage: number;
  x: number;                // player position at hit, for floating-number placement
  z: number;
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

- [ ] **Step 3: Add `debug_damage_self` to ClientMessage union**

Append to the existing debug-message types in `messages.ts`:

```ts
export type DebugDamageSelfMessage = {
  type: "debug_damage_self";
  amount: number;            // server clamps to current hp
};
```

Extend the `ClientMessage` union to include `DebugDamageSelfMessage`. This is a test/dev-only utility that lets the reconnect test drop a player into `downed=true` deterministically without simulating ten seconds of contact damage.

- [ ] **Step 4: Extend `MessageType` table**

Add to the `MessageType` const:

```ts
  PlayerDamaged: "player_damaged",
  PlayerDowned: "player_downed",
  RunEnded: "run_ended",
  DebugDamageSelf: "debug_damage_self",
```

- [ ] **Step 5: Build shared**

Run: `pnpm --filter @mp/shared build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/messages.ts
git commit -m "feat(shared): InputMessage.facing + player_damaged/downed/run_ended events + debug_damage_self"
```

---

### Task 1.3: Extend schema.ts (Player + RoomState fields)

**Files:**
- Modify: `packages/shared/src/schema.ts`

- [ ] **Step 1: Add 8 fields to `Player` class body**

Inside `class Player extends Schema { ... }`, add these declarations (immediately after the existing `declare levelUpDeadlineTick: number;`):

```ts
  declare hp: number;
  declare maxHp: number;
  declare downed: boolean;
  declare facingX: number;
  declare facingZ: number;
  declare kills: number;
  declare xpGained: number;
  declare joinTick: number;
```

- [ ] **Step 2: Initialize the 8 fields in the `Player` constructor**

In `Player`'s `constructor()`, immediately after the existing `this.levelUpDeadlineTick = 0;` line, add:

```ts
    this.hp = 100;
    this.maxHp = 100;
    this.downed = false;
    this.facingX = 0;
    this.facingZ = 1;
    this.kills = 0;
    this.xpGained = 0;
    this.joinTick = 0;
```

- [ ] **Step 3: Add the 8 fields to the `defineTypes(Player, ...)` call**

In the `defineTypes(Player, { ... })` call below the class, append:

```ts
  hp: "uint16",
  maxHp: "uint16",
  downed: "boolean",
  facingX: "number",
  facingZ: "number",
  kills: "uint32",
  xpGained: "uint32",
  joinTick: "uint32",
```

- [ ] **Step 4: Add 2 fields to `RoomState`**

In `class RoomState extends Schema { ... }`, after `declare gems: MapSchema<Gem>;` add:

```ts
  declare runEnded: boolean;
  declare runEndedTick: number;
```

In the `RoomState` constructor, after `this.gems = new MapSchema<Gem>();` add:

```ts
    this.runEnded = false;
    this.runEndedTick = 0;
```

In the `defineTypes(RoomState, { ... })` call, append:

```ts
  runEnded: "boolean",
  runEndedTick: "uint32",
```

- [ ] **Step 5: Build shared (CRITICAL — encoder must produce no errors)**

Run: `pnpm --filter @mp/shared build`
Expected: clean.

- [ ] **Step 6: Run the schema integration test (the encoder-landmine guard)**

Run: `pnpm --filter @mp/server test -- integration`
Expected: PASS. If FAIL, the schema landmine has been triggered — re-check that every new field uses `declare` + constructor-init + `defineTypes`. Class field initializers are fatal.

- [ ] **Step 7: Run the existing schema unit tests**

Run: `pnpm --filter @mp/shared test -- schema`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/schema.ts
git commit -m "feat(shared): Player hp/downed/facing/kills/xpGained/joinTick + RoomState runEnded"
```

---

## Phase 2 — Server input handling and field initialization

### Task 2.1: Add `clampFacing` to server input.ts (TDD)

**Files:**
- Modify: `packages/server/src/input.ts`
- Modify: `packages/server/test/input.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/input.test.ts`:

```ts
import { clampFacing } from "../src/input.js";

describe("clampFacing", () => {
  it("returns (0,1) for zero input", () => {
    expect(clampFacing(0, 0)).toEqual({ x: 0, z: 1 });
  });

  it("returns (0,1) for non-finite input", () => {
    expect(clampFacing(NaN, 0)).toEqual({ x: 0, z: 1 });
    expect(clampFacing(0, Infinity)).toEqual({ x: 0, z: 1 });
  });

  it("normalizes a non-unit vector", () => {
    const v = clampFacing(3, 4);
    expect(v.x).toBeCloseTo(0.6);
    expect(v.z).toBeCloseTo(0.8);
  });

  it("preserves a unit vector", () => {
    const v = clampFacing(0.6, 0.8);
    expect(v.x).toBeCloseTo(0.6);
    expect(v.z).toBeCloseTo(0.8);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/server test -- input`
Expected: FAIL with "clampFacing is not a function" or compile error.

- [ ] **Step 3: Implement `clampFacing`**

Append to `packages/server/src/input.ts`:

```ts
/**
 * Validate and normalize a 2D facing vector. Non-finite components or zero
 * magnitude fall back to (0, 1) — the schema default. Magnitude is always
 * normalized to 1, unlike `clampDirection` which preserves sub-unit lengths
 * (input dir can be partial; facing is always a unit vector by contract).
 */
export function clampFacing(x: number, z: number): Dir2 {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { x: 0, z: 1 };
  const len = Math.hypot(x, z);
  if (len === 0) return { x: 0, z: 1 };
  return { x: x / len, z: z / len };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @mp/server test -- input`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/input.ts packages/server/test/input.test.ts
git commit -m "feat(server): clampFacing — unit vector with (0,1) fallback"
```

---

### Task 2.2: Initialize new Player fields in `GameRoom.onJoin`

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Import `PLAYER_MAX_HP` and `PLAYER_NAME_MAX_LEN`**

In the `import { ... } from "@mp/shared"` block at the top of `GameRoom.ts`, add `PLAYER_MAX_HP` and `PLAYER_NAME_MAX_LEN` to the named imports.

- [ ] **Step 2: Initialize new fields in `onJoin`**

Replace the body of `onJoin` (the part *before* the `bolt` weapon push) with:

```ts
  const player = new Player();
  player.sessionId = client.sessionId;
  player.name =
    ((options?.name ?? "").trim().slice(0, PLAYER_NAME_MAX_LEN) || "Player");
  player.x = 0;
  player.y = 0;
  player.z = 0;
  player.hp = PLAYER_MAX_HP;
  player.maxHp = PLAYER_MAX_HP;
  player.downed = false;
  player.facingX = 0;
  player.facingZ = 1;
  player.kills = 0;
  player.xpGained = 0;
  player.joinTick = this.state.tick;
```

(The existing `bolt` push and `state.players.set(...)` lines stay below this block, unchanged.)

- [ ] **Step 3: Verify the integration test still passes**

Run: `pnpm --filter @mp/server test -- integration`
Expected: PASS — onJoin produces a fully-initialized Player; no encoder regression.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "feat(server): onJoin initializes hp, downed, facing, kills, xpGained, joinTick"
```

---

### Task 2.3: Extend input handler with downed-gate and facing write

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Import `clampFacing`**

In the `import { ... } from "./input.js"` block, change `clampDirection` to `clampDirection, clampFacing`.

- [ ] **Step 2: Replace the `input` message handler**

Replace the existing `this.onMessage<InputMessage>("input", ...)` block with:

```ts
this.onMessage<InputMessage>("input", (client, message) => {
  const player = this.state.players.get(client.sessionId);
  if (!player) return;
  if (player.downed) return;                   // drop silently; do NOT bump lastProcessedInput
  if (this.state.runEnded) return;             // run-end frozen state

  const seq = Number(message?.seq);
  if (!Number.isFinite(seq) || seq <= player.lastProcessedInput) return;

  const dir = clampDirection(Number(message?.dir?.x), Number(message?.dir?.z));
  const facing = clampFacing(Number(message?.facing?.x), Number(message?.facing?.z));
  player.inputDir.x = dir.x;
  player.inputDir.z = dir.z;
  player.facingX = facing.x;
  player.facingZ = facing.z;
  player.lastProcessedInput = seq;
});
```

- [ ] **Step 3: Run the existing input/integration tests**

Run: `pnpm --filter @mp/server test -- input integration`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "feat(server): input handler — downed/runEnded gate + facing write"
```

---

### Task 2.4: Add `debug_damage_self` handler in GameRoom

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Add `DebugDamageSelfMessage` to the type imports**

In the `import type { ... } from "@mp/shared"` block near the top of `GameRoom.ts`, add `DebugDamageSelfMessage` to the named imports.

- [ ] **Step 2: Add the handler inside the `if (ALLOW_DEBUG_MESSAGES) { ... }` block**

Append, immediately after the existing `debug_grant_xp` handler:

```ts
this.onMessage<DebugDamageSelfMessage>("debug_damage_self", (client, message) => {
  const player = this.state.players.get(client.sessionId);
  if (!player) return;
  if (player.downed) return;
  const amount = Math.max(1, Math.min(Math.floor(Number(message?.amount) || 0), player.hp));
  player.hp -= amount;
  this.emit({
    type: "player_damaged",
    playerId: client.sessionId,
    damage: amount,
    x: player.x,
    z: player.z,
    serverTick: this.state.tick,
  });
  if (player.hp <= 0 && !player.downed) {
    player.downed = true;
    player.inputDir.x = 0;
    player.inputDir.z = 0;
    this.emit({
      type: "player_downed",
      playerId: client.sessionId,
      serverTick: this.state.tick,
    });
  }
});
```

- [ ] **Step 3: Run server tests to confirm no regression**

Run: `pnpm --filter @mp/server test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "feat(server): debug_damage_self handler — fast-path for testing downed state"
```

---

## Phase 3 — Tick functions (TDD, one per task)

### Task 3.1: Add `state.runEnded` early-out to all existing tick functions

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write a failing test that exercises `runEnded` on every existing tick function**

Append a new `describe` block to `packages/shared/test/rules.test.ts`:

```ts
describe("runEnded universal early-out", () => {
  function makeFrozenState(): RoomState {
    const state = new RoomState();
    state.runEnded = true;
    const p = addPlayer(state, "a", 1, 0);
    p.x = 0; p.z = 0;
    addEnemy(state, 1, 5, 0);
    return state;
  }

  function noopEmit() {}

  it("tickPlayers does not move players when runEnded", () => {
    const state = makeFrozenState();
    const p = state.players.get("a")!;
    tickPlayers(state, 0.05);
    expect(p.x).toBe(0);
    expect(p.z).toBe(0);
  });

  it("tickEnemies does not move enemies when runEnded", () => {
    const state = makeFrozenState();
    const e = state.enemies.get("1")!;
    tickEnemies(state, 0.05);
    expect(e.x).toBe(5);
    expect(e.z).toBe(0);
  });

  it("tickGems does not collect gems when runEnded", () => {
    const state = makeFrozenState();
    const p = state.players.get("a")!;
    const g = new Gem();
    g.id = 1; g.x = 0; g.z = 0; g.value = 5;
    state.gems.set("1", g);
    tickGems(state, noopEmit);
    expect(state.gems.size).toBe(1);
    expect(p.xp).toBe(0);
  });

  it("tickXp does not advance xp threshold when runEnded", () => {
    const state = makeFrozenState();
    const p = state.players.get("a")!;
    p.xp = 10_000;
    p.level = 1;
    tickXp(state, mulberry32(1), noopEmit);
    expect(p.level).toBe(1);
    expect(p.pendingLevelUp).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL — existing tick functions still mutate state when `runEnded` is true.

- [ ] **Step 3: Add `if (state.runEnded) return;` as the first line of every existing tick function**

In `packages/shared/src/rules.ts`, add this guard at the top of:
- `tickPlayers`
- `tickEnemies`
- `tickWeapons`
- `tickProjectiles`
- `tickGems`
- `tickXp`
- `tickLevelUpDeadlines`
- `tickSpawner`

(For example, `tickPlayers` becomes:)

```ts
export function tickPlayers(state: RoomState, dt: number): void {
  if (state.runEnded) return;
  state.players.forEach((p) => {
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
  });
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): runEnded universal early-out across all tick functions"
```

---

### Task 3.2: `tickPlayers` — clamp to MAP_RADIUS + skip downed

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/test/rules.test.ts` after the existing `describe("tickPlayers", ...)` block:

```ts
describe("tickPlayers — M6", () => {
  it("clamps player position to MAP_RADIUS when integration would exceed it", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);
    p.x = 59;
    p.z = 0;
    // Step would push past MAP_RADIUS=60.
    for (let i = 0; i < 100; i++) tickPlayers(state, 0.05);
    expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(60 + 1e-9);
    expect(p.x).toBeCloseTo(60);
  });

  it("does not move downed players", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);
    p.downed = true;
    tickPlayers(state, 0.5);
    expect(p.x).toBe(0);
  });
});
```

Add `MAP_RADIUS` to the imports at the top of the test file.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL on both new cases.

- [ ] **Step 3: Update `tickPlayers`**

Replace the body of `tickPlayers` in `packages/shared/src/rules.ts`:

```ts
export function tickPlayers(state: RoomState, dt: number): void {
  if (state.runEnded) return;
  const max2 = MAP_RADIUS * MAP_RADIUS;
  state.players.forEach((p) => {
    if (p.downed) return;
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
    const r2 = p.x * p.x + p.z * p.z;
    if (r2 > max2) {
      const scale = MAP_RADIUS / Math.sqrt(r2);
      p.x *= scale;
      p.z *= scale;
    }
  });
}
```

Add `MAP_RADIUS` to the imports at the top of `rules.ts`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickPlayers clamps to MAP_RADIUS, skips downed"
```

---

### Task 3.3: `tickEnemies` — skip downed for nearest-target + despawn far-wandering

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/test/rules.test.ts`:

```ts
describe("tickEnemies — M6", () => {
  it("treats downed players as non-targets (steps toward living players only)", () => {
    const state = new RoomState();
    const dead = addPlayer(state, "dead", 0, 0); dead.x = 0; dead.z = 0; dead.downed = true;
    const live = addPlayer(state, "live", 0, 0); live.x = 10; live.z = 0;
    const e = addEnemy(state, 1, 1, 0);   // closer to dead
    tickEnemies(state, 0.05);
    // Should step toward live (positive x), not toward dead.
    expect(e.x).toBeGreaterThan(1);
  });

  it("despawns enemies beyond ENEMY_DESPAWN_RADIUS from any non-downed player", () => {
    const state = new RoomState();
    const live = addPlayer(state, "live", 0, 0); live.x = 0; live.z = 0;
    addEnemy(state, 1, 100, 0);   // 100 units away
    tickEnemies(state, 0.05);
    expect(state.enemies.has("1")).toBe(false);
  });

  it("does NOT despawn enemies within ENEMY_DESPAWN_RADIUS", () => {
    const state = new RoomState();
    const live = addPlayer(state, "live", 0, 0); live.x = 0; live.z = 0;
    addEnemy(state, 1, 30, 0);
    tickEnemies(state, 0.05);
    expect(state.enemies.has("1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL on all three cases.

- [ ] **Step 3: Update `tickEnemies`**

Replace `tickEnemies` in `packages/shared/src/rules.ts` with:

```ts
export function tickEnemies(state: RoomState, dt: number): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  const despawnSq = ENEMY_DESPAWN_RADIUS * ENEMY_DESPAWN_RADIUS;
  const toDespawn: number[] = [];

  state.enemies.forEach((enemy: Enemy) => {
    let nearestDx = 0;
    let nearestDz = 0;
    let nearestSq = Infinity;

    state.players.forEach((p: Player) => {
      if (p.downed) return;                    // skip downed for targeting + despawn
      const dx = p.x - enemy.x;
      const dz = p.z - enemy.z;
      const sq = dx * dx + dz * dz;
      if (sq < nearestSq) {
        nearestSq = sq;
        nearestDx = dx;
        nearestDz = dz;
      }
    });

    if (nearestSq === Infinity) return;        // no living players — freeze in place
    if (nearestSq > despawnSq) {
      toDespawn.push(enemy.id);
      return;
    }
    if (nearestSq === 0) return;
    const dist = Math.sqrt(nearestSq);
    const step = ENEMY_SPEED * dt;
    enemy.x += (nearestDx / dist) * step;
    enemy.z += (nearestDz / dist) * step;
  });

  for (const id of toDespawn) state.enemies.delete(String(id));
}
```

Add `ENEMY_DESPAWN_RADIUS` to the imports at the top of `rules.ts`.

> Note: the orbit-cooldown eviction on despawn is intentionally **not** wired here. Orbit cooldown lives server-side (in GameRoom, not in rules), and tickEnemies is pure. The `cooldownSweepCounter` in GameRoom (already running every 100 ticks) is the safety net for orphaned cooldown entries. Adding ctx-threading here would couple rules.ts to a server-only concern; the sweep is sufficient.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickEnemies skips downed targets, despawns far-wanderers"
```

---

### Task 3.4: New `contactCooldown.ts` (mirrors orbitHitCooldown.ts) — TDD

**Files:**
- Create: `packages/server/src/contactCooldown.ts`
- Create: `packages/server/test/contactCooldown.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/test/contactCooldown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createContactCooldownStore } from "../src/contactCooldown.js";

describe("contactCooldown", () => {
  it("first hit succeeds for a new pair", () => {
    const s = createContactCooldownStore();
    expect(s.tryHit("a", 1, 0, 500)).toBe(true);
  });

  it("second hit within cooldown fails", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    expect(s.tryHit("a", 1, 100, 500)).toBe(false);
  });

  it("hit after cooldown elapses succeeds", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    expect(s.tryHit("a", 1, 600, 500)).toBe(true);
  });

  it("evictPlayer drops all entries for that player", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    s.tryHit("a", 2, 0, 500);
    s.tryHit("b", 1, 0, 500);
    s.evictPlayer("a");
    expect(s.tryHit("a", 1, 100, 500)).toBe(true);
    expect(s.tryHit("a", 2, 100, 500)).toBe(true);
    expect(s.tryHit("b", 1, 100, 500)).toBe(false);
  });

  it("evictEnemy drops all entries for that enemy", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    s.tryHit("b", 1, 0, 500);
    s.tryHit("a", 2, 0, 500);
    s.evictEnemy(1);
    expect(s.tryHit("a", 1, 100, 500)).toBe(true);
    expect(s.tryHit("b", 1, 100, 500)).toBe(true);
    expect(s.tryHit("a", 2, 100, 500)).toBe(false);
  });

  it("sweep drops entries older than maxCooldownMs", () => {
    const s = createContactCooldownStore();
    s.tryHit("a", 1, 0, 500);
    s.sweep(1000, 500);
    expect(s.tryHit("a", 1, 1100, 500)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/server test -- contactCooldown`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `contactCooldown.ts`**

Create `packages/server/src/contactCooldown.ts`:

```ts
/**
 * Server-local per-(player, enemy) contact-damage cooldown. Per spec §AD3:
 * not on the schema (clients have no use for this value).
 *
 * Eviction:
 *  - tryHit: lazy, overwrites expired entries on read.
 *  - evictEnemy: called from GameRoom when an enemy dies (parallel path to
 *    orbitHitCooldown.evictEnemy).
 *  - evictPlayer: called from GameRoom.onLeave on schema delete.
 *  - sweep: periodic safety net; drops entries older than the longest
 *    cooldown configured (here just ENEMY_CONTACT_COOLDOWN_S * 1000).
 */
export interface ContactCooldownStore {
  tryHit(playerId: string, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictPlayer(playerId: string): void;
  evictEnemy(enemyId: number): void;
  sweep(nowMs: number, maxCooldownMs: number): void;
}

function key(playerId: string, enemyId: number): string {
  return `${playerId}:${enemyId}`;
}

export function createContactCooldownStore(): ContactCooldownStore {
  const lastHit = new Map<string, number>();

  return {
    tryHit(playerId, enemyId, nowMs, cooldownMs) {
      const k = key(playerId, enemyId);
      const prev = lastHit.get(k);
      if (prev !== undefined && nowMs - prev < cooldownMs) return false;
      lastHit.set(k, nowMs);
      return true;
    },

    evictPlayer(playerId) {
      const prefix = `${playerId}:`;
      for (const k of lastHit.keys()) {
        if (k.startsWith(prefix)) lastHit.delete(k);
      }
    },

    evictEnemy(enemyId) {
      const suffix = `:${enemyId}`;
      for (const k of lastHit.keys()) {
        if (k.endsWith(suffix)) lastHit.delete(k);
      }
    },

    sweep(nowMs, maxCooldownMs) {
      for (const [k, t] of lastHit.entries()) {
        if (nowMs - t >= maxCooldownMs) lastHit.delete(k);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @mp/server test -- contactCooldown`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/contactCooldown.ts packages/server/test/contactCooldown.test.ts
git commit -m "feat(server): contactCooldown store mirroring orbitHitCooldown shape"
```

---

### Task 3.5: New `tickContactDamage` in rules.ts — TDD

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/test/rules.test.ts`:

```ts
function makeFakeContactCooldown() {
  const tryHit = vi.fn().mockReturnValue(true);
  return {
    store: { tryHit, evictEnemy: vi.fn(), evictPlayer: vi.fn(), sweep: vi.fn() },
    tryHit,
  };
}

describe("tickContactDamage", () => {
  it("applies damage when player and enemy overlap and cooldown allows", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 100; p.maxHp = 100;
    p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);   // touching: dist = 0.5 < (PLAYER_RADIUS + ENEMY_RADIUS = 1)
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];
    const emit: Emit = (e) => { events.push(e); };

    tickContactDamage(state, fc.store, 0.05, 0, emit);

    expect(p.hp).toBe(95);
    expect(events.find((e) => e.type === "player_damaged")).toBeDefined();
  });

  it("does not apply damage when cooldown rejects", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 100; p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    fc.tryHit.mockReturnValue(false);
    const events: CombatEvent[] = [];
    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));

    expect(p.hp).toBe(100);
    expect(events.length).toBe(0);
  });

  it("flips downed and emits player_downed when hp crosses 0", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);
    p.hp = 5; p.maxHp = 100; p.x = 0; p.z = 0;
    p.inputDir.x = 1;   // moving when hit
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];

    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));

    expect(p.hp).toBe(0);
    expect(p.downed).toBe(true);
    expect(p.inputDir.x).toBe(0);
    expect(p.inputDir.z).toBe(0);
    expect(events.filter((e) => e.type === "player_damaged").length).toBe(1);
    expect(events.filter((e) => e.type === "player_downed").length).toBe(1);
  });

  it("does not damage already-downed players", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 0; p.downed = true; p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];
    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));
    expect(events.length).toBe(0);
  });

  it("early-outs on runEnded", () => {
    const state = new RoomState();
    state.runEnded = true;
    const p = addPlayer(state, "a", 0, 0);
    p.hp = 100; p.x = 0; p.z = 0;
    addEnemy(state, 1, 0.5, 0);
    const fc = makeFakeContactCooldown();
    const events: CombatEvent[] = [];
    tickContactDamage(state, fc.store, 0.05, 0, (e) => events.push(e));
    expect(p.hp).toBe(100);
    expect(events.length).toBe(0);
  });
});
```

Add `vi` to the vitest import at the top of the test file: `import { describe, it, expect, vi } from "vitest";`. Add `tickContactDamage` to the rules import. Add `ContactCooldownLike` to the rules import.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL — `tickContactDamage` is not exported.

- [ ] **Step 3: Add `ContactCooldownLike` interface and `tickContactDamage` to `rules.ts`**

In `packages/shared/src/rules.ts`, after the existing `OrbitHitCooldownLike` interface, add:

```ts
/**
 * Server-supplied per-(player, enemy) contact-damage cooldown. Structural —
 * the concrete implementation lives in server/src/contactCooldown.ts.
 */
export interface ContactCooldownLike {
  tryHit(playerId: string, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
  evictPlayer(playerId: string): void;
  sweep(nowMs: number, maxCooldownMs: number): void;
}
```

Then add the new tick function at the end of the file:

```ts
/**
 * For each non-downed player, find every enemy whose center-to-center
 * distance is within (PLAYER_RADIUS + ENEMY_RADIUS). Each touching pair
 * tries to hit through `cooldown.tryHit(...)`; on success, apply
 * ENEMY_CONTACT_DAMAGE, emit `player_damaged`, and (if hp crosses 0) flip
 * `downed` + zero inputDir + emit `player_downed`.
 *
 * `nowMs` is the server's wall-clock; the cooldown store is the only
 * consumer of it. Determinism: outcomes (damage, downed) depend on the
 * cooldown decision, which depends on wall-clock — same pattern as orbit
 * hits in tickWeapons. Clients don't run this function, so cross-client
 * divergence is impossible by construction (server is authoritative).
 */
export function tickContactDamage(
  state: RoomState,
  cooldown: ContactCooldownLike,
  _dt: number,
  nowMs: number,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const cooldownMs = ENEMY_CONTACT_COOLDOWN_S * 1000;
  const radiusSum = PLAYER_RADIUS + ENEMY_RADIUS;
  const radiusSumSq = radiusSum * radiusSum;

  state.players.forEach((player: Player) => {
    if (player.downed) return;

    state.enemies.forEach((enemy: Enemy) => {
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      if (dx * dx + dz * dz > radiusSumSq) return;
      if (!cooldown.tryHit(player.sessionId, enemy.id, nowMs, cooldownMs)) return;

      const damage = Math.min(player.hp, ENEMY_CONTACT_DAMAGE);
      player.hp -= damage;
      emit({
        type: "player_damaged",
        playerId: player.sessionId,
        damage,
        x: player.x,
        z: player.z,
        serverTick: state.tick,
      });

      if (player.hp <= 0 && !player.downed) {
        player.downed = true;
        player.inputDir.x = 0;
        player.inputDir.z = 0;
        emit({
          type: "player_downed",
          playerId: player.sessionId,
          serverTick: state.tick,
        });
      }
    });
  });
}
```

Add `ENEMY_CONTACT_COOLDOWN_S` and `PLAYER_RADIUS` to the imports at the top of `rules.ts`. Also add `PlayerDamagedEvent`, `PlayerDownedEvent`, `RunEndedEvent` to the messages import; extend `CombatEvent` union to include all three.

The `CombatEvent` union update:

```ts
export type CombatEvent =
  | FireEvent
  | HitEvent
  | EnemyDiedEvent
  | GemCollectedEvent
  | LevelUpOfferedEvent
  | LevelUpResolvedEvent
  | PlayerDamagedEvent
  | PlayerDownedEvent
  | RunEndedEvent;
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS (5 new cases).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickContactDamage + ContactCooldownLike + CombatEvent additions"
```

---

### Task 3.6: New `tickRunEndCheck` in rules.ts — TDD

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `rules.test.ts`:

```ts
describe("tickRunEndCheck", () => {
  it("flips runEnded only when all players are downed", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 0, 0); a.downed = true;
    const b = addPlayer(state, "b", 0, 0); b.downed = false;
    const events: CombatEvent[] = [];
    tickRunEndCheck(state, (e) => events.push(e));
    expect(state.runEnded).toBe(false);
    expect(events.length).toBe(0);

    b.downed = true;
    tickRunEndCheck(state, (e) => events.push(e));
    expect(state.runEnded).toBe(true);
    expect(state.runEndedTick).toBe(state.tick);
    expect(events.filter((e) => e.type === "run_ended").length).toBe(1);
  });

  it("does not fire on empty room", () => {
    const state = new RoomState();
    const events: CombatEvent[] = [];
    tickRunEndCheck(state, (e) => events.push(e));
    expect(state.runEnded).toBe(false);
    expect(events.length).toBe(0);
  });

  it("fires only once across multiple ticks", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 0, 0); a.downed = true;
    const events: CombatEvent[] = [];
    tickRunEndCheck(state, (e) => events.push(e));
    tickRunEndCheck(state, (e) => events.push(e));
    expect(events.filter((e) => e.type === "run_ended").length).toBe(1);
  });
});
```

Add `tickRunEndCheck` to the rules import.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL — `tickRunEndCheck` is not exported.

- [ ] **Step 3: Implement `tickRunEndCheck`**

Append to `packages/shared/src/rules.ts`:

```ts
/**
 * If every player is downed, set state.runEnded=true, snapshot
 * state.runEndedTick, and emit `run_ended`. No-op on empty room or if
 * runEnded is already true.
 */
export function tickRunEndCheck(state: RoomState, emit: Emit): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  let allDowned = true;
  state.players.forEach((p: Player) => {
    if (!p.downed) allDowned = false;
  });
  if (!allDowned) return;

  state.runEnded = true;
  state.runEndedTick = state.tick;
  emit({ type: "run_ended", serverTick: state.tick });
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickRunEndCheck — flips runEnded when all players downed"
```

---

### Task 3.7: `tickWeapons` — skip downed + kills bookkeeping

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `rules.test.ts`:

```ts
describe("tickWeapons — M6", () => {
  it("skips downed players entirely (no fire emitted, no cooldown decrement)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.downed = true;
    const w = new WeaponState();
    w.kind = 0; w.level = 1; w.cooldownRemaining = 0;
    p.weapons.push(w);
    addEnemy(state, 1, 5, 0);
    const events: CombatEvent[] = [];
    const ctx: WeaponContext = {
      nextFireId: () => 1,
      serverNowMs: () => 0,
      pushProjectile: () => {},
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    tickWeapons(state, 0.05, ctx, (e) => events.push(e));
    expect(events.find((e) => e.type === "fire")).toBeUndefined();
    expect(w.cooldownRemaining).toBe(0);
  });

  it("increments owner.kills on orbit-killing-blow", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);
    p.x = 0; p.z = 0;
    const w = new WeaponState();
    w.kind = 1; w.level = 1; w.cooldownRemaining = 0;   // orbit
    p.weapons.push(w);
    const e = addEnemy(state, 1, 0.3, 0);
    e.hp = 1;   // dies in one orbit hit
    const ctx: WeaponContext = {
      nextFireId: () => 1,
      serverNowMs: () => 0,
      pushProjectile: () => {},
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    tickWeapons(state, 0.05, ctx, () => {});
    expect(p.kills).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL — current `tickWeapons` ticks downed players' cooldowns and doesn't increment kills.

- [ ] **Step 3: Update `tickWeapons`**

In `packages/shared/src/rules.ts`, inside `tickWeapons`, immediately after `if (state.runEnded) return;` (added in Task 3.1) add:

```ts
  state.players.forEach((player: Player) => {
    if (player.downed) return;                 // M6 — downed players don't fire
    // ... existing per-player loop body ...
  });
```

That is, wrap the existing forEach body's first line with the downed check.

Within the orbit `case "orbit":` arm, immediately after the existing `state.enemies.delete(String(enemy.id));` line (the schema removal on death), and before `ctx.orbitHitCooldown.evictEnemy(deathId);`, add:

```ts
              player.kills += 1;
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickWeapons skips downed + increments kills on orbit-kill"
```

---

### Task 3.8: `tickProjectiles` — kills bookkeeping (projectile owner credit)

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `rules.test.ts`:

```ts
describe("tickProjectiles — M6 kills", () => {
  it("credits owner.kills when a projectile kills an enemy", () => {
    const state = new RoomState();
    const owner = addPlayer(state, "owner", 0, 0); owner.x = 0; owner.z = 0;
    const e = addEnemy(state, 1, 1, 0); e.hp = 1;
    const projectiles: Projectile[] = [{
      fireId: 1, ownerId: "owner", weaponKind: 0,
      damage: 10, speed: 20, radius: 0.4, lifetime: 1,
      age: 0, dirX: 1, dirZ: 0,
      prevX: 0, prevZ: 0, x: 0, z: 0,
    }];
    const ctx: ProjectileContext = {
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    tickProjectiles(state, projectiles, 0.05, ctx, () => {});
    expect(owner.kills).toBe(1);
  });

  it("does not crash when projectile owner has left", () => {
    const state = new RoomState();
    addEnemy(state, 1, 1, 0).hp = 1;
    const projectiles: Projectile[] = [{
      fireId: 1, ownerId: "ghost", weaponKind: 0,
      damage: 10, speed: 20, radius: 0.4, lifetime: 1,
      age: 0, dirX: 1, dirZ: 0,
      prevX: 0, prevZ: 0, x: 0, z: 0,
    }];
    const ctx: ProjectileContext = {
      nextGemId: () => 1,
      orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} },
    };
    expect(() => tickProjectiles(state, projectiles, 0.05, ctx, () => {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL on the kills assertion.

- [ ] **Step 3: Update `tickProjectiles`**

In `packages/shared/src/rules.ts`, inside `tickProjectiles`, on the `if (hitEnemy.hp <= 0) { ... }` death path, immediately before `state.enemies.delete(String(hitEnemy.id));` add:

```ts
        const owner = state.players.get(proj.ownerId);
        if (owner) owner.kills += 1;
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickProjectiles credits owner.kills on lethal hit"
```

---

### Task 3.9: `tickGems` — xpGained bookkeeping

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `rules.test.ts`:

```ts
describe("tickGems — M6", () => {
  it("increments xpGained alongside xp on collect", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.x = 0; p.z = 0; p.xp = 0; p.xpGained = 0;
    const g = new Gem(); g.id = 1; g.x = 0; g.z = 0; g.value = 5;
    state.gems.set("1", g);
    tickGems(state, () => {});
    expect(p.xp).toBe(5);
    expect(p.xpGained).toBe(5);
  });

  it("xpGained is monotone (never drained when xp is)", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.x = 0; p.z = 0; p.xp = 0; p.xpGained = 0;
    const g1 = new Gem(); g1.id = 1; g1.x = 0; g1.z = 0; g1.value = 10;
    state.gems.set("1", g1);
    tickGems(state, () => {});
    p.xp = 0;   // simulate level-up drain
    const g2 = new Gem(); g2.id = 2; g2.x = 0; g2.z = 0; g2.value = 4;
    state.gems.set("2", g2);
    tickGems(state, () => {});
    expect(p.xp).toBe(4);
    expect(p.xpGained).toBe(14);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL.

- [ ] **Step 3: Update `tickGems`**

In `tickGems` in `packages/shared/src/rules.ts`, immediately after `collector.xp += gem.value;` add:

```ts
    collector.xpGained += gem.value;
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickGems increments lifetime xpGained alongside xp"
```

---

### Task 3.10: `tickSpawner` — skip downed targets + retry-3 spawn clamp

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `rules.test.ts`:

```ts
describe("tickSpawner — M6", () => {
  it("does not target downed players when picking a spawn anchor", () => {
    const state = new RoomState();
    const dead = addPlayer(state, "dead", 0, 0); dead.downed = true; dead.x = 1000; dead.z = 1000;
    const live = addPlayer(state, "live", 0, 0); live.x = 0; live.z = 0;
    const spawner: SpawnerState = { accumulator: ENEMY_SPAWN_INTERVAL_S, nextEnemyId: 1 };
    const rng = mulberry32(7);
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, rng);
    // The new enemy must be near the live player, not within 1000 units of dead.
    const e = Array.from(state.enemies.values())[0]!;
    expect(Math.hypot(e.x - live.x, e.z - live.z)).toBeLessThanOrEqual(ENEMY_SPAWN_RADIUS + 1);
  });

  it("skips spawn when 3 retries all land outside MAP_RADIUS", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0); p.x = 59.9; p.z = 0;
    const spawner: SpawnerState = { accumulator: ENEMY_SPAWN_INTERVAL_S, nextEnemyId: 1 };
    // Most angles around p at radius 30 land outside MAP_RADIUS=60.
    // We assert the enemies count is either 0 (all retries failed) or 1 (one retry succeeded with right angle).
    const before = state.enemies.size;
    tickSpawner(state, spawner, ENEMY_SPAWN_INTERVAL_S, mulberry32(1));
    const after = state.enemies.size;
    expect(after - before).toBeLessThanOrEqual(1);
    if (after - before === 1) {
      const e = Array.from(state.enemies.values()).pop()!;
      expect(Math.hypot(e.x, e.z)).toBeLessThanOrEqual(MAP_RADIUS + 1e-6);
    }
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: FAIL on at least the first case.

- [ ] **Step 3: Update `tickSpawner`**

Replace the body of `tickSpawner` in `packages/shared/src/rules.ts` with:

```ts
export function tickSpawner(
  state: RoomState,
  spawner: SpawnerState,
  dt: number,
  rng: Rng,
): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  // Count non-downed players; bail if all are downed (run will end this tick anyway).
  let liveCount = 0;
  state.players.forEach((p) => { if (!p.downed) liveCount += 1; });
  if (liveCount === 0) return;

  spawner.accumulator += dt;
  const map2 = MAP_RADIUS * MAP_RADIUS;

  while (spawner.accumulator >= ENEMY_SPAWN_INTERVAL_S) {
    if (state.enemies.size >= MAX_ENEMIES) {
      spawner.accumulator = 0;
      return;
    }

    // Pick a random non-downed player.
    const liveIdx = Math.floor(rng() * liveCount);
    let i = 0;
    let target: Player | undefined;
    state.players.forEach((p) => {
      if (p.downed) return;
      if (i === liveIdx) target = p;
      i++;
    });
    if (!target) {
      throw new Error(
        `tickSpawner: unreachable — liveIdx=${liveIdx} out of range for liveCount=${liveCount}`,
      );
    }

    // Try up to 3 angles to land inside MAP_RADIUS; skip this slot if all fail.
    let placed = false;
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      const angle = rng() * Math.PI * 2;
      const x = target.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
      const z = target.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
      if (x * x + z * z > map2) continue;
      const enemy = new Enemy();
      enemy.id = spawner.nextEnemyId++;
      enemy.kind = 0;
      enemy.x = x;
      enemy.z = z;
      enemy.hp = ENEMY_HP;
      state.enemies.set(String(enemy.id), enemy);
      placed = true;
    }

    spawner.accumulator -= ENEMY_SPAWN_INTERVAL_S;
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @mp/shared test -- rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickSpawner skips downed targets + retry-3 spawn clamp"
```

---

## Phase 4 — Server tick wiring + reconnect test

### Task 4.1: Wire `tickContactDamage` and `tickRunEndCheck` into GameRoom.tick()

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Import the new tick functions and constants**

In the `import { ... } from "@mp/shared"` block at the top of `GameRoom.ts`, add `tickContactDamage`, `tickRunEndCheck`, `ENEMY_CONTACT_COOLDOWN_S`. Also add `type ContactCooldownLike` to the type imports.

- [ ] **Step 2: Import `createContactCooldownStore`**

Replace the existing orbit-only import with:

```ts
import {
  createOrbitHitCooldownStore,
  maxOrbitHitCooldownMs,
  type OrbitHitCooldownStore,
} from "./orbitHitCooldown.js";
import {
  createContactCooldownStore,
  type ContactCooldownStore,
} from "./contactCooldown.js";
```

- [ ] **Step 3: Add a `contactCooldown` field**

In the `GameRoom` class body, immediately after the `private orbitHitCooldown!: OrbitHitCooldownStore;` line add:

```ts
  private contactCooldown!: ContactCooldownStore;
```

- [ ] **Step 4: Initialize it in `onCreate`**

After the `this.orbitHitCooldown = createOrbitHitCooldownStore();` line, add:

```ts
    this.contactCooldown = createContactCooldownStore();
```

- [ ] **Step 5: Wire the two new tick functions**

Replace the body of `private tick(): void` with:

```ts
  private tick(): void {
    this.state.tick += 1;
    // M6: tickContactDamage after tickEnemies sees fresh positions; tickRunEndCheck
    // immediately after so weapons/projectiles/spawner all observe the post-end
    // state via their `state.runEnded` early-out.
    tickPlayers(this.state, SIM_DT_S);
    tickEnemies(this.state, SIM_DT_S);
    tickContactDamage(this.state, this.contactCooldown, SIM_DT_S, Date.now(), this.emit);
    tickRunEndCheck(this.state, this.emit);
    tickWeapons(this.state, SIM_DT_S, this.weaponCtx, this.emit);
    tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S, this.projectileCtx, this.emit);
    tickGems(this.state, this.emit);
    tickXp(this.state, this.rng, this.emit);
    tickLevelUpDeadlines(this.state, this.emit);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);

    this.cooldownSweepCounter += 1;
    if (this.cooldownSweepCounter >= ORBIT_COOLDOWN_SWEEP_INTERVAL_TICKS) {
      this.cooldownSweepCounter = 0;
      const now = Date.now();
      this.orbitHitCooldown.sweep(now, this.maxOrbitHitCooldownMs);
      this.contactCooldown.sweep(now, ENEMY_CONTACT_COOLDOWN_S * 1000);
    }
  }
```

- [ ] **Step 6: Evict contact cooldowns on player leave**

In `onLeave`, in BOTH the `if (consented) { ... }` branch and the post-grace error branch, immediately after the `this.orbitHitCooldown.evictPlayer(client.sessionId);` line add:

```ts
      this.contactCooldown.evictPlayer(client.sessionId);
```

(There are two evict sites in `onLeave` — both need the parallel call.)

- [ ] **Step 7: Run server tests**

Run: `pnpm --filter @mp/server test`
Expected: PASS for the existing suite (no regressions).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "feat(server): wire tickContactDamage + tickRunEndCheck into tick()"
```

---

### Task 4.2: Add downed-survives-reconnect test

**Files:**
- Modify: `packages/server/test/reconnect.test.ts`

- [ ] **Step 1: Append a new `it(...)` test inside the existing `describe("integration: reconnection grace", ...)` block**

In `packages/server/test/reconnect.test.ts`, immediately after the closing `});` of the existing `it("removes the Player when the grace window expires", ...)` test (and before the closing `});` of the `describe` block), insert:

```ts
it("downed state and recap fields survive reconnection within grace window", async () => {
  const client = new Client(`ws://localhost:${PORT}`);
  const room = await client.create<any>("game", { name: "Down" });
  await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

  const sessionId = room.sessionId;
  const token = room.reconnectionToken;

  // Drop the player to 0 hp via the debug message; tickContactDamage isn't
  // running (no enemies in contact), so this is the deterministic path.
  // The handler emits player_damaged + player_downed and sets downed=true.
  room.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });

  await waitFor(() => {
    const me = room.state.players.get(sessionId);
    return !!me && me.downed === true && me.hp === 0;
  }, 1500);

  // Force-close transport and reconnect within the (overridden 1s) grace.
  (room as any).connection.transport.close();
  await new Promise((r) => setTimeout(r, 100));

  const resumed = await client.reconnect<any>(token);
  await waitFor(() => resumed.state.code !== "" && resumed.state.code != null, 1500);

  expect(resumed.sessionId).toBe(sessionId);
  const meAfter = resumed.state.players.get(sessionId)!;
  expect(meAfter.downed).toBe(true);
  expect(meAfter.hp).toBe(0);
  // joinTick should be the same value as before disconnect (it's set once in onJoin
  // and not touched on reconnect).
  expect(meAfter.joinTick).toBeGreaterThanOrEqual(0);
  // kills and xpGained are zero in this test because no kills happened, but
  // we assert they persist as schema fields (not `undefined`).
  expect(meAfter.kills).toBe(0);
  expect(meAfter.xpGained).toBe(0);

  await resumed.leave();
}, 5000);
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @mp/server test -- reconnect`
Expected: PASS for both existing tests AND the new downed-reconnect test.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/reconnect.test.ts
git commit -m "test(server): downed state + recap fields survive reconnection within grace"
```

---

### Task 4.3: Add end-to-end damage → down → run-end integration test

**Files:**
- Modify: `packages/server/test/integration.test.ts`

- [ ] **Step 1: Append a new `describe` block at the end of `integration.test.ts`**

```ts
describe("integration: M6 player_damaged → player_downed → run_ended", () => {
  it("solo room: damage chain reaches client; downed flag flips; runEnded broadcasts", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type RoomShape = {
      code: string;
      runEnded: boolean;
      players: { get: (sid: string) => { hp: number; downed: boolean } | undefined };
    };
    const room = await client.create<RoomShape>("game", { name: "Solo" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    type Damaged = { playerId: string; damage: number };
    type Downed = { playerId: string };
    type Ended = { serverTick: number };

    const damages: Damaged[] = [];
    let downedFor: string | null = null;
    let runEndedSeen = false;

    room.onMessage("player_damaged", (msg: Damaged) => damages.push(msg));
    room.onMessage("player_downed", (msg: Downed) => { downedFor = msg.playerId; });
    room.onMessage("run_ended", (_msg: Ended) => { runEndedSeen = true; });

    // Drop hp to zero via the debug message. The handler emits player_damaged +
    // player_downed, sets downed=true. tickRunEndCheck on the next tick flips
    // state.runEnded and emits run_ended (single-player room → all-downed).
    room.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });

    await waitFor(() => damages.length >= 1, 1500);
    expect(damages[0]!.playerId).toBe(room.sessionId);
    expect(damages[0]!.damage).toBe(100);

    await waitFor(() => downedFor === room.sessionId, 1500);
    const me = room.state.players.get(room.sessionId);
    expect(me?.downed).toBe(true);
    expect(me?.hp).toBe(0);

    await waitFor(() => runEndedSeen, 1500);
    expect(room.state.runEnded).toBe(true);

    await room.leave();
  }, 8000);

  it("two-client room: damaging one client does NOT end the run; both go down does", async () => {
    const a = new Client(`ws://localhost:${PORT}`);
    const b = new Client(`ws://localhost:${PORT}`);

    type RoomShape = {
      code: string;
      runEnded: boolean;
      players: {
        get: (sid: string) => { hp: number; downed: boolean } | undefined;
        forEach: (cb: (p: { sessionId: string; downed: boolean }) => void) => void;
        size: number;
      };
    };
    const roomA = await a.create<RoomShape>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);

    const roomB = await b.join<RoomShape>("game", { code: roomA.state.code, name: "Bob" });
    await waitFor(() => roomA.state.players.size === 2 && roomB.state.players.size === 2, 1500);

    let runEndedAtA = false;
    let runEndedAtB = false;
    roomA.onMessage("run_ended", () => { runEndedAtA = true; });
    roomB.onMessage("run_ended", () => { runEndedAtB = true; });

    // Down Alice. Run should NOT end (Bob is still up).
    roomA.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });
    await waitFor(
      () => roomA.state.players.get(roomA.sessionId)?.downed === true,
      1500,
    );
    // Give the next tick a chance to potentially fire run_ended (it must not).
    await new Promise((r) => setTimeout(r, 200));
    expect(runEndedAtA).toBe(false);
    expect(runEndedAtB).toBe(false);
    expect(roomA.state.runEnded).toBe(false);

    // Down Bob. Run ends at the next tick.
    roomB.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });
    await waitFor(() => runEndedAtA && runEndedAtB, 2000);
    expect(roomA.state.runEnded).toBe(true);
    expect(roomB.state.runEnded).toBe(true);

    await roomB.leave();
    await roomA.leave();
  }, 12000);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @mp/server test -- integration`
Expected: PASS for the existing suite AND the two new M6 tests. Encoder must remain consistent.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/integration.test.ts
git commit -m "test(server): end-to-end player_damaged → downed → run_ended (solo + two-client)"
```

---

## Phase 5 — Client camera, input, and world rendering

### Task 5.1: Mouse-aim input + send `facing` in 20Hz step

**Files:**
- Modify: `packages/client/src/game/input.ts`

- [ ] **Step 1: Replace `attachInput` and add `getLiveFacing`**

Open `packages/client/src/game/input.ts` and replace its contents with:

```ts
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Raycaster, Vector2, Vector3, Plane, type PerspectiveCamera } from "three";
import { LocalPredictor, STEP_INTERVAL_MS } from "../net/prediction.js";

const KEYS = { w: false, a: false, s: false, d: false };

const CODE_TO_KEY: Record<string, "w" | "a" | "s" | "d"> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
};

// Mouse NDC, updated by a window mousemove listener.
let mouseNdcX = 0;
let mouseNdcY = 0;
let mouseEverMoved = false;

// Re-used to avoid per-frame allocations.
const _ray = new Raycaster();
const _ndc = new Vector2();
const _hit = new Vector3();
const _plane = new Plane(new Vector3(0, 1, 0), 0);   // y=0 ground plane

function computeDir(): { x: number; z: number } {
  let x = 0, z = 0;
  if (KEYS.w) z -= 1;
  if (KEYS.s) z += 1;
  if (KEYS.a) x -= 1;
  if (KEYS.d) x += 1;
  const len = Math.hypot(x, z);
  if (len > 0) { x /= len; z /= len; }
  return { x, z };
}

export function getLiveInputDir(): { x: number; z: number } {
  return computeDir();
}

/**
 * Compute facing as a unit vector from `(playerX, playerZ)` toward the
 * mouse-raycast point on the y=0 plane. Returns `(0, 1)` if the mouse
 * has never moved or the ray fails to intersect.
 */
export function getLiveFacing(
  camera: PerspectiveCamera,
  playerX: number,
  playerZ: number,
): { x: number; z: number } {
  if (!mouseEverMoved) return { x: 0, z: 1 };
  _ndc.set(mouseNdcX, mouseNdcY);
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return { x: 0, z: 1 };
  const dx = _hit.x - playerX;
  const dz = _hit.z - playerZ;
  const len = Math.hypot(dx, dz);
  if (len === 0) return { x: 0, z: 1 };
  return { x: dx / len, z: dz / len };
}

/**
 * Most-recent mouse-raycast ground point, or null if the mouse has never
 * moved. Used by Crosshair to position the in-world reticle.
 */
export function getLiveCrosshairPoint(camera: PerspectiveCamera): { x: number; z: number } | null {
  if (!mouseEverMoved) return null;
  _ndc.set(mouseNdcX, mouseNdcY);
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
  return { x: _hit.x, z: _hit.z };
}

export function attachInput(
  room: Room<RoomState>,
  predictor: LocalPredictor,
  getCamera: () => PerspectiveCamera | null,
  getLocalPos: () => { x: number; z: number },
): () => void {
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === down) return;
    KEYS[k] = down;
  };
  const onMouseMove = (e: MouseEvent) => {
    mouseNdcX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseNdcY = -((e.clientY / window.innerHeight) * 2 - 1);
    mouseEverMoved = true;
  };

  const downHandler = onKey(true);
  const upHandler = onKey(false);
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);
  window.addEventListener("mousemove", onMouseMove);

  const send = (msg: {
    type: "input"; seq: number;
    dir: { x: number; z: number };
    facing: { x: number; z: number };
  }) => { room.send("input", msg); };

  const stepTimer = window.setInterval(() => {
    const cam = getCamera();
    const pos = getLocalPos();
    const facing = cam
      ? getLiveFacing(cam, pos.x, pos.z)
      : { x: 0, z: 1 };
    predictor.step(computeDir(), (msgWithoutFacing) => {
      send({ ...msgWithoutFacing, facing });
    });
  }, STEP_INTERVAL_MS);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.removeEventListener("mousemove", onMouseMove);
    window.clearInterval(stepTimer);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
    mouseEverMoved = false;
  };
}
```

- [ ] **Step 2: Verify type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/input.ts
git commit -m "feat(client): mouse-aim raycast + send facing in 20Hz input step"
```

---

### Task 5.2: New `<CameraRig>` (lerp-follow + spectator switching)

**Files:**
- Create: `packages/client/src/game/CameraRig.tsx`

- [ ] **Step 1: Create `CameraRig.tsx`**

```tsx
import { useFrame, useThree } from "@react-three/fiber";
import type { Room } from "colyseus.js";
import { useRef } from "react";
import type { PerspectiveCamera } from "three";
import type { Player, RoomState } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const OFFSET_X = 0;
const OFFSET_Y = 9;
const OFFSET_Z = 11;
const LERP_TAU_S = 0.15;

type Props = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * Lerp-follow camera positioned at OFFSET above-and-behind the local player.
 * Spectator-mode: when local player is downed, target switches to the first
 * non-downed remote player (MapSchema iteration order — per-client local
 * presentation, deterministic-across-clients not required).
 */
export function CameraRig({ room, predictor, buffers }: Props) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const lookAt = useRef({ x: 0, y: 0.5, z: 0 });

  useFrame((_, dt) => {
    const local = room.state.players.get(room.sessionId);
    let tx = predictor.renderX;
    let tz = predictor.renderZ;

    if (local?.downed) {
      let chosen: Player | null = null;
      room.state.players.forEach((p) => {
        if (chosen) return;
        if (p.sessionId === room.sessionId) return;
        if (!p.downed) chosen = p;
      });
      if (chosen) {
        const buf = buffers.get((chosen as Player).sessionId);
        const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
        if (sample) { tx = sample.x; tz = sample.z; }
      }
    }

    const factor = 1 - Math.exp(-dt / LERP_TAU_S);
    camera.position.x += (tx + OFFSET_X - camera.position.x) * factor;
    camera.position.y += (OFFSET_Y - camera.position.y) * factor;
    camera.position.z += (tz + OFFSET_Z - camera.position.z) * factor;

    lookAt.current.x += (tx - lookAt.current.x) * factor;
    lookAt.current.z += (tz - lookAt.current.z) * factor;
    camera.lookAt(lookAt.current.x, lookAt.current.y, lookAt.current.z);
  });

  return null;
}
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/CameraRig.tsx
git commit -m "feat(client): CameraRig — lerp-follow + spectator-mode switching"
```

---

### Task 5.3: New `<Crosshair>` (in-world reticle)

**Files:**
- Create: `packages/client/src/game/Crosshair.tsx`

- [ ] **Step 1: Create `Crosshair.tsx`**

```tsx
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import type { Mesh, PerspectiveCamera } from "three";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { getLiveCrosshairPoint } from "./input.js";

type Props = { room: Room<RoomState> };

/**
 * In-world ground reticle at the mouse-raycast point on y=0. Hidden when
 * the local player is downed (their facing isn't being processed by the
 * server, so the visible reticle would be misleading). Reads downed
 * directly from `room.state.players` each frame — this avoids the
 * ref-vs-state hazard where a parent's mutable ref wouldn't trigger a
 * re-render.
 */
export function Crosshair({ room }: Props) {
  const ref = useRef<Mesh>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;

  useFrame(() => {
    if (!ref.current) return;
    const localPlayer = room.state.players.get(room.sessionId);
    if (localPlayer?.downed) {
      ref.current.visible = false;
      return;
    }
    const pt = getLiveCrosshairPoint(camera);
    if (!pt) {
      ref.current.visible = false;
      return;
    }
    ref.current.visible = true;
    ref.current.position.set(pt.x, 0.01, pt.z);
  });

  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.4, 0.5, 32]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
    </mesh>
  );
}
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/Crosshair.tsx
git commit -m "feat(client): Crosshair — in-world reticle at mouse-raycast point"
```

---

### Task 5.4: New `<BoundaryRing>` + resize `<Ground>`

**Files:**
- Create: `packages/client/src/game/BoundaryRing.tsx`
- Modify: `packages/client/src/game/Ground.tsx`

- [ ] **Step 1: Create `BoundaryRing.tsx`**

```tsx
import { MAP_RADIUS } from "@mp/shared";

export function BoundaryRing() {
  return (
    <mesh rotation-x={Math.PI / 2}>
      <torusGeometry args={[MAP_RADIUS, 0.05, 8, 128]} />
      <meshStandardMaterial
        color="#5a8aff"
        emissive="#5a8aff"
        emissiveIntensity={0.4}
      />
    </mesh>
  );
}
```

- [ ] **Step 2: Resize `Ground.tsx`**

Replace `packages/client/src/game/Ground.tsx`:

```tsx
import { MAP_RADIUS } from "@mp/shared";

const GROUND_SIZE = MAP_RADIUS * 2.2;

export function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
      <meshStandardMaterial color="#2c3e50" />
    </mesh>
  );
}
```

- [ ] **Step 3: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/BoundaryRing.tsx packages/client/src/game/Ground.tsx
git commit -m "feat(client): BoundaryRing at MAP_RADIUS + ground sized to 2.2× MAP_RADIUS"
```

---

### Task 5.5: `<PlayerCube>` — facing rotation, nose, downed visual, billboard

**Files:**
- Modify: `packages/client/src/game/PlayerCube.tsx`

- [ ] **Step 1: Read the current file**

Run: `wc -l packages/client/src/game/PlayerCube.tsx` to confirm size before editing.

- [ ] **Step 2: Replace `PlayerCube.tsx`**

Replace the file with:

```tsx
import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Mesh, Group } from "three";
import type { Room } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import { PLAYER_SPEED } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import {
  STEP_INTERVAL_MS,
  SMOOTHING_TAU_S,
  type LocalPredictor,
} from "../net/prediction.js";
import { getLiveInputDir, getLiveFacing } from "./input.js";
import { useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

const STEP_INTERVAL_S = STEP_INTERVAL_MS / 1000;
const RENDER_Y = 0.5;
const DOWN_COLOR = "#6a6a6a";

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function localPlayerRenderPos(predictor: LocalPredictor, delta: number): { x: number; z: number } {
  const decay = Math.exp(-delta / SMOOTHING_TAU_S);
  predictor.renderOffset.x *= decay;
  predictor.renderOffset.z *= decay;
  const tSinceStep = Math.min((performance.now() - predictor.lastStepTime) / 1000, STEP_INTERVAL_S);
  const liveDir = getLiveInputDir();
  if (!Number.isNaN(predictor.lastLiveDirX)) {
    const jumpX = (liveDir.x - predictor.lastLiveDirX) * PLAYER_SPEED * tSinceStep;
    const jumpZ = (liveDir.z - predictor.lastLiveDirZ) * PLAYER_SPEED * tSinceStep;
    predictor.renderOffset.x -= jumpX;
    predictor.renderOffset.z -= jumpZ;
  }
  predictor.lastLiveDirX = liveDir.x;
  predictor.lastLiveDirZ = liveDir.z;
  return {
    x: predictor.predictedX + liveDir.x * PLAYER_SPEED * tSinceStep + predictor.renderOffset.x,
    z: predictor.predictedZ + liveDir.z * PLAYER_SPEED * tSinceStep + predictor.renderOffset.z,
  };
}

export type PlayerCubeProps = {
  room: Room<RoomState>;
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
  predictor?: LocalPredictor;
};

export function PlayerCube({ room, sessionId, name, buffer, predictor }: PlayerCubeProps) {
  const groupRef = useRef<Group>(null);
  const cubeRef = useRef<Mesh>(null);
  const matRef = useRef<{ color: { set: (c: string) => void } } | null>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const baseColor = useMemo(() => colorFor(sessionId), [sessionId]);

  const [hp, setHp] = useState<number>(100);
  const [maxHp, setMaxHp] = useState<number>(100);
  const [downed, setDowned] = useState<boolean>(false);

  useEffect(() => {
    const player = room.state.players.get(sessionId);
    if (!player) return;
    setHp(player.hp);
    setMaxHp(player.maxHp);
    setDowned(player.downed);
    // The change listener already wired by GameView covers per-player updates;
    // we read fresh values from `room.state.players` in useFrame below to stay
    // in sync without coupling another listener here.
  }, [room, sessionId]);

  useFrame((_, delta) => {
    if (!groupRef.current || !cubeRef.current) return;

    const player = room.state.players.get(sessionId);
    const isDowned = !!player?.downed;
    if (isDowned !== downed) setDowned(isDowned);
    if (player) {
      if (player.hp !== hp) setHp(player.hp);
      if (player.maxHp !== maxHp) setMaxHp(player.maxHp);
    }

    let posX: number, posZ: number;
    if (predictor) {
      const pos = localPlayerRenderPos(predictor, delta);
      posX = pos.x; posZ = pos.z;
      predictor.renderX = pos.x;
      predictor.renderZ = pos.z;
    } else {
      const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
      if (!sample) return;
      posX = sample.x; posZ = sample.z;
    }

    groupRef.current.position.set(posX, RENDER_Y, posZ);

    let facingX = 0, facingZ = 1;
    if (predictor) {
      const f = getLiveFacing(camera, posX, posZ);
      facingX = f.x; facingZ = f.z;
    } else if (player) {
      facingX = player.facingX; facingZ = player.facingZ;
    }

    cubeRef.current.rotation.y = Math.atan2(facingX, facingZ);
    cubeRef.current.rotation.x = isDowned ? Math.PI / 2 : 0;
  });

  // Color update on downed change — accessing material via cubeRef. The
  // initial color is set on mount via the JSX prop; subsequent changes use
  // material.color.set in this effect.
  useEffect(() => {
    const m = cubeRef.current?.material as unknown as { color: { set: (c: string) => void } } | undefined;
    if (m) m.color.set(downed ? DOWN_COLOR : baseColor);
  }, [downed, baseColor]);

  const isLocal = !!predictor;
  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  return (
    <group ref={groupRef}>
      <mesh ref={cubeRef} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={baseColor} />
        {/* Nose — child mesh in cube's local space, sticking out along +Z */}
        <mesh position={[0, 0, 0.7]}>
          <boxGeometry args={[0.2, 0.2, 0.6]} />
          <meshStandardMaterial color="#ffffff" />
        </mesh>
      </mesh>
      <Billboard position={[0, 1.4, 0]}>
        <Text
          fontSize={0.35}
          color={isLocal ? "#ffd34a" : "#ffffff"}
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {name}
        </Text>
        <group position={[0, -0.3, 0]}>
          <mesh>
            <planeGeometry args={[1.2, 0.12]} />
            <meshBasicMaterial color="#222" transparent opacity={0.6} />
          </mesh>
          <mesh position={[(hpFrac - 1) * 0.6, 0, 0.001]}>
            <planeGeometry args={[Math.max(0.001, 1.2 * hpFrac), 0.12]} />
            <meshBasicMaterial color={downed ? "#666" : "#5cd35c"} />
          </mesh>
        </group>
      </Billboard>
    </group>
  );
}
```

- [ ] **Step 3: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/PlayerCube.tsx
git commit -m "feat(client): PlayerCube — facing rotation + nose + downed flatten + billboarded name+HP bar"
```

---

## Phase 6 — Client HUD overlays

### Task 6.1: `<PlayerHud>` — bottom-center HP bar + damage flash

**Files:**
- Modify: `packages/client/src/game/PlayerHud.tsx`

The current PlayerHud renders a single bottom-left `<div>` with all-player rows (xp, level, cooldown bar, weapons). It uses a rAF re-render driver. We extend it to also render a bottom-center HP bar and a full-screen damage-flash overlay, while preserving the existing rows.

- [ ] **Step 1: Replace `PlayerHud.tsx` with the extended version**

Replace the file entirely:

```tsx
import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import type { Player, PlayerDamagedEvent, RoomState, WeaponState } from "@mp/shared";
import { WEAPON_KINDS, statsAt, isProjectileWeapon } from "@mp/shared";

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

const HP_BAR_STYLE: React.CSSProperties = {
  position: "fixed",
  bottom: 18,
  left: "50%",
  transform: "translateX(-50%)",
  width: 320,
  height: 18,
  background: "rgba(0,0,0,0.55)",
  border: "1px solid #4a5d70",
  borderRadius: 9,
  overflow: "hidden",
  pointerEvents: "none",
  zIndex: 1000,
};

const FLASH_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(255,0,0,0.3)",
  opacity: 0,
  transition: "opacity 200ms ease-out",
  pointerEvents: "none",
  zIndex: 1500,
};

const BAR_LEN = 5;

function cooldownBar(weapon: WeaponState | undefined): string {
  if (!weapon) return "·".repeat(BAR_LEN);
  const def = WEAPON_KINDS[weapon.kind];
  if (!def || !isProjectileWeapon(def)) return "·".repeat(BAR_LEN);
  const stats = statsAt(def, weapon.level);
  const frac = 1 - Math.max(0, Math.min(1, weapon.cooldownRemaining / stats.cooldown));
  const filled = Math.round(frac * BAR_LEN);
  return "▓".repeat(filled) + "░".repeat(BAR_LEN - filled);
}

export type PlayerHudProps = {
  room: Room<RoomState>;
};

export function PlayerHud({ room }: PlayerHudProps) {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  // rAF re-render driver — keeps player rows + HP bar in sync each frame.
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

  // Damage flash on every player_damaged event for the local player.
  useEffect(() => {
    const off = room.onMessage("player_damaged", (msg: PlayerDamagedEvent) => {
      if (msg.playerId !== room.sessionId) return;
      const el = flashRef.current;
      if (!el) return;
      // Snap to full opacity, then on the next frame request a transition to 0.
      el.style.transition = "none";
      el.style.opacity = "1";
      requestAnimationFrame(() => {
        if (!flashRef.current) return;
        flashRef.current.style.transition = "opacity 200ms ease-out";
        flashRef.current.style.opacity = "0";
      });
    });
    return () => off();
  }, [room]);

  const rows: string[] = [];
  room.state.players.forEach((p: Player) => {
    const namePad = (p.name || "Anon").padEnd(8).slice(0, 8);
    const xpStr = String(p.xp).padStart(4);
    const levelStr = String(p.level).padStart(2);

    const projWeapon = p.weapons.find((w) => {
      const def = WEAPON_KINDS[w.kind];
      return def?.behavior.kind === "projectile";
    });
    const cd = cooldownBar(projWeapon);

    const weaponList: string[] = [];
    p.weapons.forEach((w) => {
      const def = WEAPON_KINDS[w.kind];
      if (!def) return;
      weaponList.push(`${def.name} L${w.level}`);
    });
    const weaponsStr = weaponList.length > 0 ? weaponList.join(", ") : "—";

    rows.push(`${namePad} XP ${xpStr}  Lv ${levelStr}  ${cd}  ${weaponsStr}`);
  });

  const localPlayer = room.state.players.get(room.sessionId);
  const hp = localPlayer?.hp ?? 0;
  const maxHp = localPlayer?.maxHp ?? 100;
  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  return (
    <>
      {rows.length > 0 && <div style={HUD_STYLE}>{rows.join("\n")}</div>}
      {localPlayer && (
        <div style={HP_BAR_STYLE}>
          <div style={{
            height: "100%",
            width: `${hpFrac * 100}%`,
            background: "linear-gradient(90deg, #ff5252 0%, #ff8a52 100%)",
            transition: "width 120ms linear",
          }} />
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            color: "#fff",
            textShadow: "0 1px 2px rgba(0,0,0,0.7)",
          }}>{hp} / {maxHp}</div>
        </div>
      )}
      <div ref={flashRef} style={FLASH_STYLE} />
    </>
  );
}
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/PlayerHud.tsx
git commit -m "feat(client): PlayerHud — bottom-center HP bar + damage flash overlay"
```

---

### Task 6.2: `<DamageNumberPool>` — pooled drei `<Text>` floaters

**Files:**
- Create: `packages/client/src/game/DamageNumberPool.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useImperativeHandle, forwardRef, useRef } from "react";
import type { Group } from "three";
import type { Room } from "colyseus.js";
import type { HitEvent, PlayerDamagedEvent, RoomState } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import type { LocalPredictor } from "../net/prediction.js";

const POOL_SIZE = 30;
const RISE_PER_SEC = 1.0;
const LIFETIME_S = 0.8;

type Slot = {
  active: boolean;
  age: number;
  text: string;
  x: number; y: number; z: number;
  color: string;
};

type Props = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
  enemyBuffers: Map<number, SnapshotBuffer>;
};

export const DamageNumberPool = forwardRef<unknown, Props>(function DamageNumberPool(
  { room, predictor, buffers, enemyBuffers },
  _ref,
) {
  const slots = useRef<Slot[]>(
    Array.from({ length: POOL_SIZE }, () => ({
      active: false, age: 0, text: "", x: 0, y: 0, z: 0, color: "#ffffff",
    })),
  );
  const groupRefs = useRef<(Group | null)[]>(Array.from({ length: POOL_SIZE }, () => null));

  function spawn(text: string, x: number, z: number, color: string) {
    let idx = slots.current.findIndex((s) => !s.active);
    if (idx === -1) {
      // Drop oldest.
      let oldestAge = -1, oldestIdx = 0;
      slots.current.forEach((s, i) => { if (s.age > oldestAge) { oldestAge = s.age; oldestIdx = i; } });
      idx = oldestIdx;
    }
    slots.current[idx] = { active: true, age: 0, text, x, y: 1.5, z, color };
  }

  useEffect(() => {
    const offHit = room.onMessage("hit", (msg: HitEvent) => {
      const buf = enemyBuffers.get(msg.enemyId);
      const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
      if (sample) spawn(String(msg.damage), sample.x, sample.z, "#ffffff");
    });
    const offPlayerDamaged = room.onMessage("player_damaged", (msg: PlayerDamagedEvent) => {
      let x = msg.x, z = msg.z;
      if (msg.playerId === room.sessionId) {
        x = predictor.renderX; z = predictor.renderZ;
      } else {
        const sample = buffers.get(msg.playerId)?.sample(performance.now() - hudState.interpDelayMs);
        if (sample) { x = sample.x; z = sample.z; }
      }
      spawn(String(msg.damage), x, z, "#ff5a5a");
    });
    return () => { offHit(); offPlayerDamaged(); };
  }, [room, predictor, buffers, enemyBuffers]);

  useFrame((_, dt) => {
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = slots.current[i]!;
      const ref = groupRefs.current[i];
      if (!ref) continue;
      if (!s.active) {
        ref.visible = false;
        continue;
      }
      s.age += dt;
      if (s.age >= LIFETIME_S) {
        s.active = false;
        ref.visible = false;
        continue;
      }
      ref.visible = true;
      ref.position.set(s.x, s.y + s.age * RISE_PER_SEC, s.z);
      // The drei Text exposes `material.opacity` via fillOpacity prop or via mesh.material.
      const text = ref.children[0] as { material?: { opacity: number; transparent: boolean } } | undefined;
      if (text?.material) {
        text.material.transparent = true;
        text.material.opacity = Math.max(0, 1 - s.age / LIFETIME_S);
      }
    }
  });

  return (
    <>
      {slots.current.map((s, i) => (
        <group key={i} ref={(el) => { groupRefs.current[i] = el; }}>
          <Text fontSize={0.35} color={s.color} outlineColor="#000" outlineWidth={0.02}>
            {s.text}
          </Text>
        </group>
      ))}
    </>
  );
});
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/DamageNumberPool.tsx
git commit -m "feat(client): DamageNumberPool — pooled drei Text floaters for hit + player_damaged"
```

---

### Task 6.3: `<MinimapCanvas>` — 200×200 DOM canvas overlay

**Files:**
- Create: `packages/client/src/game/MinimapCanvas.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useEffect, useRef } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { MAP_RADIUS } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";

const CANVAS_SIZE = 200;
const SCALE = (CANVAS_SIZE / 2 - 6) / MAP_RADIUS;   // inscribed circle, 6px margin

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

type Props = { room: Room<RoomState>; predictor: LocalPredictor };

export function MinimapCanvas({ room, predictor }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const cx = CANVAS_SIZE / 2;
    const cy = CANVAS_SIZE / 2;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Boundary ring.
      ctx.strokeStyle = "rgba(90, 138, 255, 0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, MAP_RADIUS * SCALE, 0, Math.PI * 2);
      ctx.stroke();

      // Enemies — low-alpha red dots; clustering forms a haze naturally.
      ctx.fillStyle = "rgba(255, 80, 80, 0.4)";
      room.state.enemies.forEach((e) => {
        const px = cx + e.x * SCALE;
        const py = cy + e.z * SCALE;
        ctx.fillRect(px - 1, py - 1, 2, 2);
      });

      // Remote players — 3x3 hue squares.
      const localId = room.sessionId;
      let localFacingX = 0, localFacingZ = 1;
      let localX = predictor.renderX;
      let localZ = predictor.renderZ;
      room.state.players.forEach((p) => {
        if (p.sessionId === localId) {
          localFacingX = p.facingX;
          localFacingZ = p.facingZ;
          return;
        }
        ctx.fillStyle = colorFor(p.sessionId);
        const px = cx + p.x * SCALE;
        const py = cy + p.z * SCALE;
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      });

      // Local player — yellow triangle pointed along facing.
      ctx.save();
      ctx.translate(cx + localX * SCALE, cy + localZ * SCALE);
      ctx.rotate(Math.atan2(localFacingX, -localFacingZ));
      ctx.fillStyle = "#ffd34a";
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [room, predictor]);

  return (
    <canvas
      ref={ref}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      style={{
        position: "absolute", top: 12, right: 12,
        width: CANVAS_SIZE, height: CANVAS_SIZE,
        background: "rgba(0,0,0,0.55)",
        border: "1px solid #4a5d70", borderRadius: 4,
        pointerEvents: "none",
      }}
    />
  );
}
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/MinimapCanvas.tsx
git commit -m "feat(client): MinimapCanvas — 200x200 dot-haze minimap overlay"
```

---

### Task 6.4: `<RunOverPanel>` — recap overlay

**Files:**
- Create: `packages/client/src/game/RunOverPanel.tsx`

- [ ] **Step 1: Create the file**

```tsx
import type { Room } from "colyseus.js";
import { useEffect, useState } from "react";
import { getStateCallbacks } from "colyseus.js";
import type { RoomState, Player } from "@mp/shared";
import { TICK_RATE } from "@mp/shared";

type Row = {
  sessionId: string;
  name: string;
  level: number;
  kills: number;
  xpGained: number;
  joinTick: number;
  weapons: { kind: number; level: number }[];
};

type Props = { room: Room<RoomState>; onLeave: () => void };

export function RunOverPanel({ room, onLeave }: Props) {
  const [runEnded, setRunEnded] = useState<boolean>(room.state.runEnded);
  const [runEndedTick, setRunEndedTick] = useState<number>(room.state.runEndedTick);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const $ = getStateCallbacks(room);
    const offRun = $(room.state).listen("runEnded", (v) => setRunEnded(!!v));
    const offTick = $(room.state).listen("runEndedTick", (v) => setRunEndedTick(Number(v)));
    return () => { offRun(); offTick(); };
  }, [room]);

  useEffect(() => {
    if (!runEnded) return;
    const next: Row[] = [];
    room.state.players.forEach((p: Player) => {
      next.push({
        sessionId: p.sessionId,
        name: p.name || "Player",
        level: p.level,
        kills: p.kills,
        xpGained: p.xpGained,
        joinTick: p.joinTick,
        weapons: Array.from(p.weapons.values()).map((w) => ({ kind: w.kind, level: w.level })),
      });
    });
    setRows(next);
  }, [runEnded, room]);

  if (!runEnded) return null;

  function formatSurvived(joinTick: number) {
    const secs = Math.max(0, (runEndedTick - joinTick) / TICK_RATE);
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div style={{
      position: "absolute", inset: 0,
      background: "rgba(8,12,18,0.78)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 16,
      fontFamily: "monospace", color: "#eee", zIndex: 10,
    }}>
      <h2 style={{ color: "#ff8a52", margin: 0 }}>Run Over</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>player</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>level</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>kills</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>xp</th>
            <th style={{ padding: "4px 12px", borderBottom: "1px solid #4a5d70", textAlign: "left" }}>survived</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sessionId}>
              <td style={{ padding: "4px 12px" }}>{r.name}{r.sessionId === room.sessionId ? " (you)" : ""}</td>
              <td style={{ padding: "4px 12px" }}>{r.level}</td>
              <td style={{ padding: "4px 12px" }}>{r.kills}</td>
              <td style={{ padding: "4px 12px" }}>{r.xpGained}</td>
              <td style={{ padding: "4px 12px" }}>{formatSurvived(r.joinTick)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() => { room.leave(true); onLeave(); }}
        style={{
          background: "#ff5252", color: "#fff",
          padding: "8px 18px", borderRadius: 4, border: "none",
          fontFamily: "inherit", cursor: "pointer",
        }}
      >Leave room</button>
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/RunOverPanel.tsx
git commit -m "feat(client): RunOverPanel — per-player recap + leave button"
```

---

### Task 6.5: `<LevelUpOverlay>` — hide when local player downed

**Files:**
- Modify: `packages/client/src/game/LevelUpOverlay.tsx`

The existing component is rAF-driven and reads `room.state.players.get(room.sessionId)` each frame, so a `downed` flip is picked up automatically — we just need an extra guard in the visibility check.

- [ ] **Step 1: Update the visibility guard**

In `packages/client/src/game/LevelUpOverlay.tsx`, find the existing line:

```ts
  if (!localPlayer || !localPlayer.pendingLevelUp || localPlayer.levelUpChoices.length === 0) {
    return null;
  }
```

Replace it with:

```ts
  if (
    !localPlayer ||
    localPlayer.downed ||
    !localPlayer.pendingLevelUp ||
    localPlayer.levelUpChoices.length === 0
  ) {
    return null;
  }
```

(The 1/2/3 keystroke handler short-circuit lives in `GameView.tsx`'s `keyHandler` and is added in Task 7.1, Step 7.)

- [ ] **Step 2: Type check**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/game/LevelUpOverlay.tsx
git commit -m "feat(client): LevelUpOverlay hides for downed local players"
```

---

## Phase 7 — GameView integration

### Task 7.1: Wire all new components into `<GameView>`

**Files:**
- Modify: `packages/client/src/game/GameView.tsx`
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Replace the static camera with `<CameraRig>`**

In `GameView.tsx`, in the `<Canvas>` JSX, change:

```tsx
<Canvas shadows camera={{ position: [0, 12, 12], fov: 55 }} ... >
```

to:

```tsx
<Canvas shadows camera={{ position: [0, 9, 11], fov: 55 }} ... >
```

(Initial camera position before lerp settles; same shape, M6 offset.)

Inside the Canvas, alongside the existing components, add:

```tsx
<CameraRig room={room} predictor={predictor} buffers={buffers} />
<BoundaryRing />
<Crosshair room={room} />
<DamageNumberPool room={room} predictor={predictor} buffers={buffers} enemyBuffers={enemyBuffers} />
```

- [ ] **Step 2: (intentionally blank — `Crosshair` reads downed directly from `room.state` each frame, no extra wiring needed.)**

- [ ] **Step 3: Pass `room` to `<PlayerCube>` and update the call site**

`PlayerCube` now needs `room`. Update its call site in `GameView.tsx`:

```tsx
<PlayerCube
  key={p.sessionId}
  room={room}
  sessionId={p.sessionId}
  name={p.name}
  buffer={p.buffer}
  predictor={p.sessionId === room.sessionId ? predictor : undefined}
/>
```

- [ ] **Step 4: Pass camera + local pos getters to `attachInput`**

Replace the existing `attachInput(room, predictor)` call with:

```ts
const detachInput = attachInput(
  room, predictor,
  () => canvasCameraRef.current,
  () => ({ x: predictor.renderX, z: predictor.renderZ }),
);
```

You'll need a way to read the camera. The simplest: capture the camera into a ref inside the Canvas via a tiny child component:

```tsx
function CaptureCamera({ camRef }: { camRef: React.MutableRefObject<PerspectiveCamera | null> }) {
  const cam = useThree((s) => s.camera) as PerspectiveCamera;
  camRef.current = cam;
  return null;
}
```

And in `GameView`:

```ts
const canvasCameraRef = useRef<PerspectiveCamera | null>(null);
// ...
<Canvas ...>
  <CaptureCamera camRef={canvasCameraRef} />
  ...
</Canvas>
```

(This is the smallest-friction way to read the R3F camera from outside the Canvas. The R3F idiom is normally `useThree`, but `attachInput` runs in a non-component context.)

- [ ] **Step 5: Add `<MinimapCanvas>` and `<RunOverPanel>` outside the Canvas**

In the GameView's JSX, after `<DebugHud />`, add:

```tsx
<MinimapCanvas room={room} predictor={predictor} />
<RunOverPanel room={room} onLeave={onConsentLeave} />
```

`onConsentLeave` is a new prop on `GameView`. Plumb it: add `onConsentLeave: () => void` to `GameView`'s props, and call it from inside `RunOverPanel`'s leave button.

- [ ] **Step 6: Update `App.tsx` to pass `onConsentLeave`**

Find where `<GameView room={room} onUnexpectedLeave={...} />` is rendered, and add `onConsentLeave={() => goBackToLanding()}` (or whatever the existing landing-return code uses for `onUnexpectedLeave`).

- [ ] **Step 7: Update the 1/2/3 keystroke handler to honor downed**

In `GameView.tsx`'s `keyHandler`, in the `Digit1/2/3` branch, add an early-return:

```ts
if (localPlayer.downed) return;
```

before the `room.send("level_up_choice", ...)` call.

- [ ] **Step 8: Type check + dev smoke test**

Run: `pnpm --filter @mp/client typecheck`
Expected: clean.

Run `pnpm dev`, open two tabs, walk into enemies, watch HP drop and minimap update. Drop one player into downed; confirm camera switches to the live teammate.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/game/GameView.tsx packages/client/src/App.tsx
git commit -m "feat(client): wire CameraRig, BoundaryRing, Crosshair, MinimapCanvas, RunOverPanel into GameView"
```

---

## Phase 8 — Verification

### Task 8.1: Full-stack verification

**Files:** none (verification only)

- [ ] **Step 1: Workspace typecheck**

Run: `pnpm typecheck`
Expected: clean across shared, server, client.

- [ ] **Step 2: Workspace tests**

Run: `pnpm test`
Expected: PASS for shared, server, client.

- [ ] **Step 3: Server integration test (encoder-landmine guard)**

Run: `pnpm --filter @mp/server test -- integration`
Expected: PASS — schema additions encode cleanly under a real Colyseus + WS client.

- [ ] **Step 4: Manual two-tab smoke**

Run: `pnpm dev`. Open two browser tabs at the printed URL, join the same room (one creates, second joins via code).

Confirm:
- Camera follows local player smoothly (~150ms catchup).
- Mouse-aim crosshair tracks under the cursor on the ground plane.
- Cube nose rotates to face the crosshair.
- WASD movement clamps at MAP_RADIUS=60; the BoundaryRing is visible.
- `Shift+]` spawns 100 enemies; minimap shows red haze + dots.
- Walking into a swarm drops local HP at ~10 dmg/sec (5 dmg, 0.5s cooldown per enemy).
- Damage flash overlay pulses on each contact.
- Floating damage numbers appear over enemies (white) and the local player (red).
- Going to 0 HP: cube turns gray and lays flat; nameplate stays visible at reduced alpha; main HP bar shows 0/100; crosshair disappears; level-up overlay dismisses if open; camera switches to the other tab's player.
- When the second player is killed, the run-over overlay appears in both tabs with totals; "Leave room" returns to the landing screen.
- Minimap dots: dense haze under spawn, lone wanderers visible as discrete dots.

- [ ] **Step 5: Final commit (if any patches were made during verification)**

If verification turned up small fixes, commit them with descriptive messages. Otherwise: no commit needed.

---

## Self-review

Spec coverage check (one row per spec section / AD):

| Spec section / AD | Plan task |
|---|---|
| AD1 spectator-mode | Task 5.2 (`CameraRig` spectator switching) + Task 3.5 (downed flip) |
| AD2 facing on schema | Task 1.3 (schema fields) + Task 2.3 (handler write) |
| AD3 contactCooldown mirror | Task 3.4 (new file) + Task 4.1 (wiring) |
| AD4 universal runEnded early-out | Task 3.1 |
| AD5 tick-order extension | Task 3.5 + Task 3.6 + Task 4.1 |
| AD6 hit / player_damaged split | Task 1.2 (events) + Task 6.2 (consumers) |
| AD7 minimap canvas | Task 6.3 |
| AD8 fixed-world camera lerp | Task 5.2 |
| AD9 kills/xpGained on schema | Task 3.7 + 3.8 + 3.9 |
| AD10 map clamping in tickPlayers | Task 3.2 |
| AD11 enemy despawn | Task 3.3 |
| AD12 PLAYER_NAME_MAX_LEN=16 | Task 1.1 + Task 2.2 |
| AD13 global tuning constants | Task 1.1 |
| Schema diff (Player + RoomState) | Task 1.3 |
| Constants additions | Task 1.1 |
| Message additions | Task 1.2 |
| tickPlayers changes | Task 3.2 |
| tickEnemies changes | Task 3.3 |
| tickContactDamage | Task 3.5 |
| tickRunEndCheck | Task 3.6 |
| tickWeapons skip-downed + kills | Task 3.7 |
| tickProjectiles outlive-owner + kills | Task 3.8 |
| tickGems xpGained | Task 3.9 |
| tickSpawner clamp + skip-downed | Task 3.10 |
| GameRoom.onMessage gate + facing | Task 2.3 |
| `debug_damage_self` (test-fast-path) | Task 1.2 (message def) + Task 2.4 (handler) |
| GameRoom.onJoin field init | Task 2.2 |
| GameRoom.onLeave evict contact | Task 4.1 |
| GameRoom.tick wiring | Task 4.1 |
| CameraRig | Task 5.2 |
| Crosshair | Task 5.3 |
| BoundaryRing + Ground resize | Task 5.4 |
| PlayerCube facing/downed/billboard | Task 5.5 |
| PlayerHud HP bar + flash | Task 6.1 |
| DamageNumberPool | Task 6.2 |
| MinimapCanvas | Task 6.3 |
| RunOverPanel | Task 6.4 |
| LevelUpOverlay hide-downed | Task 6.5 |
| GameView wiring | Task 7.1 |
| App onConsentLeave | Task 7.1 |
| Unit tests | Tasks 3.1–3.10 |
| Integration test | Task 4.3 |
| Reconnect test | Task 4.2 |
| CLAUDE.md rule 11 | Task 0.1 |
| CLAUDE.md rule 12 | Task 0.2 |

Every spec item maps to at least one task.
