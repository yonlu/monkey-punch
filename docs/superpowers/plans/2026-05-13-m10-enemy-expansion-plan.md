# M10 Enemy Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the enemy system from one kind / one behavior to a data-driven `ENEMY_KINDS` table (mirroring `WEAPON_KINDS`), add 3 new enemy kinds (Bunny / Ghost / Skeleton) and a bespoke boss kind with a telegraphed AoE slam, on a recurring spawn cadence.

**Architecture:** New `packages/shared/src/enemies.ts` holds the pure data table; `Enemy` schema grows two fields (`maxHp`, `abilityFireAt`); two new tick functions (`tickBossAbilities`, `tickBossSpawner`) append to the existing tick order without disturbing the RNG schedule; boss spawn state lives off-schema on `GameRoom`. Unity client adopts a kind→prefab registry and renders a boss HP bar + telegraph VFX.

**Tech Stack:** pnpm workspaces (TypeScript strict), Colyseus 0.16, Vitest, Unity 6000.4.6f1, URP, C# 9.

**Source spec:** `docs/superpowers/specs/2026-05-13-m10-enemy-expansion-design.md` (commit `d3d3aa1`).

---

## File Map

**Create:**
- `packages/shared/src/enemies.ts` — `EnemyDef`, `ENEMY_KINDS`, `enemyDefAt`, `BOSS_KIND_INDEX`.
- `Monkey Punch/Assets/Scripts/Combat/BossTelegraphVfx.cs` — ring decal + slam shockwave singleton.
- `Monkey Punch/Assets/Scripts/Render/BunnyHop.cs` — procedural hop animator (mirrors `SlimeBob.cs`).
- `Monkey Punch/Assets/Scripts/Render/GhostFloat.cs` — procedural float + drift animator.
- `Monkey Punch/Assets/Art/Enemies/Bunny/`, `Ghost/`, `Skeleton/`, `Boss/` (Meshy outputs; deferred to Phase 6).
- `Monkey Punch/Assets/Prefabs/Enemies/Bunny.prefab`, `Ghost.prefab`, `Skeleton.prefab`, `Boss.prefab` (deferred to Phase 6).

**Modify:**
- `packages/shared/src/constants.ts` — add `FLYING_ENEMY_ALTITUDE`, `GEM_FAN_RADIUS`, `BOSS_INTERVAL_TICKS`.
- `packages/shared/src/schema.ts` — `Enemy` gains `maxHp` + `abilityFireAt`.
- `packages/shared/src/index.ts` — re-export `./enemies.js`.
- `packages/shared/src/messages.ts` — `BossTelegraphEvent`, `BossAoeHitEvent` + `MessageType` entries.
- `packages/shared/src/rules.ts` — `tickEnemies` (speed/flying/freeze), `tickSpawner` (weighted kind pick + per-kind stats), `tickContactDamage` (per-kind damage/radius), 5 kill sites (DRY into `spawnGemFanAndEmitDeath` helper), 2 new tick fns.
- `packages/shared/test/rules.test.ts` — extend with new behavior tests; regenerate M3 determinism-test expected values.
- `packages/shared/test/schema.test.ts` — extend Enemy round-trip.
- `packages/server/src/GameRoom.ts` — wire `bossSpawner` + `bossCooldowns`; insert new tick fns in order.
- `packages/server/test/integration.test.ts` — boss-spawn timing test + test-only hook for `nextBossAt`.
- `CLAUDE.md` — Rule 11 tick-order update; new Rule 13 (Enemy variety is data).
- `Monkey Punch/Assets/Scripts/Schema/Enemy.cs` — `[Type(8)] maxHp`, `[Type(9)] abilityFireAt`.
- `Monkey Punch/Assets/Scripts/Net/PredictorConstants.cs` — add `BOSS_KIND_INDEX = 4`.
- `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs` — `slimePrefab` → `enemyPrefabs[]`; subscribe `boss_telegraph` and `boss_aoe_hit`.
- `Monkey Punch/Assets/Scripts/UI/GameUI.cs` — boss HP bar.
- `docs/art-pipeline/meshy-enemy-prompts.md` — append a `Boss (bespoke)` section authored at art-prompt time.

---

## TDD vs. Editor-config split

The shared and server layers are TDD-friendly: each pure function gets a Vitest case before the implementation. The Unity portions (schema mirror, prefab registry, MonoBehaviour VFX, HP-bar UI) are Editor configuration + MonoBehaviour glue that the project doesn't have a runtime test harness for — those tasks use "verify in Editor" steps following the M9 plan precedent. The asset-pipeline phase (Meshy generations) is user-driven art workflow.

When a step says "verify in Editor," that means: open Unity, navigate to the asset/component, and confirm the expected state by inspection.

---

## Phase 1 — Shared layer

### Task 1: Add the three new constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Append the M10 constants block at the end of the file**

Open `packages/shared/src/constants.ts` and append after the existing `COYOTE_TIME` / `JUMP_BUFFER` block:

```ts
// M10 — enemy expansion
/**
 * Vertical offset for flying enemies. tickEnemies snaps a flying enemy's
 * y to terrainHeight(x, z) + FLYING_ENEMY_ALTITUDE every tick, so flying
 * creatures float at a constant altitude above whatever ground is
 * beneath them. Set per spec §AD5 (resnap-with-offset, not frozen
 * spawn-altitude). 2.5 reads as "clearly above the player; below the
 * canopy of terrain props if those land later."
 */
export const FLYING_ENEMY_ALTITUDE = 2.5;

/**
 * Radius (world units) of the evenly-spaced gem fan dropped on
 * multi-gem enemy deaths. Per AD10 — angles are deterministic
 * `(i / count) * 2π`, no rng consumption.
 */
export const GEM_FAN_RADIUS = 1.5;

/**
 * Ticks between boss spawn attempts. 3 minutes @ 20Hz = 3600 ticks.
 * Tunable knob; the only cadence-control surface for boss appearances.
 * Spec §AD7. First spawn is at this tick value (not at tick=0) — see
 * GameRoom.onCreate which initializes nextBossAt = BOSS_INTERVAL_TICKS.
 */
export const BOSS_INTERVAL_TICKS = 3 * 60 * TICK_RATE;
```

- [ ] **Step 2: Run shared typecheck to confirm no break**

```bash
pnpm --filter @mp/shared run typecheck
```

Expected: passes (`tsc -b` exits 0).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "$(cat <<'EOF'
feat(m10): add FLYING_ENEMY_ALTITUDE, GEM_FAN_RADIUS, BOSS_INTERVAL_TICKS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create `enemies.ts` with the data table and helpers

**Files:**
- Create: `packages/shared/src/enemies.ts`

- [ ] **Step 1: Write the new file**

Create `packages/shared/src/enemies.ts` with the full table from spec §AD1, plus the module-load-time `BOSS_KIND_INDEX` derivation from spec AD3:

```ts
// M10: pure data table for enemy kinds. No Schema, no methods, no side
// effects on import. Adding an enemy means adding a row here under an
// existing capability shape — NEVER a new branch in tickEnemies,
// tickSpawner, tickContactDamage, or the client renderers (rule 12).
//
// Parallel structure to WEAPON_KINDS in weapons.ts and ITEM_KINDS in
// items.ts: single source of truth, generic dispatch by kind index,
// never by `name`.
//
// Per-kind dispatch reads through `enemyDefAt(kind)` — never via direct
// indexing or via `def.name === "..."`.

export type EnemyDef = {
  name: string;
  baseHp: number;
  speedMultiplier: number;   // multiplied by ENEMY_SPEED (slime baseline = 1.0)
  contactDamage: number;     // hp per touch (overrides ENEMY_CONTACT_DAMAGE)
  radius: number;            // hit + contact radius (overrides ENEMY_RADIUS)
  gemDropCount: number;      // gems spawned in a fan around death point
  spawnWeight: number;       // relative odds in tickSpawner; 0 for bosses
  minSpawnTick: number;      // earliest state.tick at which kind may spawn
  flying: boolean;           // true = tickEnemies skips terrain Y-snap and uses FLYING_ENEMY_ALTITUDE
  isBoss: boolean;           // bosses spawned by tickBossSpawner, not tickSpawner
  // Boss-only fields. Read only when isBoss === true; ignored (and
  // zeroed) for non-boss rows.
  bossAbilityCooldownTicks: number;
  bossAbilityWindupTicks: number;
  bossAbilityRadius: number;
  bossAbilityDamage: number;
};

// Kind index ordering is the wire identifier. Stable across releases —
// new kinds append at the end. Reordering would break save/replay
// determinism the same way reordering WEAPON_KINDS would.
export const ENEMY_KINDS: readonly EnemyDef[] = [
  // 0: Slime — preserves current behavior. Always spawnable.
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

  // 2: Ghost — flying mid; unlocks after 90s.
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

  // 4: Boss — bespoke creature; spawnWeight=0 so tickSpawner never picks it.
  //    Spawned exclusively by tickBossSpawner on its own timer.
  { name: "Boss",     baseHp: 2000, speedMultiplier: 0.7, contactDamage: 20,
    radius: 1.5, gemDropCount: 15, spawnWeight: 0,  minSpawnTick: 0,
    flying: false, isBoss: true,
    bossAbilityCooldownTicks: 100,  // 5s @ 20Hz
    bossAbilityWindupTicks: 20,     // 1s telegraph
    bossAbilityRadius: 4,
    bossAbilityDamage: 30 },
];

/**
 * Clamp `kind` into the defined range and return the row. Defensive
 * against fractional and non-finite inputs — same shape as `statsAt`
 * in weapons.ts and `itemValueAt` in items.ts. Today `Enemy.kind` is
 * uint8 so out-of-range is theoretical, but the helper is the public
 * boundary contract.
 */
export function enemyDefAt(kind: number): EnemyDef {
  const floored = Math.floor(kind);
  const safe = Number.isFinite(floored) ? floored : 0;
  const idx = Math.max(0, Math.min(ENEMY_KINDS.length - 1, safe));
  return ENEMY_KINDS[idx]!;
}

/**
 * Cached boss kind index. Resolved at module load by scanning
 * ENEMY_KINDS for the first `isBoss === true` row. If a future refactor
 * accidentally removes the boss row, the IIFE assertion trips at
 * import time — not at the first 3-minute mark of a real run.
 *
 * Mirror of the assertion pattern used for MAX_ORB_COUNT_EVER in
 * shared/index.ts.
 */
export const BOSS_KIND_INDEX: number = (() => {
  const idx = ENEMY_KINDS.findIndex((d) => d.isBoss);
  if (idx < 0) {
    throw new Error(
      "BOSS_KIND_INDEX: ENEMY_KINDS contains no row with isBoss === true",
    );
  }
  return idx;
})();
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @mp/shared run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/enemies.ts
git commit -m "$(cat <<'EOF'
feat(m10): add ENEMY_KINDS data table and enemyDefAt helper

Mirrors WEAPON_KINDS / ITEM_KINDS shape. 5 kinds: Slime, Bunny, Ghost,
Skeleton, Boss. BOSS_KIND_INDEX resolved at module load with assertion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add a `enemyDefAt` clamp test

**Files:**
- Create: `packages/shared/test/enemies.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/enemies.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ENEMY_KINDS, enemyDefAt, BOSS_KIND_INDEX } from "../src/enemies.js";

describe("enemyDefAt", () => {
  it("returns the row at an in-range integer kind", () => {
    expect(enemyDefAt(0).name).toBe("Slime");
    expect(enemyDefAt(1).name).toBe("Bunny");
    expect(enemyDefAt(2).name).toBe("Ghost");
    expect(enemyDefAt(3).name).toBe("Skeleton");
    expect(enemyDefAt(4).name).toBe("Boss");
  });

  it("clamps an out-of-range kind to the last row", () => {
    expect(enemyDefAt(99)).toBe(ENEMY_KINDS[ENEMY_KINDS.length - 1]);
  });

  it("clamps a negative kind to the first row", () => {
    expect(enemyDefAt(-5)).toBe(ENEMY_KINDS[0]);
  });

  it("floors a fractional kind", () => {
    expect(enemyDefAt(2.7)).toBe(ENEMY_KINDS[2]);
  });

  it("coerces NaN to the first row", () => {
    expect(enemyDefAt(NaN)).toBe(ENEMY_KINDS[0]);
  });

  it("coerces Infinity to the last row", () => {
    expect(enemyDefAt(Infinity)).toBe(ENEMY_KINDS[ENEMY_KINDS.length - 1]);
  });
});

describe("BOSS_KIND_INDEX", () => {
  it("points to the only isBoss row in ENEMY_KINDS", () => {
    expect(ENEMY_KINDS[BOSS_KIND_INDEX]!.isBoss).toBe(true);
    expect(ENEMY_KINDS[BOSS_KIND_INDEX]!.name).toBe("Boss");
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @mp/shared test -- enemies
```

Expected: PASS (all 7 assertions). Step 1 wrote the tests AFTER the implementation in Task 2 so they should pass on first run — this is TDD for the *guarantees*, not test-before-impl ordering (the data table is the contract; clamping the read API is the guarantee under test).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/test/enemies.test.ts
git commit -m "$(cat <<'EOF'
test(m10): enemyDefAt clamp + BOSS_KIND_INDEX correctness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Re-export `enemies.ts` from the shared barrel

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add the re-export line**

Open `packages/shared/src/index.ts`. After the existing `export * from "./items.js";` line, add:

```ts
export * from "./enemies.js";
```

The IIFE block at the bottom that validates `MAX_ORB_COUNT_EVER` stays unchanged — it imports its needed symbols explicitly. The `BOSS_KIND_INDEX` IIFE in `enemies.ts` self-validates on first import via the barrel.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: workspace-wide pass. The `tsc -b` step picks up the new exports and rebuilds `packages/shared/dist/` so server/client consumers can resolve `@mp/shared`'s new symbols.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(m10): re-export enemies.ts from @mp/shared barrel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add `maxHp` and `abilityFireAt` to the `Enemy` schema

**Files:**
- Modify: `packages/shared/src/schema.ts:204-247` (the `Enemy` class block and its `defineTypes` call)

- [ ] **Step 1: Update the `Enemy` class**

In `packages/shared/src/schema.ts`, find the `Enemy` class (around line 204). Replace the class body and `defineTypes` call:

```ts
export class Enemy extends Schema {
  declare id: number;
  declare kind: number;
  declare x: number;
  // M7 US-012: enemies snap to terrain. Enemies have no vy and do not
  // jump (per PRD § US-010 in tasks/prd-m7-verticality.md): tickEnemies
  // simply assigns `y = terrainHeight(x, z) + ENEMY_GROUND_OFFSET` after
  // X/Z integration. M10: flying enemies (def.flying === true) snap to
  // terrainHeight + FLYING_ENEMY_ALTITUDE instead.
  declare y: number;
  declare z: number;
  declare hp: number;
  // M8 US-009: status effects (single-effect shape, slow only).
  declare slowMultiplier: number;
  declare slowExpiresAt: number;
  // M10: drives boss HP-bar ratio AND lets clients display damage as a
  // percentage of max. Set at spawn from ENEMY_KINDS[kind].baseHp;
  // never mutated post-spawn.
  declare maxHp: number;
  // M10: countdown tick for the boss telegraphed ability. -1 sentinel = idle
  // (matches Player.jumpBufferedAt and Enemy.slowExpiresAt encoding).
  // For non-boss enemies stays -1 forever after construction.
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
  maxHp: "uint16",          // M10
  abilityFireAt: "int32",   // M10
});
```

Note the `declare` + constructor-body pattern is preserved — no class field initializers. The 19-line banner comment at the top of `schema.ts` explains why; do NOT remove that banner.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @mp/shared run typecheck
```

Expected: passes.

- [ ] **Step 3: Build dist so consumers see the new fields**

```bash
pnpm --filter @mp/shared build
```

Expected: builds successfully. Without this step, `@mp/server` and `@mp/client` would resolve the schema through stale `dist/` (see CLAUDE.md "Stale dist landmine" / monkey-punch skill landmine 2).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schema.ts
git commit -m "$(cat <<'EOF'
feat(m10): add Enemy.maxHp + Enemy.abilityFireAt schema fields

maxHp drives boss HP-bar ratio; abilityFireAt is the countdown tick
for the boss telegraphed ability (-1 sentinel = idle).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Extend the `Enemy` round-trip test for the two new fields

**Files:**
- Modify: `packages/shared/test/schema.test.ts`

- [ ] **Step 1: Locate the existing Enemy round-trip**

Open `packages/shared/test/schema.test.ts` and find the `describe("Enemy", ...)` block. Note the existing fields tested (`id`, `kind`, `x`, `y`, `z`, `hp`, `slowMultiplier`, `slowExpiresAt`).

- [ ] **Step 2: Add assertions for the two new fields**

In the existing Enemy round-trip test, after the `slowExpiresAt` assertion, add:

```ts
    expect(decoded.maxHp).toBe(2000);
    expect(decoded.abilityFireAt).toBe(-1);
```

And in the corresponding `enemy.* = ...` setup before encode, set:

```ts
    enemy.maxHp = 2000;
    enemy.abilityFireAt = -1;
```

(If the existing test does not already exercise an Enemy encode→decode round-trip, copy the shape of the `Player` round-trip in the same file: instantiate, set fields, encode through a parent RoomState, decode into a peer schema, assert each field.)

- [ ] **Step 3: Run the schema test**

```bash
pnpm --filter @mp/shared test -- schema
```

Expected: PASS. The schema-test landmine guard (esbuild field-initializer issue) catches NaN / undefined returns from a broken setter on the new fields specifically.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/test/schema.test.ts
git commit -m "$(cat <<'EOF'
test(m10): exercise Enemy.maxHp + Enemy.abilityFireAt round-trip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add the two new event types to `messages.ts`

**Files:**
- Modify: `packages/shared/src/messages.ts`

- [ ] **Step 1: Add the event type declarations**

In `packages/shared/src/messages.ts`, after the existing `BoomerangThrownEvent` block (around line 220-237), add:

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

- [ ] **Step 2: Extend the `MessageType` constant**

In the `MessageType` const at the bottom of the file, after the existing `BoomerangThrown` entry, add:

```ts
  BossTelegraph: "boss_telegraph",   // M10
  BossAoeHit: "boss_aoe_hit",        // M10
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @mp/shared run typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/messages.ts
git commit -m "$(cat <<'EOF'
feat(m10): add BossTelegraphEvent + BossAoeHitEvent message types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Extract `spawnGemFanAndEmitDeath` helper (refactor only — existing tests must still pass)

**Files:**
- Modify: `packages/shared/src/rules.ts` (5 kill sites + new helper)

- [ ] **Step 1: Add the helper near the top of `rules.ts` (after the existing imports and below the helper-utility section)**

At a suitable location near the other shared helpers in `rules.ts` (above `tickPlayers`), add:

```ts
/**
 * M10: shared "an enemy died this frame" path. Replaces the
 * five copy-pasted death-handling blocks across tickWeapons
 * (orbit), runMeleeArcSwing, tickProjectiles, tickBoomerangs, and
 * tickBloodPools.
 *
 * Behavior (preserves pre-M10 semantics for slime exactly):
 *   - Look up the kind's gemDropCount.
 *   - Spawn 1 gem at (enemy.x, enemy.z) when gemDropCount === 1
 *     (preserves the M3 spawn position for slimes — the existing
 *     determinism test asserts this exact position).
 *   - Spawn N gems in an evenly-spaced ring at GEM_FAN_RADIUS for
 *     N > 1. Angles are `(i / N) * 2π` — deterministic, no rng.
 *   - Delete the enemy from state.enemies, evict orbit-hit cooldown,
 *     emit enemy_died.
 *
 * Caller responsibilities (intentionally NOT inside the helper):
 *   - Crediting the kill to `player.kills += 1` (caller knows the killer)
 *   - boomerang/projectile-specific bookkeeping (pierceRemaining, etc.)
 */
export function spawnGemFanAndEmitDeath(
  state: RoomState,
  enemy: Enemy,
  ctx: { nextGemId: () => number; orbitHitCooldown: OrbitHitCooldownLike },
  emit: Emit,
): void {
  const def = enemyDefAt(enemy.kind);
  const deathX = enemy.x;
  const deathZ = enemy.z;
  const deathId = enemy.id;
  const count = Math.max(1, def.gemDropCount | 0);

  if (count === 1) {
    const gem = new Gem();
    gem.id = ctx.nextGemId();
    gem.x = deathX;
    gem.z = deathZ;
    gem.value = GEM_VALUE;
    state.gems.set(String(gem.id), gem);
  } else {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;   // deterministic — no rng
      const gem = new Gem();
      gem.id = ctx.nextGemId();
      gem.x = deathX + Math.cos(angle) * GEM_FAN_RADIUS;
      gem.z = deathZ + Math.sin(angle) * GEM_FAN_RADIUS;
      gem.value = GEM_VALUE;
      state.gems.set(String(gem.id), gem);
    }
  }

  state.enemies.delete(String(deathId));
  ctx.orbitHitCooldown.evictEnemy(deathId);

  emit({
    type: "enemy_died",
    enemyId: deathId,
    x: deathX,
    z: deathZ,
  });
}
```

Add the new imports at the top of the file:

```ts
import { enemyDefAt } from "./enemies.js";
import { GEM_FAN_RADIUS } from "./constants.js";
```

(Existing `Gem`, `OrbitHitCooldownLike`, and `Emit` types should already be in scope from earlier in the file. If `Emit` is not exported as a named type, find it locally in `rules.ts` and reuse the same type alias.)

- [ ] **Step 2: Replace each of the five death-handling blocks with a single call**

For each site, the existing pattern is approximately:

```ts
// (existing block — DELETE)
if (enemy.hp <= 0) {
  const gem = new Gem();
  gem.id = ctx.nextGemId();
  gem.x = enemy.x;
  gem.z = enemy.z;
  gem.value = GEM_VALUE;
  state.gems.set(String(gem.id), gem);

  const deathX = enemy.x;
  const deathZ = enemy.z;
  const deathId = enemy.id;
  player.kills += 1;                                  // or owner.kills, or absent
  state.enemies.delete(String(enemy.id));
  ctx.orbitHitCooldown.evictEnemy(deathId);

  emit({ type: "enemy_died", enemyId: deathId, x: deathX, z: deathZ });
}
```

Becomes:

```ts
if (enemy.hp <= 0) {
  player.kills += 1;                                  // keep the caller's kill-credit line
  spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
}
```

The five sites to update:

| Site | Approx line | Killer context |
|------|-------------|----------------|
| tickWeapons orbit kill   | ~881 | `player.kills += 1` |
| runMeleeArcSwing kill    | ~1083 | `player.kills += 1` |
| runAuraTick kill         | ~1205 | `player.kills += 1` |
| tickBoomerangs kill      | ~1504 | `if (owner) owner.kills += 1` |
| tickProjectiles kill     | ~1819 | `if (owner) owner.kills += 1` |
| tickBloodPools kill      | ~1603 | `if (owner) owner.kills += 1` |

(Six sites total — orbit + melee + aura + boomerang + projectile + blood pool.) Confirm by grepping for `enemy.hp <= 0` before/after.

- [ ] **Step 3: Run the existing rules tests to confirm the refactor is behavior-preserving**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: all existing tests PASS unchanged. If any fail, the helper diverged from the inline block (most likely cause: ordering of `state.enemies.delete` vs the `enemy_died` emit changed; the spec-preserving order is delete-then-emit).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/rules.ts
git commit -m "$(cat <<'EOF'
refactor(m10): extract spawnGemFanAndEmitDeath helper

DRY out the six copy-pasted death-handling blocks across the kill
sites (orbit/melee/aura/boomerang/projectile/blood pool). Behavior
preserved exactly for the slime baseline (gemDropCount=1 → one gem at
death position). Per-kind gem fan support lights up automatically
once the kill sites read from ENEMY_KINDS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Test the gem fan helper

**Files:**
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Append a new `describe` block at the end of the file**

```ts
import { spawnGemFanAndEmitDeath } from "../src/rules.js";
import { GEM_FAN_RADIUS, GEM_VALUE } from "../src/constants.js";
import { ENEMY_KINDS } from "../src/enemies.js";

describe("spawnGemFanAndEmitDeath", () => {
  // Minimal stub ctx — only the two methods the helper reads.
  function makeCtx() {
    let next = 1;
    return {
      nextGemId: () => next++,
      orbitHitCooldown: { evictEnemy: () => {}, tryHit: () => true },
    };
  }

  function makeEnemyAt(kind: number, x: number, z: number): Enemy {
    const e = new Enemy();
    e.id = 42;
    e.kind = kind;
    e.x = x;
    e.z = z;
    e.hp = 0;
    e.maxHp = ENEMY_KINDS[kind]!.baseHp;
    return e;
  }

  it("gemDropCount === 1: spawns exactly one gem at the death position", () => {
    const state = new RoomState();
    state.enemies.set("42", makeEnemyAt(0, 7, 11));  // slime, gemDropCount=1
    const ctx = makeCtx();
    const events: EnemyDiedEvent[] = [];
    spawnGemFanAndEmitDeath(state, state.enemies.get("42")!, ctx, (e) => {
      if (e.type === "enemy_died") events.push(e);
    });
    expect(state.gems.size).toBe(1);
    const onlyGem = [...state.gems.values()][0]!;
    expect(onlyGem.x).toBe(7);
    expect(onlyGem.z).toBe(11);
    expect(onlyGem.value).toBe(GEM_VALUE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ enemyId: 42, x: 7, z: 11 });
    expect(state.enemies.has("42")).toBe(false);
  });

  it("gemDropCount > 1: spawns N gems in an evenly-spaced ring at GEM_FAN_RADIUS", () => {
    const state = new RoomState();
    // kind=4 is the boss; gemDropCount=15.
    state.enemies.set("42", makeEnemyAt(4, 0, 0));
    const ctx = makeCtx();
    spawnGemFanAndEmitDeath(state, state.enemies.get("42")!, ctx, () => {});
    expect(state.gems.size).toBe(15);
    // Every gem is at distance GEM_FAN_RADIUS from origin.
    for (const g of state.gems.values()) {
      const r = Math.sqrt(g.x * g.x + g.z * g.z);
      expect(r).toBeCloseTo(GEM_FAN_RADIUS, 6);
    }
    // Angles are deterministic — the i=0 gem must be at (+R, 0).
    const gemsSorted = [...state.gems.values()].sort((a, b) => a.id - b.id);
    expect(gemsSorted[0]!.x).toBeCloseTo(GEM_FAN_RADIUS, 6);
    expect(gemsSorted[0]!.z).toBeCloseTo(0, 6);
  });

  it("emits enemy_died exactly once regardless of fan size", () => {
    const state = new RoomState();
    state.enemies.set("42", makeEnemyAt(4, 0, 0));  // boss: 15 gems
    let dies = 0;
    spawnGemFanAndEmitDeath(state, state.enemies.get("42")!, makeCtx(), (e) => {
      if (e.type === "enemy_died") dies++;
    });
    expect(dies).toBe(1);
  });
});
```

Required existing imports already at the top of `rules.test.ts`: `describe`, `it`, `expect` from `vitest`, plus `RoomState`, `Enemy`, `EnemyDiedEvent` etc.

- [ ] **Step 2: Run the new tests**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: 3 new tests PASS; all existing rules tests continue to PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
test(m10): spawnGemFanAndEmitDeath single vs ring + emit-once

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update `tickEnemies` for per-kind speed, flying Y-snap, and ability freeze

**Files:**
- Modify: `packages/shared/src/rules.ts:292-345` (the `tickEnemies` function)

- [ ] **Step 1: Add the helper imports if not already present**

At the top of `rules.ts`, ensure these imports exist:
```ts
import { enemyDefAt } from "./enemies.js";
import { FLYING_ENEMY_ALTITUDE } from "./constants.js";
```

(`enemyDefAt` was added in Task 8 already; `FLYING_ENEMY_ALTITUDE` is new.)

- [ ] **Step 2: Replace `tickEnemies`**

Replace the entire `tickEnemies` function (find it around line 292):

```ts
export function tickEnemies(state: RoomState, dt: number): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  const despawnSq = ENEMY_DESPAWN_RADIUS * ENEMY_DESPAWN_RADIUS;
  const toDespawn: number[] = [];

  state.enemies.forEach((enemy: Enemy) => {
    const def = enemyDefAt(enemy.kind);

    let nearestDx = 0;
    let nearestDz = 0;
    let nearestSq = Infinity;

    state.players.forEach((p: Player) => {
      if (p.downed) return;
      const dx = p.x - enemy.x;
      const dz = p.z - enemy.z;
      const sq = dx * dx + dz * dz;
      if (sq < nearestSq) {
        nearestSq = sq;
        nearestDx = dx;
        nearestDz = dz;
      }
    });

    if (nearestSq === Infinity) {
      // No living players — freeze in place horizontally, but still snap Y.
      enemy.y = terrainHeight(enemy.x, enemy.z)
              + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
      return;
    }
    if (nearestSq > despawnSq) {
      toDespawn.push(enemy.id);
      return;
    }

    // M10: skip movement while winding up a boss ability. abilityFireAt
    // is -1 for non-bosses (set in the schema ctor + spawn paths) so the
    // branch is a no-op for them — single conditional on a int32 field.
    const isWindingUp = enemy.abilityFireAt > 0;

    if (nearestSq !== 0 && !isWindingUp) {
      const dist = Math.sqrt(nearestSq);
      // M10: per-kind speed multiplier. Slime preserves baseline 1.0.
      const step = ENEMY_SPEED * dt * def.speedMultiplier * enemy.slowMultiplier;
      enemy.x += (nearestDx / dist) * step;
      enemy.z += (nearestDz / dist) * step;
    }
    // M10: per-kind terrain snap. Flying enemies float at a constant
    // altitude above whatever ground is beneath them.
    enemy.y = terrainHeight(enemy.x, enemy.z)
            + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
  });

  for (const id of toDespawn) state.enemies.delete(String(id));
}
```

- [ ] **Step 3: Run the existing tickEnemies tests**

```bash
pnpm --filter @mp/shared test -- rules
```

Existing tickEnemies tests (5 of them, listed at `rules.test.ts:141-211`) all exercise slime (kind=0, speedMultiplier=1.0, flying=false, abilityFireAt=-1), so they should PASS unchanged. If any fail, check that `enemyDefAt(0).speedMultiplier === 1.0` matches the slime row.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/rules.ts
git commit -m "$(cat <<'EOF'
feat(m10): tickEnemies per-kind speed, flying Y-snap, ability freeze

Slime baseline behavior preserved (speedMultiplier=1.0, flying=false,
abilityFireAt=-1). Flying enemies (Ghost) snap to terrain + offset.
Windup-frozen bosses (abilityFireAt > 0) skip the movement step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Add tickEnemies tests for the three new behaviors

**Files:**
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Append three new tests inside the `describe("tickEnemies", ...)` block**

Find the existing `describe("tickEnemies", ...)` block (around line 141). After the last existing `it(...)` inside it, add:

```ts
  it("M10: applies per-kind speedMultiplier (Bunny moves 1.5× as fast as Slime)", () => {
    const state = new RoomState();
    const p = new Player(); p.x = 10; p.z = 0;
    state.players.set("p1", p);

    const slime = new Enemy(); slime.id = 1; slime.kind = 0; slime.x = 0; slime.z = 0; slime.maxHp = 30; slime.hp = 30;
    const bunny = new Enemy(); bunny.id = 2; bunny.kind = 1; bunny.x = 0; bunny.z = 1; bunny.maxHp = 10; bunny.hp = 10;
    state.enemies.set("1", slime);
    state.enemies.set("2", bunny);

    const dt = SIM_DT_S;
    tickEnemies(state, dt);

    // Slime moves ENEMY_SPEED * dt * 1.0 = 0.1 units toward the player (along +x).
    expect(slime.x).toBeCloseTo(ENEMY_SPEED * dt * 1.0, 6);
    // Bunny moves 1.5× as fast — but its target direction is at (10, -1) from (0, 1),
    // so its X component is slightly less than (ENEMY_SPEED * dt * 1.5). The ratio
    // |bunny step| / |slime step| should be exactly 1.5.
    const slimeStep = Math.hypot(slime.x, slime.z);
    const bunnyStep = Math.hypot(bunny.x, bunny.z - 1);
    expect(bunnyStep / slimeStep).toBeCloseTo(1.5, 4);
  });

  it("M10: flying enemy Y is pinned to terrainHeight + FLYING_ENEMY_ALTITUDE every tick", () => {
    const state = new RoomState();
    const p = new Player(); p.x = 0; p.z = 0;
    state.players.set("p1", p);
    const ghost = new Enemy(); ghost.id = 3; ghost.kind = 2; ghost.x = 5; ghost.z = 5; ghost.maxHp = 20; ghost.hp = 20;
    state.enemies.set("3", ghost);

    tickEnemies(state, SIM_DT_S);
    // Whatever terrainHeight(x, z) returns, the ghost's y is that + FLYING_ENEMY_ALTITUDE.
    const expectedY = terrainHeight(ghost.x, ghost.z) + FLYING_ENEMY_ALTITUDE;
    expect(ghost.y).toBeCloseTo(expectedY, 6);
  });

  it("M10: enemy with abilityFireAt > 0 does NOT move (windup freeze)", () => {
    const state = new RoomState();
    state.tick = 100;
    const p = new Player(); p.x = 10; p.z = 0;
    state.players.set("p1", p);
    const boss = new Enemy();
    boss.id = 4; boss.kind = 4; boss.x = 0; boss.z = 0;
    boss.maxHp = 2000; boss.hp = 2000;
    boss.abilityFireAt = 120;  // windup; > 0
    state.enemies.set("4", boss);

    const startX = boss.x;
    const startZ = boss.z;
    tickEnemies(state, SIM_DT_S);
    expect(boss.x).toBe(startX);
    expect(boss.z).toBe(startZ);
    // Y-snap still happens — boss is not flying, so it lands on terrain.
    expect(boss.y).toBeCloseTo(terrainHeight(boss.x, boss.z) + ENEMY_GROUND_OFFSET, 6);
  });
```

Required additional imports at the top of the test file:
```ts
import { FLYING_ENEMY_ALTITUDE, SIM_DT_S, ENEMY_SPEED, ENEMY_GROUND_OFFSET } from "../src/constants.js";
import { terrainHeight } from "../src/terrain.js";
```

(Most are likely already imported — verify before adding duplicates.)

- [ ] **Step 2: Run the rules tests**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: 3 new tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
test(m10): tickEnemies per-kind speed, flying Y-snap, windup freeze

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Update `tickSpawner` for weighted kind pick and per-kind spawn stats

**Files:**
- Modify: `packages/shared/src/rules.ts:367-425` (the `tickSpawner` function)

- [ ] **Step 1: Add `pickEnemyKind` as a private (non-exported) helper above `tickSpawner`**

In `rules.ts`, just above the existing `tickSpawner` function (around line 367), add:

```ts
/**
 * M10: weighted-random kind pick over the currently-unlocked, non-boss
 * rows of ENEMY_KINDS. Single rng() call per pick. Deterministic
 * single-pass filter + accumulate — the loop runs ENEMY_KINDS.length
 * iterations regardless of which kind is picked, so spawn behavior is
 * order-independent across server/client (which both run the same
 * shared code via @mp/shared, but the discipline still matters because
 * client-side simulation is a future possibility).
 *
 * If totalWeight === 0 (e.g., earliest tick with no kinds unlocked
 * yet), falls back to kind 0 (slime), which is always spawnable at
 * tick=0 since its minSpawnTick is 0 and spawnWeight is positive.
 */
function pickEnemyKind(currentTick: number, rng: Rng): number {
  let totalWeight = 0;
  for (let i = 0; i < ENEMY_KINDS.length; i++) {
    const def = ENEMY_KINDS[i]!;
    if (def.isBoss) continue;
    if (currentTick < def.minSpawnTick) continue;
    totalWeight += def.spawnWeight;
  }
  if (totalWeight <= 0) return 0;
  let r = rng() * totalWeight;
  for (let i = 0; i < ENEMY_KINDS.length; i++) {
    const def = ENEMY_KINDS[i]!;
    if (def.isBoss) continue;
    if (currentTick < def.minSpawnTick) continue;
    r -= def.spawnWeight;
    if (r <= 0) return i;
  }
  // Unreachable in practice given totalWeight > 0; static fallback for
  // floating-point edge cases.
  return 0;
}
```

Add the import if not already present:
```ts
import { ENEMY_KINDS } from "./enemies.js";
```

- [ ] **Step 2: Update `tickSpawner` to use the kind pick and per-kind stats**

Replace the existing per-spawn body inside the `while (spawner.accumulator >= ENEMY_SPAWN_INTERVAL_S)` loop. The OLD body inside the angle retry loop:

```ts
      const enemy = new Enemy();
      enemy.id = spawner.nextEnemyId++;
      enemy.kind = 0;
      enemy.x = x;
      enemy.z = z;
      enemy.y = terrainHeight(x, z) + ENEMY_GROUND_OFFSET;
      enemy.hp = ENEMY_HP;
      state.enemies.set(String(enemy.id), enemy);
      placed = true;
```

becomes:

```ts
      // M10: kind pick happens BEFORE the player + angle picks so the
      // existing tickXp + tickSpawner rng schedule is "kind, player,
      // angles..." per spawn. Spec §AD6.
      const kind = pickEnemyKind(state.tick, rng);
      const def = enemyDefAt(kind);
      const enemy = new Enemy();
      enemy.id = spawner.nextEnemyId++;
      enemy.kind = kind;
      enemy.x = x;
      enemy.z = z;
      enemy.y = terrainHeight(x, z)
              + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
      enemy.hp = def.baseHp;
      enemy.maxHp = def.baseHp;
      state.enemies.set(String(enemy.id), enemy);
      placed = true;
```

Now MOVE the kind pick OUTSIDE the angle retry loop — it must happen only once per spawn attempt, NOT once per angle retry, otherwise a retry would re-roll the kind and consume more rng. The correct shape:

```ts
  while (spawner.accumulator >= ENEMY_SPAWN_INTERVAL_S) {
    if (state.enemies.size >= MAX_ENEMIES) {
      spawner.accumulator = 0;
      return;
    }

    // M10: kind pick — 1 rng() call. Must happen BEFORE the player + angle
    // picks; placed outside the angle retry loop so each spawn attempt
    // picks one kind regardless of how many angle retries it takes.
    const kind = pickEnemyKind(state.tick, rng);
    const def = enemyDefAt(kind);

    // Pick a random non-downed player. (unchanged)
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
      enemy.kind = kind;
      enemy.x = x;
      enemy.z = z;
      enemy.y = terrainHeight(x, z)
              + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
      enemy.hp = def.baseHp;
      enemy.maxHp = def.baseHp;
      state.enemies.set(String(enemy.id), enemy);
      placed = true;
    }

    spawner.accumulator -= ENEMY_SPAWN_INTERVAL_S;
  }
```

- [ ] **Step 3: Update `spawnDebugBurst` to honor per-kind stats**

The existing `spawnDebugBurst` (around line 433) sets `enemy.hp = ENEMY_HP` unconditionally. Update it to read per-kind stats too:

```ts
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
  const def = enemyDefAt(kind);

  for (let i = 0; i < n; i++) {
    const angle = rng() * Math.PI * 2;
    const enemy = new Enemy();
    enemy.id = spawner.nextEnemyId++;
    enemy.kind = kind;
    enemy.x = centerPlayer.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
    enemy.z = centerPlayer.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
    enemy.y = terrainHeight(enemy.x, enemy.z)
            + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
    enemy.hp = def.baseHp;
    enemy.maxHp = def.baseHp;
    state.enemies.set(String(enemy.id), enemy);
  }
}
```

- [ ] **Step 4: Run the rules tests — expect the M3 determinism test to FAIL**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected behavior:
- Most tests PASS.
- The test "produces reproducible spawn positions from a fixed seed" (M3, around line 250) FAILS — its expected (x, z) values were derived with the old rng schedule (no kind pick). This is documented in the spec §AD6 "Existing test impact" and is fixed in Task 13.
- The test "spawns exactly one enemy at the spawn interval" may also drift if it asserts specific positions; the looser version that asserts only "one enemy and it's at the spawn radius" continues to PASS.

If anything OTHER than the documented determinism test fails, stop and diagnose — likely a missing per-kind stat read site.

- [ ] **Step 5: Commit (with FAIL noted)**

```bash
git add packages/shared/src/rules.ts
git commit -m "$(cat <<'EOF'
feat(m10): tickSpawner weighted kind pick + per-kind spawn stats

Kind picked first via pickEnemyKind (1 new rng() call per spawn).
Spawn applies per-kind baseHp, maxHp, and flying-altitude rules.
spawnDebugBurst updated to honor per-kind stats.

Known fail: M3 determinism test ("produces reproducible spawn
positions from a fixed seed") — expected values need regeneration
per spec §AD6. Regenerated in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Regenerate the M3 determinism test's expected values

**Files:**
- Modify: `packages/shared/test/rules.test.ts:250-280` (the "produces reproducible spawn positions from a fixed seed" test)

- [ ] **Step 1: Find the test and read its current expected values**

Open `rules.test.ts`, find the test around line 250. The test should look something like:

```ts
  it("produces reproducible spawn positions from a fixed seed", () => {
    const state = new RoomState();
    /* ... setup ... */
    const rng = mulberry32(42);
    /* ... five spawns ... */
    expect(/* enemy 1 x, z */).toEqual(/* ... */);
    /* ... etc ... */
  });
```

- [ ] **Step 2: Convert the test to a "snapshot" shape that prints the actual values**

Temporarily replace the assertions with a `console.log` of the actual tuples (one-time observation step):

```ts
    const spawned = [...state.enemies.values()].map(e => ({
      kind: e.kind, x: Number(e.x.toFixed(6)), z: Number(e.z.toFixed(6)),
    }));
    console.log("M10 expected spawns:", JSON.stringify(spawned));
    expect(spawned).toHaveLength(5);  // weaker assertion until values harvested
```

- [ ] **Step 3: Run the test, capture the printed values**

```bash
pnpm --filter @mp/shared test -- rules.test 2>&1 | grep -A1 "M10 expected"
```

Expected: the test prints an array of 5 entries with the new deterministic kind+position values (e.g., `[{kind:0,x:..,z:..},{kind:0,x:..,z:..},...]`).

- [ ] **Step 4: Paste the harvested values back into the test as the new expected**

Replace the snapshot logging with the exact tuples. Example shape (your actual numbers will differ):

```ts
  it("produces reproducible spawn positions from a fixed seed (regenerated for M10 kind-pick rng)", () => {
    const state = new RoomState();
    /* ... unchanged setup ... */
    const rng = mulberry32(42);
    /* ... five spawns ... */
    const spawned = [...state.enemies.values()].map(e => ({
      kind: e.kind,
      x: Number(e.x.toFixed(6)),
      z: Number(e.z.toFixed(6)),
    }));
    expect(spawned).toEqual([
      { kind: 0, x: /*REGENERATED*/, z: /*REGENERATED*/ },
      { kind: 0, x: /*REGENERATED*/, z: /*REGENERATED*/ },
      { kind: 0, x: /*REGENERATED*/, z: /*REGENERATED*/ },
      { kind: 0, x: /*REGENERATED*/, z: /*REGENERATED*/ },
      { kind: 0, x: /*REGENERATED*/, z: /*REGENERATED*/ },
    ]);
  });
```

If the test ran at `state.tick === 0`, all five kinds will be `0` (slime) because only slime has `minSpawnTick === 0` AND `spawnWeight > 0`. The kind-pick rng call still happens (1 call per spawn) — it's the position-affecting part of the rng schedule.

Add a comment:
```ts
  // Expected values regenerated for M10: tickSpawner now consumes 1
  // additional rng() call per spawn for the kind pick (per spec §AD6),
  // shifting the player + angle picks downstream in the rng sequence.
```

- [ ] **Step 5: Run the test to confirm PASS**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: ALL tests PASS, including the regenerated determinism test.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
test(m10): regenerate M3 spawn-determinism expected values

Spec §AD6: tickSpawner consumes 1 additional rng() call per spawn
(kind pick), shifting the player + angle picks. Test purpose
(end-to-end determinism across rng consumers) preserved; only the
literal tuples change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Add new `tickSpawner` tests for weighted pick + time gates + per-kind stats

**Files:**
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Append new tests inside `describe("tickSpawner", ...)`**

```ts
  it("M10: respects minSpawnTick — Bunny (kind=1, minSpawnTick=600) doesn't spawn at tick=599", () => {
    const state = new RoomState();
    state.tick = 599;
    const p = new Player(); p.x = 0; p.z = 0;
    state.players.set("p1", p);
    const spawner: SpawnerState = { accumulator: ENEMY_SPAWN_INTERVAL_S, nextEnemyId: 1 };
    const rng = mulberry32(123);
    tickSpawner(state, spawner, 0, rng);
    expect(state.enemies.size).toBe(1);
    // Only kind=0 was unlocked at tick=599; spawn must be a slime.
    const only = [...state.enemies.values()][0]!;
    expect(only.kind).toBe(0);
  });

  it("M10: per-kind stats applied at spawn — Bunny has baseHp=10, maxHp=10", () => {
    const state = new RoomState();
    state.tick = 30 * 20;  // bunny unlock tick exactly
    const p = new Player(); p.x = 0; p.z = 0;
    state.players.set("p1", p);
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };
    spawnDebugBurst(state, spawner, mulberry32(1), p, 1, 1);  // force kind=1
    expect(state.enemies.size).toBe(1);
    const e = [...state.enemies.values()][0]!;
    expect(e.kind).toBe(1);
    expect(e.hp).toBe(10);
    expect(e.maxHp).toBe(10);
  });

  it("M10: flying enemy spawn Y is terrainHeight + FLYING_ENEMY_ALTITUDE", () => {
    const state = new RoomState();
    const p = new Player(); p.x = 0; p.z = 0;
    state.players.set("p1", p);
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };
    spawnDebugBurst(state, spawner, mulberry32(1), p, 1, 2);  // kind=2 = Ghost
    const e = [...state.enemies.values()][0]!;
    expect(e.kind).toBe(2);
    expect(e.y).toBeCloseTo(terrainHeight(e.x, e.z) + FLYING_ENEMY_ALTITUDE, 6);
  });

  it("M10: weighted pick distribution over many spawns approximates kind weights", () => {
    const state = new RoomState();
    state.tick = 150 * 20;  // all non-boss kinds unlocked
    const p = new Player(); p.x = 0; p.z = 0;
    state.players.set("p1", p);
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };
    const rng = mulberry32(7);

    const counts = new Map<number, number>();
    const TRIALS = 1200;
    for (let i = 0; i < TRIALS; i++) {
      spawner.accumulator = ENEMY_SPAWN_INTERVAL_S;
      tickSpawner(state, spawner, 0, rng);
      // Read the just-spawned enemy and remove it so MAX_ENEMIES doesn't cap.
      const newest = [...state.enemies.values()].pop()!;
      counts.set(newest.kind, (counts.get(newest.kind) ?? 0) + 1);
      state.enemies.clear();
    }
    const totalW = 60 + 30 + 20 + 15;  // slime + bunny + ghost + skeleton
    expect(counts.get(0)! / TRIALS).toBeCloseTo(60 / totalW, 1);
    expect(counts.get(1)! / TRIALS).toBeCloseTo(30 / totalW, 1);
    expect(counts.get(2)! / TRIALS).toBeCloseTo(20 / totalW, 1);
    expect(counts.get(3)! / TRIALS).toBeCloseTo(15 / totalW, 1);
    // No boss spawns from tickSpawner — boss is spawnWeight=0.
    expect(counts.get(4) ?? 0).toBe(0);
  });

  it("M10: boss kind never spawned by tickSpawner (spawnWeight=0)", () => {
    const state = new RoomState();
    state.tick = 1_000_000;  // past every gate
    const p = new Player(); p.x = 0; p.z = 0;
    state.players.set("p1", p);
    const spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      spawner.accumulator = ENEMY_SPAWN_INTERVAL_S;
      tickSpawner(state, spawner, 0, rng);
    }
    for (const e of state.enemies.values()) {
      expect(e.kind).not.toBe(BOSS_KIND_INDEX);
    }
  });
```

Required import additions (top of test file, if not already present):
```ts
import { BOSS_KIND_INDEX } from "../src/enemies.js";
```

- [ ] **Step 2: Run the new tests**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: all 5 new tests PASS. The weighted-distribution test uses a tolerance of `1` decimal place (`toBeCloseTo(..., 1)`) which corresponds to ±0.05 — comfortable margin for 1200 trials.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
test(m10): tickSpawner weighted pick, time gates, per-kind stats

Five new tests: minSpawnTick gate, per-kind baseHp/maxHp at spawn,
flying spawn Y, weighted-distribution approximation, and boss
exclusion from regular spawner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Update `tickContactDamage` to read per-kind contactDamage + radius

**Files:**
- Modify: `packages/shared/src/rules.ts:2125-2170` (`tickContactDamage`)

- [ ] **Step 1: Replace the function body**

Find `tickContactDamage` (around line 2125). Replace its body:

```ts
export function tickContactDamage(
  state: RoomState,
  cooldown: ContactCooldownLike,
  _dt: number,
  nowMs: number,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const cooldownMs = ENEMY_CONTACT_COOLDOWN_S * 1000;

  state.players.forEach((player: Player) => {
    if (player.downed) return;

    state.enemies.forEach((enemy: Enemy) => {
      // M10: per-kind radius. Slime preserves baseline 0.5 (ENEMY_RADIUS).
      const def = enemyDefAt(enemy.kind);
      const radiusSum = PLAYER_RADIUS + def.radius;
      const radiusSumSq = radiusSum * radiusSum;

      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      if (dx * dx + dz * dz > radiusSumSq) return;
      if (!cooldown.tryHit(player.sessionId, enemy.id, nowMs, cooldownMs)) return;

      // M10: per-kind contact damage. Slime preserves baseline 5 (ENEMY_CONTACT_DAMAGE).
      const damage = Math.min(player.hp, def.contactDamage);
      player.hp -= damage;
      emit({
        type: "player_damaged",
        playerId: player.sessionId,
        damage,
        x: player.x,
        y: player.y,
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

- [ ] **Step 2: Run existing contact-damage tests to confirm baseline preserved**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: existing slime-contact-damage tests PASS. Baseline (`enemyDefAt(0).contactDamage === 5`, `enemyDefAt(0).radius === 0.5`) matches the M6 constants exactly.

- [ ] **Step 3: Add one new test for per-kind contact damage**

Append inside `describe("tickContactDamage", ...)` (find the existing block, or create one if absent):

```ts
  it("M10: applies per-kind contactDamage — Skeleton deals 10, not the slime baseline 5", () => {
    const state = new RoomState();
    const p = new Player(); p.x = 0; p.z = 0; p.hp = 100;
    state.players.set("p1", p);
    const sk = new Enemy(); sk.id = 1; sk.kind = 3; sk.x = 0; sk.z = 0; sk.maxHp = 80; sk.hp = 80;
    state.enemies.set("1", sk);

    const events: PlayerDamagedEvent[] = [];
    const cooldown: ContactCooldownLike = { tryHit: () => true };
    tickContactDamage(state, cooldown, SIM_DT_S, /*nowMs*/0, (e) => {
      if (e.type === "player_damaged") events.push(e);
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.damage).toBe(10);
    expect(p.hp).toBe(90);
  });
```

- [ ] **Step 4: Run the new test**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(m10): tickContactDamage per-kind damage + radius

Slime baseline preserved (5 dmg, 0.5 radius). Test asserts Skeleton
deals 10 dmg.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Add `tickBossAbilities` (idle → windup → fire state machine)

**Files:**
- Modify: `packages/shared/src/rules.ts` (append new function)

- [ ] **Step 1: Write the failing test first**

In `packages/shared/test/rules.test.ts`, append:

```ts
describe("tickBossAbilities", () => {
  it("idle → windup: emits boss_telegraph and sets abilityFireAt", () => {
    const state = new RoomState();
    state.tick = 100;
    const boss = new Enemy();
    boss.id = 1; boss.kind = BOSS_KIND_INDEX; boss.x = 5; boss.z = 7;
    boss.maxHp = 2000; boss.hp = 2000; boss.abilityFireAt = -1;
    state.enemies.set("1", boss);

    // Cooldown elapsed: nextReadyTick (in cooldown map) was set to a tick <= now.
    const bossCooldowns = new Map<number, number>();
    bossCooldowns.set(1, 100);  // ready exactly this tick

    const events: (BossTelegraphEvent | BossAoeHitEvent | PlayerDamagedEvent | PlayerDownedEvent)[] = [];
    tickBossAbilities(state, state.tick, bossCooldowns, /*nowMs*/0, (e) => events.push(e as any));

    const def = enemyDefAt(BOSS_KIND_INDEX);
    expect(boss.abilityFireAt).toBe(state.tick + def.bossAbilityWindupTicks);
    const tele = events.find(e => e.type === "boss_telegraph") as BossTelegraphEvent | undefined;
    expect(tele).toBeDefined();
    expect(tele!.bossId).toBe(1);
    expect(tele!.radius).toBe(def.bossAbilityRadius);
    expect(tele!.originX).toBe(5);
    expect(tele!.originZ).toBe(7);
  });

  it("currentTick === abilityFireAt: fires — damages players in radius, emits boss_aoe_hit + player_damaged, resets state", () => {
    const state = new RoomState();
    state.tick = 120;
    const boss = new Enemy();
    boss.id = 1; boss.kind = BOSS_KIND_INDEX; boss.x = 0; boss.z = 0;
    boss.maxHp = 2000; boss.hp = 2000; boss.abilityFireAt = 120;  // fire NOW
    state.enemies.set("1", boss);

    const inside = new Player(); inside.sessionId = "in"; inside.x = 2; inside.z = 0; inside.hp = 100; inside.maxHp = 100;
    const outside = new Player(); outside.sessionId = "out"; outside.x = 10; outside.z = 0; outside.hp = 100; outside.maxHp = 100;
    state.players.set("in", inside);
    state.players.set("out", outside);

    const bossCooldowns = new Map<number, number>();
    bossCooldowns.set(1, 0);  // already ready (but boss is already in windup)

    const events: any[] = [];
    tickBossAbilities(state, state.tick, bossCooldowns, /*nowMs*/0, (e) => events.push(e));

    const def = enemyDefAt(BOSS_KIND_INDEX);
    // Inside player took damage; outside didn't.
    expect(inside.hp).toBe(100 - def.bossAbilityDamage);
    expect(outside.hp).toBe(100);
    // One boss_aoe_hit + exactly one player_damaged.
    expect(events.filter(e => e.type === "boss_aoe_hit")).toHaveLength(1);
    const dmg = events.filter(e => e.type === "player_damaged");
    expect(dmg).toHaveLength(1);
    expect(dmg[0].playerId).toBe("in");
    // State reset.
    expect(boss.abilityFireAt).toBe(-1);
    expect(bossCooldowns.get(1)).toBe(state.tick + def.bossAbilityCooldownTicks);
  });

  it("non-boss enemies are ignored even if abilityFireAt > 0 spuriously", () => {
    const state = new RoomState();
    state.tick = 50;
    const slime = new Enemy();
    slime.id = 9; slime.kind = 0; slime.abilityFireAt = 999; slime.x = 0; slime.z = 0;
    slime.maxHp = 30; slime.hp = 30;
    state.enemies.set("9", slime);
    const events: any[] = [];
    tickBossAbilities(state, state.tick, new Map(), 0, (e) => events.push(e));
    expect(events).toHaveLength(0);
    // abilityFireAt unchanged — non-bosses are no-ops.
    expect(slime.abilityFireAt).toBe(999);
  });

  it("windup phase: still pending, no emit, abilityFireAt unchanged", () => {
    const state = new RoomState();
    state.tick = 105;
    const boss = new Enemy();
    boss.id = 1; boss.kind = BOSS_KIND_INDEX; boss.abilityFireAt = 120;  // 15 ticks until fire
    boss.maxHp = 2000; boss.hp = 2000;
    state.enemies.set("1", boss);
    const events: any[] = [];
    tickBossAbilities(state, state.tick, new Map([[1, 100]]), 0, (e) => events.push(e));
    expect(events).toHaveLength(0);
    expect(boss.abilityFireAt).toBe(120);
  });

  it("early-outs on state.runEnded", () => {
    const state = new RoomState();
    state.runEnded = true;
    const boss = new Enemy();
    boss.id = 1; boss.kind = BOSS_KIND_INDEX; boss.abilityFireAt = -1;
    state.enemies.set("1", boss);
    const events: any[] = [];
    tickBossAbilities(state, 0, new Map([[1, -1]]), 0, (e) => events.push(e));
    expect(events).toHaveLength(0);
    expect(boss.abilityFireAt).toBe(-1);
  });
});
```

Required import additions:
```ts
import { tickBossAbilities, type BossSpawnerState } from "../src/rules.js";
import type { BossTelegraphEvent, BossAoeHitEvent } from "../src/messages.js";
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: 5 new tests FAIL with `tickBossAbilities is not a function` (or similar — the symbol doesn't exist yet).

- [ ] **Step 3: Implement `tickBossAbilities` in `rules.ts`**

Append to `packages/shared/src/rules.ts` (any location after `tickEnemies`):

```ts
/**
 * M10: boss telegraphed-ability state machine. Idle → windup → fire,
 * one ability per boss per cooldown cycle. Consumes NO rng — telegraph
 * timing is deterministic from the off-schema cooldown map; AoE is a
 * radius check.
 *
 *   - `currentTick` — state.tick, used for cooldown gating and the
 *     fireAt countdown.
 *   - `bossCooldowns` — off-schema Map<bossId, nextReadyTick>. Caller
 *     initializes entries on boss spawn (set to currentTick +
 *     cooldownTicks so the FIRST ability triggers one cooldown after
 *     spawn, not immediately). Caller deletes entries on boss death
 *     cleanup (in tickBossSpawner). This function only reads and
 *     mutates existing entries.
 *   - `nowMs` — server Date.now() at tick start. Embedded into
 *     boss_telegraph.fireServerTimeMs so clients can sync the ring
 *     fill across the network via ServerTime offset.
 *   - `emit` — broadcast hook for boss_telegraph, boss_aoe_hit,
 *     player_damaged, player_downed.
 *
 * Per CLAUDE.md rule 11, this runs between tickEnemies and
 * tickContactDamage so the AoE strikes post-movement player positions
 * and the boss's frozen-windup state is established before contact
 * damage runs.
 */
export function tickBossAbilities(
  state: RoomState,
  currentTick: number,
  bossCooldowns: Map<number, number>,
  nowMs: number,
  emit: Emit,
): void {
  if (state.runEnded) return;

  state.enemies.forEach((enemy: Enemy) => {
    const def = enemyDefAt(enemy.kind);
    if (!def.isBoss) return;

    if (enemy.abilityFireAt === -1) {
      // Idle. Check cooldown — if ready, enter windup.
      const nextReadyTick = bossCooldowns.get(enemy.id);
      if (nextReadyTick === undefined) {
        // No cooldown entry — caller (tickBossSpawner) should have
        // initialized one on spawn. Defensive: initialize to one
        // cooldown from now so we don't immediately fire.
        bossCooldowns.set(enemy.id, currentTick + def.bossAbilityCooldownTicks);
        return;
      }
      if (currentTick < nextReadyTick) return;

      // Enter windup. abilityFireAt = currentTick + windupTicks.
      enemy.abilityFireAt = currentTick + def.bossAbilityWindupTicks;
      const windupMs = (def.bossAbilityWindupTicks / TICK_RATE) * 1000;
      emit({
        type: "boss_telegraph",
        bossId: enemy.id,
        originX: enemy.x,
        originZ: enemy.z,
        radius: def.bossAbilityRadius,
        fireServerTimeMs: nowMs + windupMs,
        serverTick: currentTick,
      });
      return;
    }

    // abilityFireAt > 0 — winding up. If it's not fire-tick yet, wait.
    if (currentTick !== enemy.abilityFireAt) return;

    // Fire! Apply AoE damage to every non-downed player in radius (2D XZ).
    const radiusSq = def.bossAbilityRadius * def.bossAbilityRadius;
    state.players.forEach((player: Player) => {
      if (player.downed) return;
      const dx = player.x - enemy.x;
      const dz = player.z - enemy.z;
      if (dx * dx + dz * dz > radiusSq) return;

      const damage = Math.min(player.hp, def.bossAbilityDamage);
      player.hp -= damage;
      emit({
        type: "player_damaged",
        playerId: player.sessionId,
        damage,
        x: player.x,
        y: player.y,
        z: player.z,
        serverTick: currentTick,
      });

      if (player.hp <= 0 && !player.downed) {
        player.downed = true;
        player.inputDir.x = 0;
        player.inputDir.z = 0;
        emit({
          type: "player_downed",
          playerId: player.sessionId,
          serverTick: currentTick,
        });
      }
    });

    emit({
      type: "boss_aoe_hit",
      bossId: enemy.id,
      originX: enemy.x,
      originZ: enemy.z,
      radius: def.bossAbilityRadius,
      serverTick: currentTick,
    });

    // Reset for next cycle.
    enemy.abilityFireAt = -1;
    bossCooldowns.set(enemy.id, currentTick + def.bossAbilityCooldownTicks);
  });
}
```

- [ ] **Step 4: Run the tests to confirm PASS**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: all 5 tickBossAbilities tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(m10): add tickBossAbilities — idle → windup → fire state machine

Boss telegraphs for windupTicks (1s @ 20Hz), then fires AoE radius
damage to all non-downed players in radius. Emits boss_telegraph,
boss_aoe_hit, plus existing player_damaged / player_downed paths.
NO rng — deterministic timing, radius gate, no rolls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Add `tickBossSpawner` (spawn + 1-alive cap + death cleanup)

**Files:**
- Modify: `packages/shared/src/rules.ts` (append new types + function)

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/rules.test.ts`:

```ts
describe("tickBossSpawner", () => {
  function makeBossSpawnerState(nextBossAt: number, aliveBossId: number = -1): BossSpawnerState {
    return { nextBossAt, aliveBossId };
  }
  function makeRoom(): { state: RoomState; spawner: SpawnerState } {
    const state = new RoomState();
    const p = new Player(); p.sessionId = "p1"; p.x = 0; p.z = 0;
    state.players.set("p1", p);
    return { state, spawner: { accumulator: 0, nextEnemyId: 1 } };
  }

  it("does NOT spawn before nextBossAt", () => {
    const { state, spawner } = makeRoom();
    const bossSpawner = makeBossSpawnerState(100);
    state.tick = 99;
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(1), spawner, new Map());
    expect(state.enemies.size).toBe(0);
    expect(bossSpawner.aliveBossId).toBe(-1);
  });

  it("spawns exactly one boss at nextBossAt with correct stats", () => {
    const { state, spawner } = makeRoom();
    const bossSpawner = makeBossSpawnerState(100);
    state.tick = 100;
    const cooldowns = new Map<number, number>();
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(1), spawner, cooldowns);
    expect(state.enemies.size).toBe(1);
    const boss = [...state.enemies.values()][0]!;
    expect(boss.kind).toBe(BOSS_KIND_INDEX);
    const def = enemyDefAt(BOSS_KIND_INDEX);
    expect(boss.hp).toBe(def.baseHp);
    expect(boss.maxHp).toBe(def.baseHp);
    expect(boss.abilityFireAt).toBe(-1);
    expect(bossSpawner.aliveBossId).toBe(boss.id);
    // Cooldown initialized — first ability after one cooldown from spawn.
    expect(cooldowns.get(boss.id)).toBe(state.tick + def.bossAbilityCooldownTicks);
  });

  it("second boss does NOT spawn while first is alive", () => {
    const { state, spawner } = makeRoom();
    const bossSpawner = makeBossSpawnerState(100);
    state.tick = 100;
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(1), spawner, new Map());
    expect(state.enemies.size).toBe(1);

    // Tick forward way past nextBossAt — still only one alive.
    state.tick = 100 + BOSS_INTERVAL_TICKS * 5;
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(2), spawner, new Map());
    expect(state.enemies.size).toBe(1);
  });

  it("death cleanup: resets aliveBossId and schedules next spawn one interval later", () => {
    const { state, spawner } = makeRoom();
    const bossSpawner = makeBossSpawnerState(100);
    state.tick = 100;
    const cooldowns = new Map<number, number>();
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(1), spawner, cooldowns);
    const bossId = bossSpawner.aliveBossId;
    expect(bossId).not.toBe(-1);

    // Simulate boss death (some other tick fn killed it).
    state.enemies.delete(String(bossId));
    state.tick = 150;
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(99), spawner, cooldowns);
    expect(bossSpawner.aliveBossId).toBe(-1);
    expect(bossSpawner.nextBossAt).toBe(state.tick + BOSS_INTERVAL_TICKS);
    // Cooldown entry for the dead boss is purged.
    expect(cooldowns.has(bossId)).toBe(false);
  });

  it("no spawn when all players are downed", () => {
    const { state, spawner } = makeRoom();
    state.players.get("p1")!.downed = true;
    const bossSpawner = makeBossSpawnerState(100);
    state.tick = 100;
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(1), spawner, new Map());
    expect(state.enemies.size).toBe(0);
    expect(bossSpawner.aliveBossId).toBe(-1);
  });

  it("early-outs on state.runEnded", () => {
    const { state, spawner } = makeRoom();
    state.runEnded = true;
    const bossSpawner = makeBossSpawnerState(0);
    state.tick = 0;
    tickBossSpawner(state, bossSpawner, state.tick, mulberry32(1), spawner, new Map());
    expect(state.enemies.size).toBe(0);
  });
});
```

Add the import:
```ts
import { tickBossSpawner, type BossSpawnerState } from "../src/rules.js";
import { BOSS_INTERVAL_TICKS } from "../src/constants.js";
```

- [ ] **Step 2: Run tests — confirm failures**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: 6 new tests FAIL (`tickBossSpawner is not a function`).

- [ ] **Step 3: Implement `tickBossSpawner` + `BossSpawnerState` type**

Append to `packages/shared/src/rules.ts`:

```ts
/**
 * M10: server-only boss-spawn state. Lives on GameRoom, NOT on
 * RoomState (server-only counters don't pollute the schema). Spec §AD3.
 *
 *   nextBossAt   — tick at which to attempt the next boss spawn.
 *                  Initialized to BOSS_INTERVAL_TICKS so the first
 *                  boss spawns at T=BOSS_INTERVAL seconds, not T=0.
 *   aliveBossId  — id of the currently-alive boss, or -1 if none.
 *                  Enforces the 1-alive-at-a-time invariant.
 */
export type BossSpawnerState = {
  nextBossAt: number;
  aliveBossId: number;
};

/**
 * M10: paired boss spawn / death cleanup. Runs LAST in the tick order
 * (after tickSpawner) so its rng consumption appends to the schedule
 * rather than reordering existing consumers (spec §AD7).
 *
 * Death cleanup uses the post-condition check (spec §AD4): if the
 * recorded alive boss is no longer in state.enemies, it died last tick.
 * Reset aliveBossId and schedule the next spawn at currentTick +
 * BOSS_INTERVAL_TICKS. Also evict the dead boss's bossCooldowns entry.
 *
 * Spawn uses the same rng-driven player + angle pattern as tickSpawner.
 *   - 1 rng() for live-player pick
 *   - 1 rng() for angle (single attempt; no map-radius retry — bosses
 *     can spawn anywhere within the map without the retry loop, and
 *     a once-per-3-minutes event tolerates a slot skip in the rare
 *     edge case).
 *
 * Shares `spawner.nextEnemyId++` so boss ids are unique within the
 * Enemy.id space.
 */
export function tickBossSpawner(
  state: RoomState,
  bossSpawner: BossSpawnerState,
  currentTick: number,
  rng: Rng,
  spawner: SpawnerState,
  bossCooldowns: Map<number, number>,
): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  // --- Cleanup: did our recorded alive boss die last tick? ---
  if (
    bossSpawner.aliveBossId !== -1
    && !state.enemies.has(String(bossSpawner.aliveBossId))
  ) {
    bossCooldowns.delete(bossSpawner.aliveBossId);
    bossSpawner.aliveBossId = -1;
    bossSpawner.nextBossAt = currentTick + BOSS_INTERVAL_TICKS;
  }

  // --- Spawn gate ---
  if (bossSpawner.aliveBossId !== -1) return;
  if (currentTick < bossSpawner.nextBossAt) return;

  // Count + pick a random non-downed player.
  let liveCount = 0;
  state.players.forEach((p) => { if (!p.downed) liveCount += 1; });
  if (liveCount === 0) return;

  const liveIdx = Math.floor(rng() * liveCount);
  let i = 0;
  let target: Player | undefined;
  state.players.forEach((p) => {
    if (p.downed) return;
    if (i === liveIdx) target = p;
    i++;
  });
  if (!target) return;  // defensive

  const angle = rng() * Math.PI * 2;
  const def = enemyDefAt(BOSS_KIND_INDEX);
  const enemy = new Enemy();
  enemy.id = spawner.nextEnemyId++;
  enemy.kind = BOSS_KIND_INDEX;
  enemy.x = target.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
  enemy.z = target.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
  enemy.y = terrainHeight(enemy.x, enemy.z)
          + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
  enemy.hp = def.baseHp;
  enemy.maxHp = def.baseHp;
  enemy.abilityFireAt = -1;
  state.enemies.set(String(enemy.id), enemy);

  bossSpawner.aliveBossId = enemy.id;
  // Initialize cooldown so the first ability triggers AFTER one
  // cooldown period (not immediately on spawn).
  bossCooldowns.set(enemy.id, currentTick + def.bossAbilityCooldownTicks);
}
```

Required imports (top of `rules.ts`, if not already present):
```ts
import { BOSS_KIND_INDEX, enemyDefAt } from "./enemies.js";
import { BOSS_INTERVAL_TICKS, FLYING_ENEMY_ALTITUDE } from "./constants.js";
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
pnpm --filter @mp/shared test -- rules
```

Expected: 6 new tickBossSpawner tests PASS. All previous rules tests continue to PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "$(cat <<'EOF'
feat(m10): add tickBossSpawner — paired spawn + death cleanup

Recurring boss spawn at BOSS_INTERVAL_TICKS cadence with 1-alive
invariant. Death detected via state.enemies post-condition check
(spec §AD4) — no need to thread bossSpawner into every kill site.
bossCooldowns lifecycle: init on spawn, delete on cleanup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Build dist to make new exports visible to server

**Files:**
- (build artifact only — no source files)

- [ ] **Step 1: Build the shared package**

```bash
pnpm --filter @mp/shared build
```

Expected: builds without errors. New exports (`tickBossAbilities`, `tickBossSpawner`, `BossSpawnerState`, `spawnGemFanAndEmitDeath`, `BOSS_INTERVAL_TICKS`, `FLYING_ENEMY_ALTITUDE`, `GEM_FAN_RADIUS`, `ENEMY_KINDS`, `enemyDefAt`, `BOSS_KIND_INDEX`, `BossTelegraphEvent`, `BossAoeHitEvent`) appear in `packages/shared/dist/`. Per CLAUDE.md "Stale dist landmine" — server's `@mp/shared` imports won't see these until dist is rebuilt.

- [ ] **Step 2: Workspace typecheck**

```bash
pnpm typecheck
```

Expected: workspace-wide pass (`tsc -b` across all packages).

- [ ] **Step 3: No commit (dist is not in git)**

Confirm `dist/` is in `.gitignore` (`git check-ignore packages/shared/dist/index.js` should print the path). If `dist/` is NOT ignored and got staged, `git restore --staged packages/shared/dist/` to unstage.

---

## Phase 2 — Server

### Task 19: Wire `bossSpawner` + `bossCooldowns` into `GameRoom`

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Find `GameRoom.onCreate` and the existing tick loop**

Open `packages/server/src/GameRoom.ts`. Locate:
- The class private fields (where `private spawner: SpawnerState = ...` is declared).
- The `onCreate` body (where `this.rng = mulberry32(state.seed)` happens).
- The `private tick(): void` method (where the existing `tickPlayers → tickStatusEffects → ... → tickSpawner` chain lives).

- [ ] **Step 2: Add the imports**

Near the top of `GameRoom.ts`, add to the existing `@mp/shared` import:

```ts
import {
  /* existing imports... */
  tickBossAbilities,
  tickBossSpawner,
  type BossSpawnerState,
  BOSS_INTERVAL_TICKS,
} from "@mp/shared";
```

- [ ] **Step 3: Declare the new private fields**

In the class body, alongside `private spawner: SpawnerState`:

```ts
  private bossSpawner!: BossSpawnerState;
  private bossCooldowns = new Map<number, number>();
```

- [ ] **Step 4: Initialize in `onCreate` (after `state.seed` is set)**

```ts
    this.bossSpawner = {
      nextBossAt: BOSS_INTERVAL_TICKS,
      aliveBossId: -1,
    };
```

- [ ] **Step 5: Update the tick loop**

Modify the existing `private tick(): void` to insert the two new tick fns at the spec-required positions:

```ts
  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S, this.inputCooldowns);
    tickStatusEffects(this.state, this.state.tick);
    tickEnemies(this.state, SIM_DT_S);
    tickBossAbilities(
      this.state,
      this.state.tick,
      this.bossCooldowns,
      Date.now(),
      (e) => this.emitEvent(e),
    );
    tickContactDamage(this.state, this.contactCooldown, SIM_DT_S, Date.now(), (e) => this.emitEvent(e));
    tickRunEndCheck(this.state, (e) => this.emitEvent(e));
    tickWeapons(/* ... existing args ... */);
    tickProjectiles(/* ... */);
    tickBoomerangs(/* ... */);
    tickBloodPools(/* ... */);
    tickGems(/* ... */);
    tickXp(/* ... */);
    tickLevelUpDeadlines(/* ... */);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
    tickBossSpawner(
      this.state,
      this.bossSpawner,
      this.state.tick,
      this.rng,
      this.spawner,
      this.bossCooldowns,
    );
  }
```

The `emitEvent` (or however the room's broadcast helper is named) call shape follows the existing pattern; copy from a neighboring tick fn's existing emit usage.

- [ ] **Step 6: Typecheck the server**

```bash
pnpm --filter @mp/server run typecheck
```

Expected: passes.

- [ ] **Step 7: Run existing server tests**

```bash
pnpm --filter @mp/server test
```

Expected: all existing tests PASS. The integration test boots a real Colyseus server and connects two real WS clients — it exercises the new schema fields (`maxHp`, `abilityFireAt`) end-to-end through the encoder.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "$(cat <<'EOF'
feat(m10): wire tickBossAbilities + tickBossSpawner into GameRoom

bossSpawner + bossCooldowns live off-schema on GameRoom. Tick order:
tickBossAbilities between tickEnemies and tickContactDamage;
tickBossSpawner appended after tickSpawner (rng schedule append-only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Add an integration test for boss spawn timing

**Files:**
- Modify: `packages/server/test/integration.test.ts` and `packages/server/src/GameRoom.ts` (test-only setter)

- [ ] **Step 1: Add a test-only setter on `GameRoom`**

In `GameRoom.ts`, expose a method that test code can call to fast-forward boss spawning:

```ts
  /**
   * TEST ONLY. Sets `bossSpawner.nextBossAt` so an integration test
   * doesn't have to wait the full 3-minute production cadence. Not
   * called by any production path; safe to leave in shipped code
   * because it requires a typed reference to the room instance.
   */
  setBossSpawnAtForTest(tick: number): void {
    this.bossSpawner.nextBossAt = tick;
  }
```

- [ ] **Step 2: Write the integration test**

In `packages/server/test/integration.test.ts`, append a new `describe` block:

```ts
import { BOSS_KIND_INDEX, ENEMY_KINDS } from "@mp/shared";

describe("integration: boss spawn over real ticks", () => {
  it("spawns exactly one boss after a short interval with correct maxHp", async () => {
    const { server, room, client } = await bootRoomAndClient();
    try {
      // Fast-forward the boss spawn to ~2 seconds in the future
      // (40 ticks @ 20Hz).
      const targetTick = room.state.tick + 40;
      room.setBossSpawnAtForTest(targetTick);

      // Wait for state.tick to overshoot the target tick + 2 ticks of
      // slack to cover setSimulationInterval timing.
      await waitFor(() => room.state.tick >= targetTick + 2, 5_000);

      // Find any boss in state.enemies.
      const bosses = [...room.state.enemies.values()].filter(
        (e) => e.kind === BOSS_KIND_INDEX,
      );
      expect(bosses).toHaveLength(1);
      const boss = bosses[0]!;
      const def = ENEMY_KINDS[BOSS_KIND_INDEX]!;
      expect(boss.maxHp).toBe(def.baseHp);
      expect(boss.hp).toBe(def.baseHp);
      expect(boss.abilityFireAt).toBe(-1);
    } finally {
      await teardown(server, client);
    }
  }, 10_000);
});
```

Re-use the test's existing `bootRoomAndClient`, `waitFor`, and `teardown` helpers — match their signatures from the surrounding tests in the same file.

- [ ] **Step 3: Run the integration test**

```bash
pnpm --filter @mp/server test -- integration
```

Expected: PASS. If the test times out, the boss likely isn't spawning because all players' positions are at the map edge — check the integration helper's player setup. If `boss.maxHp` is 0, the schema field isn't reaching the wire — check that `pnpm --filter @mp/shared build` was run after Task 5.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/integration.test.ts packages/server/src/GameRoom.ts
git commit -m "$(cat <<'EOF'
test(m10): integration test for boss spawn timing + maxHp wire round-trip

setBossSpawnAtForTest fast-forwards the 3-minute cadence to 2 seconds
so the test runs in <10s. Asserts exactly one boss spawns with
correct hp/maxHp/abilityFireAt through the real encoder.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — CLAUDE.md update

### Task 21: Update Rule 11 (tick order) and add Rule 13 (enemy variety is data)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update Rule 11's tick-order block**

Find Rule 11 in `CLAUDE.md`. Replace its tick-order code block:

```
11. **Tick order.** Each server tick runs in this fixed order:
    `tickPlayers → tickStatusEffects → tickEnemies → tickBossAbilities
    → tickContactDamage → tickRunEndCheck → tickWeapons → tickProjectiles
    → tickBoomerangs → tickBloodPools → tickGems → tickXp
    → tickLevelUpDeadlines → tickSpawner → tickBossSpawner`.
```

In the existing rationale paragraph below it, append after the sentence about spawner consuming rng:

```
M10: tickBossAbilities slots between tickEnemies and tickContactDamage so the
AoE strikes post-movement player positions; it does NOT consume rng (telegraph
timing is deterministic from off-schema cooldown bookkeeping; AoE is a radius
check). tickBossSpawner is appended after tickSpawner — its rng consumption
(boss spawn player + angle picks) appends to the schedule without reordering
existing consumers. The new entries follow the universal `if (state.runEnded)
return;` invariant.
```

- [ ] **Step 2: Add Rule 13 after Rule 12**

Append immediately after Rule 12's block:

```
13. **Enemy variety is data, not branches.** Per-kind enemy stats (HP,
    speed multiplier, contact damage, radius, gem drop count, spawn weight,
    time-gated unlocks, flying flag) live in the `ENEMY_KINDS` table in
    `packages/shared/src/enemies.ts`. Per-kind dispatch goes through
    `enemyDefAt(kind)`, never through name-based branching in tick or
    render code. Adding a new enemy is a row in the table. Adding a new
    mechanical capability (a second status-effect kind, a new movement
    mode, a boss with a different ability shape) requires the
    corresponding field shape AND the read site — same discipline as
    `WEAPON_KINDS`. The Unity client's `enemyPrefabs[]` array is indexed
    by `Enemy.kind` so the rendering layer matches the data table's
    order.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(m10): CLAUDE.md Rule 11 update + new Rule 13 (enemy variety is data)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Unity client (code, not art)

### Task 22: Mirror the new Enemy schema fields in C#

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/Schema/Enemy.cs`

- [ ] **Step 1: Append the two new fields**

Open `Monkey Punch/Assets/Scripts/Schema/Enemy.cs`. After the existing `[Type(7, "int32")] public int slowExpiresAt` field, add:

```csharp
	[Type(8, "uint16")]
	public ushort maxHp = default(ushort);

	[Type(9, "int32")]
	public int abilityFireAt = default(int);
```

- [ ] **Step 2: Verify in Editor**

Switch focus to Unity. Wait for the Editor to recompile (bottom-right "Hold on" / progress bar). Open the Console — no compile errors. The C# Colyseus decoder picks up the new fields automatically; no further mapping needed.

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Schema/Enemy.cs"
git commit -m "$(cat <<'EOF'
feat(m10): mirror Enemy.maxHp + Enemy.abilityFireAt in Unity schema

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 23: Add `BOSS_KIND_INDEX` to `PredictorConstants.cs`

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/Net/PredictorConstants.cs`

- [ ] **Step 1: Add the constant**

Open `PredictorConstants.cs`. After the existing constants in the namespace, add:

```csharp
    /// <summary>
    /// Mirrors ENEMY_KINDS[4].isBoss === true in shared/enemies.ts.
    /// If the boss kind index ever moves in the shared table, this constant
    /// must change too. M10 only has one boss kind; M11+ may replace this
    /// with an `isBoss` lookup table.
    /// </summary>
    public const int BOSS_KIND_INDEX = 4;
```

- [ ] **Step 2: Verify in Editor**

Wait for recompile; check Console for errors.

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Net/PredictorConstants.cs"
git commit -m "$(cat <<'EOF'
feat(m10): add BOSS_KIND_INDEX constant on Unity side

Mirrors shared/enemies.ts. One place the boss-kind index is duplicated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Convert NetworkClient from single `slimePrefab` to `enemyPrefabs[]` registry

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs:42` and `:638-651`

- [ ] **Step 1: Replace the SerializeField**

In `NetworkClient.cs`, find the line `[SerializeField] private GameObject slimePrefab;` (around line 42). Replace with:

```csharp
    [Tooltip("Prefab per Enemy.kind index. ENEMY_KINDS in shared/enemies.ts " +
             "defines the order: 0=Slime, 1=Bunny, 2=Ghost, 3=Skeleton, 4=Boss. " +
             "Slots can be null — null falls back to the cube placeholder.")]
    [SerializeField] private GameObject[] enemyPrefabs;
```

- [ ] **Step 2: Replace the dispatch in `HandleEnemyAdd`**

Find the `HandleEnemyAdd` method around line 623. Replace the block:

```csharp
      if (slimePrefab != null && e.kind == 0) {
        go = Instantiate(slimePrefab);
        go.name = $"Enemy:{e.id}";
      } else {
        // Legacy cube fallback. Wrap the cube in a parent so the visual
        // sits with its base at the parent's origin.
        go = new GameObject($"Enemy:{e.id}");
        var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
        cube.transform.SetParent(go.transform, false);
        cube.transform.localScale = Vector3.one * 0.9f;
        cube.transform.localPosition = new Vector3(0f, ENEMY_VISUAL_HALF_HEIGHT, 0f);
        var rend = cube.GetComponent<Renderer>();
        if (rend != null) rend.material.color = new Color(0.9f, 0.2f, 0.2f);
      }
```

with:

```csharp
      GameObject prefab = (enemyPrefabs != null
                           && e.kind < enemyPrefabs.Length
                           && enemyPrefabs[e.kind] != null)
        ? enemyPrefabs[e.kind] : null;
      if (prefab != null) {
        go = Instantiate(prefab);
        go.name = $"Enemy:{e.id}";
      } else {
        // Cube fallback for missing prefab slots (empty during incremental
        // art pipeline). Same shape as the pre-M10 fallback.
        go = new GameObject($"Enemy:{e.id}");
        var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
        cube.transform.SetParent(go.transform, false);
        cube.transform.localScale = Vector3.one * 0.9f;
        cube.transform.localPosition = new Vector3(0f, ENEMY_VISUAL_HALF_HEIGHT, 0f);
        var rend = cube.GetComponent<Renderer>();
        if (rend != null) rend.material.color = new Color(0.9f, 0.2f, 0.2f);
      }
```

- [ ] **Step 3: Re-assign the slime prefab in the Inspector**

Switch to Unity. Wait for recompile. In the Hierarchy, select the GameObject holding the `NetworkClient` MonoBehaviour. In the Inspector, find the new `Enemy Prefabs` array. Set `Size = 5` (for the 5 ENEMY_KINDS slots). Drag the existing Slime prefab from `Assets/Prefabs/Enemies/Slime.prefab` into element `0`. Leave elements 1–4 empty for now (cube fallback will render them as cubes until their prefabs land in Phase 6).

- [ ] **Step 4: Manual smoke test in Editor**

Press Play. After spawn, a slime should render exactly as before. No console errors. Stop Play.

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs" "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): kind→prefab registry on NetworkClient

slimePrefab → enemyPrefabs[] indexed by Enemy.kind. Empty slots fall
back to the existing cube placeholder so code ships before art.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(The scene file is committed because the array size + slot-0 assignment is scene-serialized state.)

---

### Task 25: Create `BossTelegraphVfx.cs` singleton

**Files:**
- Create: `Monkey Punch/Assets/Scripts/Combat/BossTelegraphVfx.cs`

- [ ] **Step 1: Write the script**

```csharp
using System.Collections.Generic;
using UnityEngine;
using MonkeyPunch.Net;

namespace MonkeyPunch.Combat {
  /// <summary>
  /// M10: ring decal + slam shockwave for boss telegraphed AoE. Reads
  /// ServerTime offset so all clients see the ring fill complete at
  /// the same wall-clock moment as the server fires (mirror of
  /// CombatVfx.cs).
  /// </summary>
  public class BossTelegraphVfx : MonoBehaviour {
    public static BossTelegraphVfx Instance { get; private set; }

    [Tooltip("Material for the telegraph ring. URP/Lit unlit-style; the " +
             "MonoBehaviour animates _BaseColor alpha from 0.4 → 1.0 over " +
             "the windup.")]
    [SerializeField] private Material ringMaterial;

    [Tooltip("Material for the slam shockwave (on fire).")]
    [SerializeField] private Material shockwaveMaterial;

    private readonly Dictionary<uint, GameObject> activeRings = new();

    void Awake() {
      if (Instance != null && Instance != this) {
        Destroy(gameObject);
        return;
      }
      Instance = this;
    }

    /// <summary>
    /// Called when boss_telegraph arrives. Instantiates a ring decal at
    /// (originX, terrainHeight + 0.02, originZ). Tracks by bossId so a
    /// following boss_aoe_hit can find and replace the right ring.
    /// </summary>
    public void OnTelegraph(uint bossId, float originX, float originZ,
                            float radius, double fireServerTimeMs) {
      // Replace any existing ring for this boss (defensive — shouldn't
      // happen in normal flow because the ability resets fireAt = -1
      // before the next telegraph).
      if (activeRings.TryGetValue(bossId, out var existing)) {
        Destroy(existing);
        activeRings.Remove(bossId);
      }

      var ring = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
      ring.transform.localScale = new Vector3(radius * 2f, 0.02f, radius * 2f);
      ring.transform.position = new Vector3(originX, 0.02f, originZ);
      // TODO(art): once a sampled terrain.heightAt is exposed Unity-side,
      // sample it here so the ring sits on uneven ground correctly.
      var renderer = ring.GetComponent<Renderer>();
      if (renderer != null && ringMaterial != null) renderer.material = ringMaterial;
      // Disable collider — pure visual.
      var col = ring.GetComponent<Collider>();
      if (col != null) Destroy(col);

      var timer = ring.AddComponent<TelegraphTimer>();
      timer.fireServerTimeMs = fireServerTimeMs;
      timer.spawnServerTimeMs = NetworkClient.Instance != null
        ? NetworkClient.Instance.ServerNowMs()
        : ServerTime.LocalNowMs();

      activeRings[bossId] = ring;
    }

    /// <summary>
    /// Called when boss_aoe_hit arrives. Destroys the ring; spawns a
    /// shockwave that scales 1.0→1.2 over 200ms and fades.
    /// </summary>
    public void OnAoeHit(uint bossId, float originX, float originZ, float radius) {
      if (activeRings.TryGetValue(bossId, out var ring)) {
        Destroy(ring);
        activeRings.Remove(bossId);
      }
      var shock = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
      shock.transform.localScale = new Vector3(radius * 2f, 0.02f, radius * 2f);
      shock.transform.position = new Vector3(originX, 0.05f, originZ);
      var renderer = shock.GetComponent<Renderer>();
      if (renderer != null && shockwaveMaterial != null) renderer.material = shockwaveMaterial;
      var col = shock.GetComponent<Collider>();
      if (col != null) Destroy(col);
      var fade = shock.AddComponent<ShockwaveFade>();
      fade.startScale = radius * 2f;
      fade.endScale = radius * 2.4f;
      fade.lifetimeMs = 200;
    }

    /// <summary>Per-frame fill animation on a telegraph ring.</summary>
    private class TelegraphTimer : MonoBehaviour {
      public double fireServerTimeMs;     // set by OnTelegraph; matches event payload type
      public double spawnServerTimeMs;    // set by OnTelegraph; for total-window calculation
      private Renderer rend;
      private Material material;
      void Awake() {
        rend = GetComponent<Renderer>();
        if (rend != null) material = rend.material;
      }
      void Update() {
        if (NetworkClient.Instance == null) return;
        double nowServer = NetworkClient.Instance.ServerNowMs();
        double total = fireServerTimeMs - spawnServerTimeMs;
        if (total <= 0) return;
        double elapsed = nowServer - spawnServerTimeMs;
        float t = Mathf.Clamp01((float)(elapsed / total));
        if (material != null) {
          // Color ramps yellow → red as the fill completes.
          // Alpha rises 0.4 → 1.0 in parallel for readability.
          var c = Color.Lerp(new Color(1f, 0.9f, 0.2f), new Color(1f, 0.15f, 0.1f), t);
          c.a = 0.4f + 0.6f * t;
          material.color = c;
        }
      }
    }

    private class ShockwaveFade : MonoBehaviour {
      public float startScale;
      public float endScale;
      public int lifetimeMs;
      private double startMs;
      private Renderer rend;
      private Material material;
      void Awake() {
        startMs = ServerTime.LocalNowMs();
        rend = GetComponent<Renderer>();
        if (rend != null) material = rend.material;
      }
      void Update() {
        double elapsed = ServerTime.LocalNowMs() - startMs;
        float t = Mathf.Clamp01((float)(elapsed / lifetimeMs));
        float scale = Mathf.Lerp(startScale, endScale, t);
        transform.localScale = new Vector3(scale, 0.02f, scale);
        if (material != null) {
          var c = material.color;
          c.a = 1f - t;
          material.color = c;
        }
        if (t >= 1f) Destroy(gameObject);
      }
    }
  }
}
```

- [ ] **Step 2: Verify the script compiles**

Switch to Unity, wait for recompile, check Console.

- [ ] **Step 3: Add the singleton to the scene**

In the SampleScene Hierarchy, create an empty GameObject called `BossTelegraphVfx`. Add the `BossTelegraphVfx` component. Leave the two material slots empty for now (placeholder URP/Lit will render but without nice transparency; create proper materials in a follow-up polish task).

- [ ] **Step 4: Subscribe the new room messages in `NetworkClient.cs`**

In `NetworkClient.cs`, find where `enemy_died` and `hit` events are subscribed (around lines 300-315). Add:

```csharp
      room.OnMessage("boss_telegraph", (BossTelegraphEventMsg ev) => {
        if (BossTelegraphVfx.Instance != null) {
          BossTelegraphVfx.Instance.OnTelegraph(
            (uint)ev.bossId, ev.originX, ev.originZ, ev.radius, ev.fireServerTimeMs);
        }
      });
      room.OnMessage("boss_aoe_hit", (BossAoeHitEventMsg ev) => {
        if (BossTelegraphVfx.Instance != null) {
          BossTelegraphVfx.Instance.OnAoeHit(
            (uint)ev.bossId, ev.originX, ev.originZ, ev.radius);
        }
      });
```

Define the DTO classes inside `NetworkClient` alongside `EnemyDiedEventMsg`:

```csharp
    [System.Serializable]
    private class BossTelegraphEventMsg {
      public int bossId;
      public float originX;
      public float originZ;
      public float radius;
      public double fireServerTimeMs;
      public int serverTick;
    }

    [System.Serializable]
    private class BossAoeHitEventMsg {
      public int bossId;
      public float originX;
      public float originZ;
      public float radius;
      public int serverTick;
    }
```

(Colyseus.NET dispatches `OnMessage` callbacks on the Unity main thread, so the existing `enemy_died` / `hit` handlers above call directly into singletons. Match that pattern — no dispatcher wrapper needed.)

- [ ] **Step 5: Verify in Editor**

Wait for recompile; no errors.

- [ ] **Step 6: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Combat/BossTelegraphVfx.cs" \
        "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): BossTelegraphVfx + boss_telegraph / boss_aoe_hit subscribers

Ring decal animates fill over the windup window (server-time-synced
via ServerTime.NowServerMs). Slam shockwave fades over 200ms. Both
spawn from main-thread dispatched message handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 26: Add the boss HP bar to `GameUI.cs`

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`

- [ ] **Step 1: Add HP bar fields**

In `GameUI.cs`, add SerializeField references for the UI elements:

```csharp
    [Header("M10 — Boss HP bar")]
    [Tooltip("Root GameObject toggled on/off based on whether a boss is alive.")]
    [SerializeField] private GameObject bossHpBarRoot;

    [Tooltip("Fill Image with type = Filled, fill method Horizontal.")]
    [SerializeField] private UnityEngine.UI.Image bossHpFill;

    [Tooltip("Text component for the boss name + numeric HP.")]
    [SerializeField] private TMPro.TextMeshProUGUI bossHpLabel;
```

- [ ] **Step 2: Add a `FindAliveBoss` accessor on `NetworkClient`**

`room` is a private field on `NetworkClient`. Rather than exposing the whole Room, add a focused public method that returns the alive boss enemy (or null). In `NetworkClient.cs`, near the existing public accessors (around `ServerNowMs()`):

```csharp
    /// <summary>
    /// M10: returns the first enemy in state with kind == BOSS_KIND_INDEX,
    /// or null if no boss is alive. Used by GameUI to drive the boss HP
    /// bar without exposing the whole room.
    /// </summary>
    public MonkeyPunch.Wire.Enemy FindAliveBoss() {
      if (room?.State?.enemies == null) return null;
      foreach (var kv in room.State.enemies) {
        if (kv.Value.kind == PredictorConstants.BOSS_KIND_INDEX) {
          return kv.Value;
        }
      }
      return null;
    }
```

- [ ] **Step 3: Per-frame scan in `Update`**

Add to the existing `Update` method (or create one if none exists):

```csharp
    void Update() {
      // ... existing UI updates ...
      UpdateBossHpBar();
    }

    private void UpdateBossHpBar() {
      if (bossHpBarRoot == null || NetworkClient.Instance == null) return;
      var boss = NetworkClient.Instance.FindAliveBoss();
      if (boss == null) {
        bossHpBarRoot.SetActive(false);
        return;
      }
      bossHpBarRoot.SetActive(true);
      float ratio = boss.maxHp > 0 ? (float)boss.hp / boss.maxHp : 0f;
      if (bossHpFill != null) bossHpFill.fillAmount = ratio;
      if (bossHpLabel != null) bossHpLabel.text = $"Boss  {boss.hp} / {boss.maxHp}";
    }
```

- [ ] **Step 4: Build the HP bar in the UI canvas**

In the existing Canvas:
- Create a child `Panel` named `BossHpBar` (the root).
- Inside it: a background `Image` and a foreground fill `Image` (`Image Type = Filled`, `Fill Method = Horizontal`, `Fill Amount = 1`).
- Above the bar: a `TextMeshProUGUI` with text "Boss  0 / 0" (placeholder).
- Position near the top center of the canvas.

Wire these into the `GameUI` SerializeFields.

Disable the `BossHpBar` panel by default (`SetActive(false)`) — `Update` will activate it when a boss is alive.

- [ ] **Step 5: Verify in Play mode**

Enter Play. No boss alive → HP bar hidden. (We'll see it appear when we test the boss spawn end-to-end in Task 28.)

- [ ] **Step 6: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
        "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): boss HP bar in GameUI + FindAliveBoss accessor

NetworkClient.FindAliveBoss() returns the first state.enemies entry
with kind == BOSS_KIND_INDEX (or null). GameUI scans per frame and
toggles the bar's visibility.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 27: Create `BunnyHop.cs` + `GhostFloat.cs` procedural animators

**Files:**
- Create: `Monkey Punch/Assets/Scripts/Render/BunnyHop.cs`
- Create: `Monkey Punch/Assets/Scripts/Render/GhostFloat.cs`

- [ ] **Step 1: Write `BunnyHop.cs`**

```csharp
using UnityEngine;

namespace MonkeyPunch.Render {
  /// <summary>
  /// M10: procedural hop animator for the Bunny enemy. Same pattern as
  /// SlimeBob.cs — drives a CHILD visual transform so it doesn't fight
  /// the server's per-frame root transform.position writes.
  ///
  /// Vertical sine wave with a slight forward lean on the upstroke
  /// (suggests rapid little hops). Faster bobSpeed than slime by default.
  /// </summary>
  public class BunnyHop : MonoBehaviour {
    [SerializeField] private Transform visual;
    [SerializeField] private float bobSpeed = 9f;       // faster than slime (5)
    [Range(0f, 0.4f)]
    [SerializeField] private float hopHeight = 0.15f;
    [Range(0f, 25f)]
    [SerializeField] private float forwardLeanDegrees = 12f;

    private Vector3 visualInitialLocalPos;
    private Vector3 visualInitialEulerAngles;
    private Vector3 previousRootPos;
    private bool hasPreviousRootPos;
    private float heldYaw;
    private float phase;

    void Awake() {
      if (visual == null) visual = transform;
      visualInitialLocalPos = visual.localPosition;
      visualInitialEulerAngles = visual.localEulerAngles;
      phase = Random.Range(0f, Mathf.PI * 2f);
      heldYaw = visualInitialEulerAngles.y * Mathf.Deg2Rad;
    }

    void LateUpdate() {
      Vector3 currentRoot = transform.position;
      float dt = Time.deltaTime;
      if (hasPreviousRootPos && dt > 0f) {
        Vector3 velocity = (currentRoot - previousRootPos) / dt;
        if (LocomotionParams.TryComputeTargetYaw(velocity, out float targetYaw)) {
          heldYaw = targetYaw;
        }
      }
      previousRootPos = currentRoot;
      hasPreviousRootPos = true;

      float t = Time.time * bobSpeed + phase;
      float sinT = Mathf.Sin(t);
      float hop = hopHeight * Mathf.Max(0f, sinT);
      // Forward lean on upstroke — positive sin means going up means lean forward.
      float lean = forwardLeanDegrees * Mathf.Max(0f, sinT);

      visual.localPosition = new Vector3(
        visualInitialLocalPos.x,
        visualInitialLocalPos.y + hop,
        visualInitialLocalPos.z
      );
      // Apply yaw + lean. Yaw around Y, lean around X (forward axis tilt).
      visual.localRotation = Quaternion.Euler(
        visualInitialEulerAngles.x + lean,
        heldYaw * Mathf.Rad2Deg,
        visualInitialEulerAngles.z
      );
    }
  }
}
```

- [ ] **Step 2: Write `GhostFloat.cs`**

```csharp
using UnityEngine;

namespace MonkeyPunch.Render {
  /// <summary>
  /// M10: procedural float animator for the Ghost enemy. Y-bob on a
  /// slow sine + continuous Y-rotation drift. No squash (ghost is
  /// already flowing fabric). No facing-from-velocity (ghosts read
  /// fine without committed facing — adds to the "haunted" read).
  /// </summary>
  public class GhostFloat : MonoBehaviour {
    [SerializeField] private Transform visual;
    [SerializeField] private float bobSpeed = 1.2f;
    [Range(0f, 0.5f)]
    [SerializeField] private float bobAmplitude = 0.20f;
    [SerializeField] private float yawDriftDegPerSec = 18f;

    private Vector3 visualInitialLocalPos;
    private float phase;
    private float currentYaw;

    void Awake() {
      if (visual == null) visual = transform;
      visualInitialLocalPos = visual.localPosition;
      phase = Random.Range(0f, Mathf.PI * 2f);
      currentYaw = visual.localEulerAngles.y;
    }

    void LateUpdate() {
      float t = Time.time * bobSpeed + phase;
      float bob = Mathf.Sin(t) * bobAmplitude;
      visual.localPosition = new Vector3(
        visualInitialLocalPos.x,
        visualInitialLocalPos.y + bob,
        visualInitialLocalPos.z
      );
      currentYaw += yawDriftDegPerSec * Time.deltaTime;
      visual.localRotation = Quaternion.Euler(0f, currentYaw, 0f);
    }
  }
}
```

- [ ] **Step 3: Verify both compile**

Switch to Unity; wait for recompile; no errors.

- [ ] **Step 4: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Render/BunnyHop.cs" \
        "Monkey Punch/Assets/Scripts/Render/GhostFloat.cs"
git commit -m "$(cat <<'EOF'
feat(m10): procedural animators for Bunny (hop) and Ghost (float)

Same child-transform pattern as SlimeBob. BunnyHop: vertical hop +
forward lean on upstroke. GhostFloat: slow bob + Y-rotation drift.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Manual smoke test (no art yet)

### Task 28: Two-tab smoke test — slime parity + cube fallbacks + boss spawn + telegraph + HP bar

**Files:**
- (no code changes — manual verification)

- [ ] **Step 1: Lower BOSS_INTERVAL_TICKS temporarily for testing**

In `packages/shared/src/constants.ts`, temporarily change:
```ts
export const BOSS_INTERVAL_TICKS = 3 * 60 * TICK_RATE;
```
to:
```ts
export const BOSS_INTERVAL_TICKS = 30 * TICK_RATE;   // 30s for smoke testing
```

Run `pnpm --filter @mp/shared build` to update dist.

- [ ] **Step 2: Boot the server + open two Unity Player instances**

```bash
pnpm dev
```

Wait for `[colyseus] listening on port ...`. Build the Unity project to a standalone Player (File → Build And Run), then launch a second instance from the build output. Both join the same room (room-code flow per existing client behavior).

- [ ] **Step 3: Slime parity**

Within 5 seconds, slimes spawn and walk toward both players. Movement is smooth; no visual artifacts. Slime prefab renders (the existing slime, not a cube).

- [ ] **Step 4: Cube fallbacks for new kinds**

At T≈30s wall-clock, Bunny kind starts spawning — Bunny prefab slot is empty in `enemyPrefabs[1]`, so bunnies render as red cubes. Move at 1.5× slime speed (faster movement is visually obvious side-by-side).

At T≈90s, Ghost kind starts spawning — cube fallback for kind=2 too. Note: ghosts should be at altitude `+2.5` above terrain (visibly *floating*, NOT on the ground — even as cubes).

At T≈150s, Skeleton kind starts spawning — cube fallback for kind=3.

- [ ] **Step 5: Boss spawn at T≈30s (with temp override)**

A boss spawns at T=30s (the temp `BOSS_INTERVAL_TICKS` override). It renders as a red cube (kind=4 prefab slot empty). Boss HP bar appears at the top of the screen reading "Boss 2000 / 2000". Both clients see the boss at the same position.

- [ ] **Step 6: Boss telegraph + slam**

After ~5s of boss spawn-time, the boss periodically stops moving. A ring decal appears beneath it (color may be off without the proper material assigned — fine for smoke test). Ring fills over 1s. On fill complete, players standing inside the ring take 30 damage (floating damage number); players outside don't. Ring is replaced by a shockwave that fades over 200ms.

- [ ] **Step 7: Boss death**

Kill the boss (use the debug-grant-weapon and damage-self tools as needed to inflate weapon damage). 15 gems spawn in an evenly-spaced ring around the death point. HP bar disappears. ~30s later, the next boss spawns.

- [ ] **Step 8: Revert the temp BOSS_INTERVAL_TICKS**

In `packages/shared/src/constants.ts`, restore:
```ts
export const BOSS_INTERVAL_TICKS = 3 * 60 * TICK_RATE;
```

Rebuild shared: `pnpm --filter @mp/shared build`.

Do NOT commit the temp value to the production constant. The integration test added in Task 20 already exercises the timing via `setBossSpawnAtForTest`.

- [ ] **Step 9: Run all tests**

```bash
pnpm typecheck
pnpm test
pnpm --filter @mp/server test
```

Expected: all PASS.

- [ ] **Step 10: Commit only if something other than the temp change was modified**

If the smoke test surfaced bugs that required code changes, commit those. The constants.ts revert in Step 8 should produce a clean working tree (re-check `git status`).

---

## Phase 6 — Asset pipeline (Meshy generations)

These tasks are user-driven art workflow. They can land independently and in any order — the Phase 4 code already handles missing prefab slots via the cube fallback. **Recommended sequence: Skeleton first** (de-risks the Path B rigged pipeline before the bespoke boss).

### Task 29: Generate, import, and prefab the Skeleton (Path B rigged FBX)

**Files:**
- Create: `Monkey Punch/Assets/Art/Enemies/Skeleton/skeleton.fbx`
- Create: `Monkey Punch/Assets/Art/Enemies/Skeleton/Textures/`
- Create: `Monkey Punch/Assets/Animators/Skeleton.controller`
- Create: `Monkey Punch/Assets/Prefabs/Enemies/Skeleton.prefab`

- [ ] **Step 1: Run the Stage 1 prompt in Midjourney**

Open Midjourney. Use the prompt from `docs/art-pipeline/meshy-enemy-prompts.md` §9 "Skeleton Warrior" verbatim, with `--sref` set to the Female Blademaster screenshot per the doc. Generate 4 variants; pick the best concept image.

- [ ] **Step 2: Run the Stage 2 prompt in Meshy**

Upload the picked concept to Meshy Image-to-3D. Use the Stage 2 prompt from the same §9 entry. Enable **auto-rig** (humanoid). Bundle clips: `idle`, `walk`. Export as **FBX**.

- [ ] **Step 3: Import into Unity**

Save FBX + textures to `Monkey Punch/Assets/Art/Enemies/Skeleton/`. Configure import settings per the M9 pipeline (commit `541ae90`):
- Animation Type: `Generic` (or `Humanoid` if the auto-rig maps cleanly).
- Avatar Definition: Create From This Model.
- Import Animation: ✓; Loop Time on `walk`.
- Generate Normals: Calculate, Smoothing Angle 0 (PSX flat shading).
- Texture: Point filter, Max Size 128, no mips, sRGB on.

Extract materials to `Skeleton/Materials/` and assign textures.

- [ ] **Step 4: Build the Animator controller (1D BlendTree on Speed)**

Create `Animators/Skeleton.controller`. Same shape as M9's `PlayerCharacter.controller` (commit `c29ea92`): a single state running a 1D BlendTree on `Speed` parameter, mapping `idle` @ 0 → `walk` @ 0.5.

- [ ] **Step 5: Build the prefab**

Create `Prefabs/Enemies/Skeleton.prefab`:
- Root GameObject pivoted at feet (the inner glTFast/FBX-imported root sits at `localPosition.y = +bounds.extents.y` — same as the slime prefab).
- SkinnedMeshRenderer + Animator (with the Skeleton controller).
- Add a small script (or reuse `SlimeBob`'s facing-from-velocity helper inline) to drive the Animator's `Speed` parameter from per-frame root-position delta.

- [ ] **Step 6: Wire the prefab into NetworkClient.enemyPrefabs[3]**

In the SampleScene Inspector, drag `Skeleton.prefab` into `enemyPrefabs` element 3.

- [ ] **Step 7: Smoke test**

Lower `BOSS_INTERVAL_TICKS` and bunny/ghost/skeleton `minSpawnTick` temporarily to accelerate; play; verify skeleton renders correctly + animates.

- [ ] **Step 8: Restore the production minSpawnTick / BOSS_INTERVAL_TICKS**

- [ ] **Step 9: Commit**

```bash
git add "Monkey Punch/Assets/Art/Enemies/Skeleton" \
        "Monkey Punch/Assets/Animators/Skeleton.controller" \
        "Monkey Punch/Assets/Prefabs/Enemies/Skeleton.prefab" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): Skeleton enemy — Meshy rigged FBX + Animator + prefab

First rigged enemy import. 1D BlendTree on Speed (idle@0 → walk@0.5),
matching the M9 PlayerCharacter pattern. Wired into
NetworkClient.enemyPrefabs[3].

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 30: Generate, import, and prefab the Bunny (Path A procedural GLB)

**Files:**
- Create: `Monkey Punch/Assets/Art/Enemies/Bunny/bunny.glb`
- Create: `Monkey Punch/Assets/Prefabs/Enemies/Bunny.prefab`

- [ ] **Step 1: Run Stage 1 + Stage 2 prompts from `meshy-enemy-prompts.md` §2 (Bunny)**

Skip auto-rig in Meshy — export as **GLB**.

- [ ] **Step 2: Import into Unity**

Save to `Assets/Art/Enemies/Bunny/`. Import settings: Animation Type `None`, Calculate normals with Smoothing 0, Point filter / Max Size 128 textures.

- [ ] **Step 3: Build the prefab**

Create `Prefabs/Enemies/Bunny.prefab`:
- Feet-pivoted parent GameObject.
- Child visual (the imported GLB root) sits at `localPosition.y = +bounds.extents.y`.
- Add `BunnyHop` MonoBehaviour to the parent. Drag the child visual into its `visual` field.

- [ ] **Step 4: Wire into `enemyPrefabs[1]`**

In SampleScene Inspector, drag `Bunny.prefab` into `enemyPrefabs` element 1.

- [ ] **Step 5: Smoke test**

Verify bunny hops + faces movement direction.

- [ ] **Step 6: Commit**

```bash
git add "Monkey Punch/Assets/Art/Enemies/Bunny" \
        "Monkey Punch/Assets/Prefabs/Enemies/Bunny.prefab" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): Bunny enemy — Meshy GLB + BunnyHop procedural animator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 31: Generate, import, and prefab the Ghost (Path A procedural GLB)

**Files:**
- Create: `Monkey Punch/Assets/Art/Enemies/Ghost/ghost.glb`
- Create: `Monkey Punch/Assets/Prefabs/Enemies/Ghost.prefab`

- [ ] **Step 1: Run Stage 1 + Stage 2 prompts from `meshy-enemy-prompts.md` §5 (Ghost)**

Skip auto-rig — export as GLB. Note: ghost may benefit from an alpha-blended baseColor; configure the imported material with Surface Type = Transparent.

- [ ] **Step 2: Import + prefab**

Feet-pivoted parent (the ghost will spawn at `terrain + FLYING_ENEMY_ALTITUDE` server-side — the prefab's pivot still goes at "feet" of the visual, which for a ghost is the bottom of its wispy tail). Add `GhostFloat` MonoBehaviour.

- [ ] **Step 3: Wire into `enemyPrefabs[2]`**

- [ ] **Step 4: Smoke test**

Ghost floats at `+2.5` above terrain. Drifts smoothly. Bolt projectiles fired from a ground-level player still hit it (3D hit radius covers the altitude gap).

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Art/Enemies/Ghost" \
        "Monkey Punch/Assets/Prefabs/Enemies/Ghost.prefab" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): Ghost enemy — Meshy GLB + GhostFloat procedural animator

Flying — server pins Y to terrain + FLYING_ENEMY_ALTITUDE every tick.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 32: Author the bespoke boss prompt, generate, import, and prefab the Boss

**Files:**
- Modify: `docs/art-pipeline/meshy-enemy-prompts.md` (append §10)
- Create: `Monkey Punch/Assets/Art/Enemies/Boss/boss.fbx`
- Create: `Monkey Punch/Assets/Animators/Boss.controller`
- Create: `Monkey Punch/Assets/Prefabs/Enemies/Boss.prefab`

- [ ] **Step 1: Author the Stage 1 + Stage 2 prompts in `meshy-enemy-prompts.md`**

Append a new `§10. Bespoke Boss` section to `docs/art-pipeline/meshy-enemy-prompts.md`. Choose the boss creature concept (e.g., Baphomet-like goat-demon, dark-knight humanoid, etc. — your call at this point; the framework is decreature-agnostic). Write Stage 1 + Stage 2 prompts following the same shape as the existing §1–§9 entries. Include the inlined PSX/N64 style anchor.

- [ ] **Step 2: Generate Stage 1 concepts in Midjourney**

Use the new §10 prompt. Generate 4 variants; pick.

- [ ] **Step 3: Generate Stage 2 model in Meshy with auto-rig**

Path B (rigged FBX). Bundled clips: `idle`, `walk`, optionally `attack`. Triangle target: 2000–4000 (boss tier per the existing pricing-math section of the doc).

- [ ] **Step 4: Import + Animator + prefab**

Same as Skeleton (Task 29). 3× scale on the root transform to read as boss-sized. PSX import settings per the doc.

- [ ] **Step 5: Wire into `enemyPrefabs[4]`**

- [ ] **Step 6: Smoke test**

Lower `BOSS_INTERVAL_TICKS` temporarily; play; boss spawns with the new prefab; HP bar reads correctly; telegraph + slam fire correctly; gem fan on death.

- [ ] **Step 7: Restore production `BOSS_INTERVAL_TICKS`**

- [ ] **Step 8: Commit**

```bash
git add "docs/art-pipeline/meshy-enemy-prompts.md" \
        "Monkey Punch/Assets/Art/Enemies/Boss" \
        "Monkey Punch/Assets/Animators/Boss.controller" \
        "Monkey Punch/Assets/Prefabs/Enemies/Boss.prefab" \
        "Monkey Punch/Assets/Scenes/SampleScene.unity"
git commit -m "$(cat <<'EOF'
feat(m10): bespoke Boss — Meshy rigged FBX + Animator + prefab

Author the §10 bespoke-boss prompt entry in meshy-enemy-prompts.md.
Wired into NetworkClient.enemyPrefabs[4]. HP bar + telegraph + slam
all light up against the new prefab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Final verification

### Task 33: End-to-end verification per spec §Verification

**Files:**
- (no code; manual + perf check)

- [ ] **Step 1: Run all the manual checks from spec §Verification 7.3**

Walk through items 1–12 of the spec's manual-checks list:
1. Slime parity — slimes spawn and behave as in pre-M10.
2. Time-gated unlocks — bunny at T≈30s, ghost at T≈90s, skeleton at T≈150s.
3. Speed multipliers — bunny visibly outpaces slime.
4. Flying ghost at constant altitude above terrain.
5. Skeleton import — no T-pose, BlendTree transitions correctly.
6. Boss spawn at `BOSS_INTERVAL_TICKS` — HP bar appears.
7. Boss telegraph + slam — ring fill, damage in radius, no damage outside.
8. Boss death + 15-gem fan.
9. One-boss invariant.
10. Reconnect mid-boss.
11. `pnpm typecheck` and `pnpm test` pass.
12. `pnpm --filter @mp/server test` passes.

- [ ] **Step 2: Performance check per spec §Verification 7.4**

Debug-spawn ~200 mixed-kind enemies (use the existing `debug_spawn` with varying `kind` params). Verify:
- Server tick holds 20Hz.
- Client fps holds 60 with a boss telegraph active.
- Per-tick snapshot bytes < 50 KB.

If anything degrades, diagnose before declaring M10 done.

- [ ] **Step 3: Commit the verification log (optional)**

Append a "## M10 verification" section to `README.md` with date, hardware, and observed numbers (per the M3 perf-test precedent).

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(m10): record verification + perf numbers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

After writing all 33 tasks, the following spec sections are covered:

- AD1 (data table) → Tasks 2, 3
- AD2 (schema fields) → Tasks 5, 6
- AD3 (BOSS_KIND_INDEX, BossSpawnerState) → Tasks 2, 17, 19
- AD4 (post-condition death cleanup) → Task 17
- AD5 (flying altitude resnap) → Tasks 10, 11
- AD6 (weighted kind pick + minSpawnTick + rng schedule append) → Tasks 12, 13, 14
- AD7 (tick order, two new fns) → Tasks 16, 17, 19, 21
- AD8 (runEnded early-out) → Tasks 16, 17 (in-test coverage)
- AD9 (boss_telegraph + boss_aoe_hit events) → Tasks 7, 16, 25
- AD10 (gem fan helper) → Tasks 8, 9
- AD11 (boss-spawn radius reuse) → Task 17
- AD12 (Unity kind→prefab registry) → Tasks 22, 23, 24
- Schema changes (maxHp, abilityFireAt) → Tasks 5, 6, 22
- Tests (rules + schema + integration) → Tasks 3, 6, 9, 11, 14, 15, 16, 17, 20
- CLAUDE.md update → Task 21
- Unity side (VFX, HP bar, animators) → Tasks 25, 26, 27
- Asset pipeline → Tasks 29, 30, 31, 32
- Verification → Tasks 28, 33

No task references a method, type, or constant that isn't defined in a prior task. The handful of new symbols (`spawnGemFanAndEmitDeath`, `tickBossAbilities`, `tickBossSpawner`, `BossSpawnerState`, `pickEnemyKind`, `BOSS_KIND_INDEX`, `BunnyHop`, `GhostFloat`, `BossTelegraphVfx`) are each defined before first use.

Known intentional pauses:
- Task 12 ends with a known-failing test (the M3 determinism test). Task 13 immediately regenerates the expected values. The two-task pause is documented in both commit messages and is the cleanest way to record the rng-schedule shift.
- Tasks 29–32 are user-driven art workflow. The code from Phases 1–5 ships without them via the cube-fallback path; the milestone is functionally complete after Task 28 and visually complete after Task 32.
