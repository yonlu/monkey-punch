# M5 — Level-up flow + Orbit weapon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second weapon (Orbit, mechanically as different from Bolt as the protocol allows) and a non-blocking, per-player, timed-default level-up flow — refactoring `WEAPON_KINDS` to a behavior-discriminated shape that has zero per-name branches in `tickWeapons`.

**Architecture:** Discriminated-union `WeaponDef` by `behavior.kind`, dispatched by a single `switch` inside `tickWeapons`. Level-up state lives on the `Player` schema (`pendingLevelUp`, `levelUpChoices`, `levelUpDeadlineTick`) so reconnection-during-overlay falls out of the schema-resync path with no extra code. Orbit positions are deterministic across clients via `state.tick`; orbit per-enemy hit cooldowns live in a server-local `Map`, never in the schema.

**Tech Stack:** TypeScript strict, pnpm workspaces, Colyseus 0.16 (server), React + R3F (client), Vitest (all packages). All persistent fields live in `@colyseus/schema` classes via `declare` + constructor-assigned + `defineTypes` (schema-toolchain landmine).

**Spec:** [`docs/superpowers/specs/2026-05-05-m5-levelup-second-weapon-design.md`](../specs/2026-05-05-m5-levelup-second-weapon-design.md) (committed b02884c)

**Working directory:** This worktree — `.claude/worktrees/festive-zhukovsky-253bda`. Branch: `claude/festive-zhukovsky-253bda`. Run all commands from the worktree root unless otherwise stated.

**Test layout:** `packages/shared/test/` and `packages/server/test/` already exist. The client package's `vitest.config.ts` includes `src/**/*.test.ts` and uses `environment: "node"` — *no React component tests exist anywhere in the repo* and adding JSDOM+testing-library is out of scope for this milestone. Where logic on the client needs unit coverage (e.g. seconds-remaining math), extract it as a pure helper in shared and test it there.

**Critical reminder on schema fields:** Every persistent field on a Colyseus `Schema` subclass MUST be `declare`'d, assigned in the constructor body, AND registered in `defineTypes`. Class-field initializers (`x = 0`) silently break the encoder via the esbuild/tsx `Object.defineProperty` path — this is the schema-toolchain landmine that broke the M1 scaffold. See `packages/shared/src/schema.ts:1-21` for the existing comment.

---

## File structure

**New files:**

- `packages/server/src/orbitHitCooldown.ts` — `OrbitHitCooldownStore` interface + `createOrbitHitCooldownStore()` factory. Pure server-local store; no schema, no Colyseus dependency.
- `packages/client/src/game/LevelUpOverlay.tsx` — non-modal overlay reading `pendingLevelUp` / `levelUpChoices` / `levelUpDeadlineTick` directly from schema each rAF.
- `packages/client/src/game/OrbitSwarm.tsx` — single `InstancedMesh` (capacity `MAX_PLAYERS * MAX_ORB_COUNT_EVER`) rendering orb positions computed from `(state.tick, player render-pos, level)`.
- `packages/client/src/game/LevelUpFlashVfx.tsx` — listens for `level_up_resolved`, plays a 250ms ring+tint flash on the affected `PlayerCube`. Only game-feel exception this milestone.

**Edited files:**

- `packages/shared/src/weapons.ts` — full rewrite to discriminated-union `WeaponDef`; Bolt re-expressed; Orbit added.
- `packages/shared/src/schema.ts` — `Player` gains `pendingLevelUp`, `levelUpChoices`, `levelUpDeadlineTick`.
- `packages/shared/src/messages.ts` — adds `LevelUpChoiceMessage` + `DebugGrantWeaponMessage` (client→server) and `LevelUpOfferedEvent` + `LevelUpResolvedEvent` (server→client broadcast). Extends `MessageType` table.
- `packages/shared/src/rules.ts` — `tickWeapons` refactored to behavior dispatch (no per-name branching); adds `tickXp`, `tickLevelUpDeadlines`, `resolveLevelUp`; `Projectile` reads stats via `statsAt`; `tickProjectiles` calls `evictEnemy` on death; `WeaponContext` gains `orbitHitCooldown`.
- `packages/shared/src/constants.ts` — adds `xpForLevel`, `LEVEL_UP_DEADLINE_TICKS`, `MAX_ORB_COUNT_EVER`.
- `packages/shared/src/index.ts` — re-exports new symbols.
- `packages/server/src/GameRoom.ts` — constructs `OrbitHitCooldownStore`, wires new ticks in the order `… → tickGems → tickXp → tickLevelUpDeadlines → tickSpawner`, hoists `emit` to a member field, handles new messages, calls `evictPlayer` in both `onLeave` paths, sweeps cooldown store every 100 ticks.
- `packages/client/src/game/GameView.tsx` — mounts `LevelUpOverlay`/`OrbitSwarm`/`LevelUpFlashVfx`; adds 1/2/3 keybinds (gated on overlay visibility); adds `Shift+G` HUD-gated debug keybind for `debug_grant_weapon`.
- `packages/client/src/game/PlayerHud.tsx` — lists ALL weapons per row, formatted `"Bolt L2, Orbit L1"`.
- `packages/client/src/game/ProjectileSwarm.tsx` — reads stats via `statsAt(def, level)` instead of flat `WEAPON_KINDS[k]` fields.

---

## Phase 1 — Refactor `weapons.ts` to discriminated-union `WeaponDef`

**Non-regression checkpoint.** After this phase, Bolt must play exactly as before. No behavior change, only data-shape change.

### Task 1.1: Rewrite `shared/weapons.ts` to the new shape (Bolt only)

**Files:**
- Modify: `packages/shared/src/weapons.ts` — full rewrite

- [ ] **Step 1: Replace the file contents**

```ts
// Pure data table for weapon kinds. No Schema, no methods, no side effects on
// import. Adding a weapon means adding a row here under an existing
// behavior.kind, never a new branch in tickWeapons or the client renderers.
// Per spec §AD1/AD3 (M5).

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
      // NOTE: only `damage` and `cooldown` vary per level for Bolt. Visual
      // stats (hitRadius, projectileSpeed, projectileLifetime) are held
      // constant so client projectile rendering — which doesn't carry
      // weapon level on the FireEvent — stays in sync with server hits at
      // every level. Future per-level visual scaling needs `weaponLevel`
      // added to FireEvent; out of scope for M5.
      { damage: 10, cooldown: 0.60, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 14, cooldown: 0.55, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 18, cooldown: 0.50, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 22, cooldown: 0.45, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 28, cooldown: 0.40, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
    ],
  },
];

/**
 * Clamp `level` into the defined range and return the row of stats. Both
 * server (tickWeapons) and clients (renderers, HUD) read effective stats
 * through this — never via direct `def.levels[level]` indexing — so off-by-one
 * around level=0 or beyond max never reaches a hot path.
 */
export function statsAt<W extends WeaponDef>(def: W, level: number): W["levels"][number] {
  const idx = Math.max(1, Math.min(def.levels.length, level)) - 1;
  return def.levels[idx]!;
}
```

- [ ] **Step 2: Add a basic structural test**

**Files:**
- Create: `packages/shared/test/weapons.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { WEAPON_KINDS, statsAt } from "../src/weapons.js";

describe("WEAPON_KINDS", () => {
  it("every kind has at least one level", () => {
    for (const def of WEAPON_KINDS) {
      expect(def.levels.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("Bolt is at index 0 and is a projectile", () => {
    expect(WEAPON_KINDS[0]!.name).toBe("Bolt");
    expect(WEAPON_KINDS[0]!.behavior.kind).toBe("projectile");
  });
});

describe("statsAt", () => {
  it("returns level 1 stats for level=1", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 1)).toBe(def.levels[0]);
  });

  it("clamps to level 1 for level<=0", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 0)).toBe(def.levels[0]);
    expect(statsAt(def, -3)).toBe(def.levels[0]);
  });

  it("clamps to max level for level beyond defined", () => {
    const def = WEAPON_KINDS[0]!;
    const max = def.levels.length;
    expect(statsAt(def, max + 5)).toBe(def.levels[max - 1]);
  });
});
```

- [ ] **Step 3: Run shared tests — expect FAIL on any consumer of old `WeaponKind`**

Run: `pnpm --filter @mp/shared test`
Expected: existing rules tests fail to compile because `WEAPON_KINDS[k].cooldown` etc. no longer exist on the new shape. The new `weapons.test.ts` should pass; the failures will be in `rules.ts` consumers, fixed in Task 1.2.

**Note:** at this point typecheck across the monorepo is broken. We fix it in 1.2 (server) and 1.3 (client). Do NOT commit yet.

### Task 1.2: Update `tickWeapons` to dispatch on `behavior.kind` (projectile arm only)

**Files:**
- Modify: `packages/shared/src/rules.ts` — `tickWeapons` body

- [ ] **Step 1: Replace the `tickWeapons` body to read via `statsAt` and switch on `behavior.kind`**

In `packages/shared/src/rules.ts`, replace the existing `tickWeapons` function (the one that reads `kind.cooldown`, `kind.projectileSpeed`, etc.) with the version below. The signature is unchanged; only the body changes. Keep the surrounding helpers, `WeaponContext` type (we'll widen it in Phase 3), and exports.

```ts
import { statsAt, type WeaponDef } from "./weapons.js";

export function tickWeapons(
  state: RoomState,
  dt: number,
  ctx: WeaponContext,
  emit: Emit,
): void {
  const rangeSq = TARGETING_MAX_RANGE * TARGETING_MAX_RANGE;

  state.players.forEach((player: Player) => {
    player.weapons.forEach((weapon: WeaponState) => {
      const def: WeaponDef | undefined = WEAPON_KINDS[weapon.kind];
      if (!def) return; // unknown kind — skip silently

      switch (def.behavior.kind) {
        case "projectile": {
          const stats = statsAt(def, weapon.level);

          weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);
          if (weapon.cooldownRemaining > 0) return;

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
          if (!hasTarget) return;
          if (bestSq === 0) return;

          const dist = Math.sqrt(bestSq);
          const dirX = bestDx / dist;
          const dirZ = bestDz / dist;

          const proj: Projectile = {
            fireId: ctx.nextFireId(),
            ownerId: player.sessionId,
            weaponKind: weapon.kind,
            damage: stats.damage,
            speed: stats.projectileSpeed,
            radius: stats.hitRadius,
            lifetime: stats.projectileLifetime,
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

          weapon.cooldownRemaining = stats.cooldown;
          break;
        }

        case "orbit": {
          // Orbit arm lands in Phase 3. For now, no-op so Bolt-only games
          // still tick clean if a stale Orbit weapon ever appears (it can't
          // yet — no row in WEAPON_KINDS — but keep the switch exhaustive).
          break;
        }
      }
    });
  });
}
```

- [ ] **Step 2: Run shared tests — expect PASS**

Run: `pnpm --filter @mp/shared test`
Expected: all tests pass, including existing `rules.test.ts` Bolt assertions.

### Task 1.3: Update client renderers to read via `statsAt`

**Files:**
- Modify: `packages/client/src/game/ProjectileSwarm.tsx`
- Modify: `packages/client/src/game/PlayerHud.tsx`
- Modify: `packages/client/src/game/GameView.tsx` (the cooldown HUD line that reads `kind.cooldown`)

- [ ] **Step 1: Update `ProjectileSwarm.tsx` to use `statsAt`**

In `packages/client/src/game/ProjectileSwarm.tsx`, replace the inner-loop kind lookup. Find the line:

```ts
const kind = WEAPON_KINDS[fe.weaponKind];
if (!kind) {
```

Replace with (note: we look up the def, then extract level-1 stats; per-level scaling on the client follows whatever the server fired at, but FireEvent doesn't carry weapon level today — Bolt's projectile speed varies per level, so we'd need the level. For M5 the safest answer is to keep using level-1 stats for client rendering, since FireEvents don't carry level. This is acceptable because projectile lifetime/speed at higher levels is small enough that visual mismatch is invisible. If we want exact parity later, add `weaponLevel` to FireEvent — out of scope here):

```ts
import { PROJECTILE_MAX_CAPACITY, WEAPON_KINDS, statsAt } from "@mp/shared";
// ...
const def = WEAPON_KINDS[fe.weaponKind];
if (!def || def.behavior.kind !== "projectile") {
  fires.delete(fireId);
  continue;
}
const stats = statsAt(def, 1);
```

Then in the body, replace `kind.projectileLifetime` with `stats.projectileLifetime` and `kind.projectileSpeed` with `stats.projectileSpeed`.

- [ ] **Step 2: Update `PlayerHud.tsx`'s cooldown bar**

In `packages/client/src/game/PlayerHud.tsx`, the function `cooldownBar` reads `kind.cooldown`. Update:

```ts
import { WEAPON_KINDS, statsAt } from "@mp/shared";

function cooldownBar(weapon: WeaponState | undefined): string {
  if (!weapon) return "·".repeat(BAR_LEN);
  const def = WEAPON_KINDS[weapon.kind];
  if (!def || def.behavior.kind !== "projectile") return "·".repeat(BAR_LEN);
  const stats = statsAt(def, weapon.level);
  const frac = 1 - Math.max(0, Math.min(1, weapon.cooldownRemaining / stats.cooldown));
  const filled = Math.round(frac * BAR_LEN);
  return "▓".repeat(filled) + "░".repeat(BAR_LEN - filled);
}
```

- [ ] **Step 3: Update `GameView.tsx` cooldown line in the player onChange callback**

Find this block in `GameView.tsx` (around line 95-100):

```ts
const w = player.weapons[0];
if (w) {
  const kind = WEAPON_KINDS[w.kind];
  const total = kind?.cooldown ?? 1;
  hudState.cooldownFrac = 1 - Math.max(0, Math.min(1, w.cooldownRemaining / total));
}
```

Replace with:

```ts
import { WEAPON_KINDS, statsAt } from "@mp/shared";
// ...
const w = player.weapons[0];
if (w) {
  const def = WEAPON_KINDS[w.kind];
  if (def && def.behavior.kind === "projectile") {
    const stats = statsAt(def, w.level);
    hudState.cooldownFrac = 1 - Math.max(0, Math.min(1, w.cooldownRemaining / stats.cooldown));
  } else {
    hudState.cooldownFrac = 1;
  }
}
```

(Add `statsAt` to the existing `@mp/shared` import.)

- [ ] **Step 4: Run typecheck across all packages**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: all PASS — Bolt behavior unchanged.

- [ ] **Step 6: Commit Phase 1**

```bash
git add packages/shared/src/weapons.ts packages/shared/test/weapons.test.ts \
        packages/shared/src/rules.ts \
        packages/client/src/game/ProjectileSwarm.tsx \
        packages/client/src/game/PlayerHud.tsx \
        packages/client/src/game/GameView.tsx
git commit -m "$(cat <<'EOF'
refactor(shared): WeaponDef discriminated union by behavior.kind

Phase 1 of M5. Replaces the flat WeaponKind shape (one record per
weapon, all fields at top level, per-level scaling absent) with a
discriminated union by behavior.kind so a single tickWeapons can
dispatch ProjectileLevel and OrbitLevel data without name-based
branching.

Bolt is re-expressed across 5 levels but still plays identically at L1
because tickWeapons looks up via statsAt(def, weapon.level) and L1
matches the M4 numbers exactly. Client renderers (ProjectileSwarm,
PlayerHud, GameView's cooldown HUD line) read effective stats via the
same helper, never via direct field access.

Non-regression checkpoint for the M5 weapon-table refactor — Orbit
arrives in Phase 3.
EOF
)"
```

---

## Phase 2 — Constants and Orbit weapon data

### Task 2.1: Add level-up + orbit constants to `shared/constants.ts`

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Append to the file**

```ts
// M5 — XP / level-up
/**
 * XP required to advance from `level` to `level + 1`.
 * Canonical formula: level*5 + level² → 6, 14, 24, 36, 50, ...
 * Tests assert monotonicity, not specific values, so retuning is free.
 */
export function xpForLevel(level: number): number {
  return level * 5 + level * level;
}

/** 10 seconds at 20Hz = 200 ticks. The window before auto-pick fires. */
export const LEVEL_UP_DEADLINE_TICKS = 10 * TICK_RATE;

// M5 — orbit rendering
/**
 * Upper bound on simultaneous orbs across all weapon levels in WEAPON_KINDS.
 * Sets the InstancedMesh capacity on the client and is asserted at module
 * load (see assertOrbCapacity below). Bumping this is safe; lowering it
 * past the actual data trips the assertion.
 */
export const MAX_ORB_COUNT_EVER = 6;
```

- [ ] **Step 2: Add startup assertion to `shared/index.ts`**

In `packages/shared/src/index.ts`, append after the existing re-exports:

```ts
import { WEAPON_KINDS } from "./weapons.js";
import { MAX_ORB_COUNT_EVER } from "./constants.js";

// Module-load assertion: every orbit weapon's max-level orbCount must fit
// into the InstancedMesh capacity reserved by MAX_ORB_COUNT_EVER. Failing
// at module load is the right time — the alternative is a silent
// out-of-bounds in the client's per-frame matrix update.
{
  let max = 0;
  for (const def of WEAPON_KINDS) {
    if (def.behavior.kind === "orbit") {
      for (const lvl of def.levels) {
        if (lvl.orbCount > max) max = lvl.orbCount;
      }
    }
  }
  if (max > MAX_ORB_COUNT_EVER) {
    throw new Error(
      `MAX_ORB_COUNT_EVER=${MAX_ORB_COUNT_EVER} but WEAPON_KINDS contains an orbit weapon with orbCount=${max}; ` +
        `bump MAX_ORB_COUNT_EVER in shared/constants.ts.`,
    );
  }
}
```

- [ ] **Step 3: Add tests for `xpForLevel`**

**Files:**
- Modify: `packages/shared/test/rules.test.ts` (append at end) OR
- Create: `packages/shared/test/constants.test.ts`

Use a new file:

```ts
import { describe, it, expect } from "vitest";
import { xpForLevel } from "../src/constants.js";

describe("xpForLevel", () => {
  it("is strictly increasing on [1, 50]", () => {
    let prev = -Infinity;
    for (let lvl = 1; lvl <= 50; lvl++) {
      const need = xpForLevel(lvl);
      expect(need).toBeGreaterThan(prev);
      prev = need;
    }
  });

  it("matches the canonical formula", () => {
    expect(xpForLevel(1)).toBe(6);   // 5 + 1
    expect(xpForLevel(2)).toBe(14);  // 10 + 4
    expect(xpForLevel(3)).toBe(24);  // 15 + 9
    expect(xpForLevel(5)).toBe(50);  // 25 + 25
  });
});
```

- [ ] **Step 4: Run shared tests — expect PASS**

Run: `pnpm --filter @mp/shared test`
Expected: PASS.

### Task 2.2: Add Orbit weapon definition

**Files:**
- Modify: `packages/shared/src/weapons.ts`

- [ ] **Step 1: Append the Orbit row to `WEAPON_KINDS`**

In `packages/shared/src/weapons.ts`, change the array to include the Orbit entry. Replace the existing `WEAPON_KINDS = [ ... ];` block with:

```ts
export const WEAPON_KINDS: readonly WeaponDef[] = [
  {
    name: "Bolt",
    behavior: { kind: "projectile", targeting: "nearest" },
    levels: [
      // Per-level: only damage and cooldown vary (see notes in Phase 1.1).
      { damage: 10, cooldown: 0.60, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 14, cooldown: 0.55, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 18, cooldown: 0.50, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 22, cooldown: 0.45, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
      { damage: 28, cooldown: 0.40, hitRadius: 0.4, projectileSpeed: 18, projectileLifetime: 0.8 },
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
];
```

- [ ] **Step 2: Strengthen the Orbit-shape test**

Append to `packages/shared/test/weapons.test.ts`:

```ts
describe("Orbit weapon", () => {
  it("is at index 1 and is an orbit", () => {
    expect(WEAPON_KINDS[1]!.name).toBe("Orbit");
    expect(WEAPON_KINDS[1]!.behavior.kind).toBe("orbit");
  });

  it("max-level orbCount fits in MAX_ORB_COUNT_EVER (asserted at module load)", async () => {
    // The assertion in shared/index.ts runs at import time. If we got here,
    // it passed. This test exists so a future bump that exceeds the bound
    // produces a named test failure rather than only a vague import error.
    const orbit = WEAPON_KINDS[1]!;
    if (orbit.behavior.kind !== "orbit") throw new Error("WEAPON_KINDS[1] not orbit");
    const max = Math.max(...orbit.levels.map((l) => l.orbCount));
    const { MAX_ORB_COUNT_EVER } = await import("../src/constants.js");
    expect(max).toBeLessThanOrEqual(MAX_ORB_COUNT_EVER);
  });
});
```

- [ ] **Step 3: Run shared tests — expect PASS**

Run: `pnpm --filter @mp/shared test`
Expected: PASS, including the new Orbit assertions.

- [ ] **Step 4: Commit Phase 2**

```bash
git add packages/shared/src/constants.ts packages/shared/src/weapons.ts \
        packages/shared/src/index.ts \
        packages/shared/test/weapons.test.ts packages/shared/test/constants.test.ts
git commit -m "feat(shared): Orbit weapon data + xpForLevel + orb-capacity assertion"
```

---

## Phase 3 — Orbit hit cooldown store + tickWeapons orbit arm

### Task 3.1: Implement `OrbitHitCooldownStore` (TDD)

**Files:**
- Create: `packages/server/src/orbitHitCooldown.ts`
- Create: `packages/server/test/orbitHitCooldown.test.ts`

- [ ] **Step 1: Write the failing test first**

```ts
// packages/server/test/orbitHitCooldown.test.ts
import { describe, it, expect } from "vitest";
import { createOrbitHitCooldownStore } from "../src/orbitHitCooldown.js";

describe("OrbitHitCooldownStore", () => {
  it("tryHit returns true the first time and updates last-hit", () => {
    const s = createOrbitHitCooldownStore();
    expect(s.tryHit("p1", 0, 42, 1000, 500)).toBe(true);
  });

  it("tryHit returns false within the cooldown window", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    expect(s.tryHit("p1", 0, 42, 1100, 500)).toBe(false);
    expect(s.tryHit("p1", 0, 42, 1499, 500)).toBe(false);
  });

  it("tryHit returns true after the cooldown window elapses", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    expect(s.tryHit("p1", 0, 42, 1500, 500)).toBe(true);
  });

  it("entries are independent across (player, weaponIndex, enemy) tuples", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    expect(s.tryHit("p2", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 1, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 0, 99, 1100, 500)).toBe(true);
  });

  it("evictPlayer removes all entries for that player", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    s.tryHit("p1", 1, 99, 1000, 500);
    s.tryHit("p2", 0, 42, 1000, 500);
    s.evictPlayer("p1");
    expect(s.tryHit("p1", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 1, 99, 1100, 500)).toBe(true);
    expect(s.tryHit("p2", 0, 42, 1100, 500)).toBe(false); // p2 untouched
  });

  it("evictEnemy removes entries for that enemy across all players", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    s.tryHit("p2", 0, 42, 1000, 500);
    s.tryHit("p1", 0, 99, 1000, 500);
    s.evictEnemy(42);
    expect(s.tryHit("p1", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p2", 0, 42, 1100, 500)).toBe(true);
    expect(s.tryHit("p1", 0, 99, 1100, 500)).toBe(false); // enemy 99 untouched
  });

  it("sweep drops entries older than the configured max cooldown", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    // Sweep at a time well past max cooldown — entry is gone, next tryHit
    // is a "first hit" and returns true even if its own cooldown is 500ms.
    s.sweep(/* nowMs */ 5000, /* maxCooldownMs */ 700);
    expect(s.tryHit("p1", 0, 42, 5001, 500)).toBe(true);
  });

  it("sweep keeps entries still within the cooldown window", () => {
    const s = createOrbitHitCooldownStore();
    s.tryHit("p1", 0, 42, 1000, 500);
    s.sweep(/* nowMs */ 1100, /* maxCooldownMs */ 700);
    expect(s.tryHit("p1", 0, 42, 1200, 500)).toBe(false); // still gated
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm --filter @mp/server test orbitHitCooldown`
Expected: FAIL with `Cannot find module '../src/orbitHitCooldown.js'`.

- [ ] **Step 3: Implement the store**

```ts
// packages/server/src/orbitHitCooldown.ts

/**
 * Server-local per-(player, weaponIndex, enemy) hit cooldown for orbit-
 * behavior weapons. Per spec §AD7: not on the schema (clients have no use
 * for this value, syncing it would balloon snapshots).
 *
 * `weaponIndex` is the player's `weapons[]` array index. Stable for the
 * lifetime of the weapon: server only pushes to weapons[], never reorders
 * or splices.
 *
 * Eviction (defense in depth):
 *  - tryHit: lazy, overwrites expired entries on read.
 *  - evictEnemy: called from rules.ts on enemy death (both projectile path
 *    and orbit-arm path call this).
 *  - evictPlayer: called from GameRoom.onLeave on schema delete.
 *  - sweep: periodic safety net; drops entries older than the longest
 *    cooldown configured anywhere in WEAPON_KINDS.
 */
export interface OrbitHitCooldownStore {
  /**
   * Returns true and updates last-hit if the cooldown elapsed; false otherwise.
   * `nowMs` is the server's wallclock (Date.now()-style); `cooldownMs` is the
   * weapon's per-enemy hit cooldown for the level being applied.
   */
  tryHit(playerId: string, weaponIndex: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictPlayer(playerId: string): void;
  evictEnemy(enemyId: number): void;
  /** Drop entries older than maxCooldownMs at nowMs. */
  sweep(nowMs: number, maxCooldownMs: number): void;
}

function key(playerId: string, weaponIndex: number, enemyId: number): string {
  return `${playerId}:${weaponIndex}:${enemyId}`;
}

export function createOrbitHitCooldownStore(): OrbitHitCooldownStore {
  const lastHit = new Map<string, number>();

  return {
    tryHit(playerId, weaponIndex, enemyId, nowMs, cooldownMs) {
      const k = key(playerId, weaponIndex, enemyId);
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

/**
 * Compute the longest hit-cooldown across all orbit-behavior weapon levels
 * in WEAPON_KINDS. Used as the `maxCooldownMs` argument to sweep().
 */
export function maxOrbitHitCooldownMs(
  weaponKinds: readonly { behavior: { kind: string }; levels: ReadonlyArray<{ hitCooldownPerEnemyMs?: number }> }[],
): number {
  let max = 0;
  for (const def of weaponKinds) {
    if (def.behavior.kind !== "orbit") continue;
    for (const lvl of def.levels) {
      const c = lvl.hitCooldownPerEnemyMs ?? 0;
      if (c > max) max = c;
    }
  }
  return max;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm --filter @mp/server test orbitHitCooldown`
Expected: PASS for all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/orbitHitCooldown.ts packages/server/test/orbitHitCooldown.test.ts
git commit -m "feat(server): OrbitHitCooldownStore for per-enemy orbit hit gating"
```

### Task 3.2: Widen `WeaponContext` and add the orbit arm to `tickWeapons` (TDD)

**Files:**
- Modify: `packages/shared/src/rules.ts` — `WeaponContext`, orbit case body
- Modify: `packages/shared/test/rules.test.ts` — add orbit-arm tests

- [ ] **Step 1: Add an `OrbitHitCooldownStore`-shaped type to rules.ts and widen `WeaponContext`**

Important: the store implementation lives in `packages/server/`. We don't want `shared` to import server code. So define the *interface* needed by `tickWeapons` inline in rules.ts (or in a small file in shared). Use a structural type — the server implementation will satisfy it.

In `packages/shared/src/rules.ts`, near the top with the other types:

```ts
/**
 * Server-supplied per-(player, weaponIndex, enemy) hit cooldown for orbit
 * weapons. Structural — the concrete implementation lives in
 * server/src/orbitHitCooldown.ts and satisfies this shape. Defined here
 * (not in a separate shared file) because tickWeapons is the only consumer.
 */
export interface OrbitHitCooldownLike {
  tryHit(playerId: string, weaponIndex: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
}

export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
  orbitHitCooldown: OrbitHitCooldownLike;
};
```

- [ ] **Step 2: Write failing tests for the orbit arm**

Append to `packages/shared/test/rules.test.ts` (replace the file's existing `WeaponContext` test fixtures or add new ones — the existing tests construct a context object; preserve those by adding `orbitHitCooldown` to a shared helper):

Find the existing test `ctx` builder. In the test file, add a helper near the top of the file:

```ts
function makeOrbitCooldownStub() {
  const hits: Array<[string, number, number]> = [];
  return {
    tryHit: (pid: string, wi: number, eid: number, _now: number, _cd: number) => {
      hits.push([pid, wi, eid]);
      return true;
    },
    evictEnemy: (_id: number) => {},
    hits,
  };
}

function makeWeaponCtx(opts?: { nextFireId?: () => number; nowMs?: number; pushProjectile?: (p: Projectile) => void; orbitHitCooldown?: { tryHit: (...args: any[]) => boolean; evictEnemy: (id: number) => void } }) {
  return {
    nextFireId: opts?.nextFireId ?? (() => 1),
    serverNowMs: () => opts?.nowMs ?? 0,
    pushProjectile: opts?.pushProjectile ?? (() => {}),
    orbitHitCooldown: opts?.orbitHitCooldown ?? { tryHit: () => true, evictEnemy: () => {} },
  } satisfies WeaponContext;
}
```

(Use this helper in any existing test that builds a context; adjust as needed without changing assertions.)

Then add the orbit tests:

```ts
describe("tickWeapons orbit arm", () => {
  it("hits an enemy at orb radius on the first tick", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.x = 0; p.z = 0;

    const orbit = new WeaponState();
    orbit.kind = 1; // index of Orbit in WEAPON_KINDS
    orbit.level = 1;
    orbit.cooldownRemaining = 0;
    p.weapons.push(orbit);

    // Place an enemy at the L1 orb radius on the +X axis.
    // L1 orbCount=2, orbRadius=2.0, orbAngularSpeed=2.4 rad/s.
    // At state.tick=0 the angles are 0 and π; orb 0 sits at (2.0, 0).
    const e = addEnemy(state, 1, 2.0, 0);
    e.hp = 100;

    const cd = makeOrbitCooldownStub();
    const events: CombatEvent[] = [];
    const ctx = makeWeaponCtx({ orbitHitCooldown: cd });

    state.tick = 0;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));

    // Enemy took 6 damage (Orbit L1 damage). One hit event was emitted.
    expect(e.hp).toBe(94);
    const hitEvents = events.filter((e) => e.type === "hit");
    expect(hitEvents.length).toBe(1);
    expect(cd.hits.length).toBe(1);
  });

  it("does not double-hit within the per-enemy cooldown window", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    const orbit = new WeaponState();
    orbit.kind = 1;
    orbit.level = 1;
    p.weapons.push(orbit);

    const e = addEnemy(state, 1, 2.0, 0);
    e.hp = 100;

    // Stub returns false the second time (simulating a still-cooling-down hit).
    let n = 0;
    const cd = {
      tryHit: () => {
        n += 1;
        return n === 1;
      },
      evictEnemy: () => {},
    };
    const events: CombatEvent[] = [];
    const ctx = makeWeaponCtx({ orbitHitCooldown: cd });

    state.tick = 0;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));
    state.tick = 1;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));

    // Two ticks but only one hit landed (the second tryHit returned false).
    expect(e.hp).toBe(94);
    expect(events.filter((e) => e.type === "hit").length).toBe(1);
  });

  it("on lethal hit: emits enemy_died, drops a gem, removes the enemy, evicts cooldown entry", () => {
    const state = new RoomState();
    addPlayer(state, "p1", 0, 0);
    const p = state.players.get("p1")!;
    const orbit = new WeaponState();
    orbit.kind = 1;
    orbit.level = 1;
    p.weapons.push(orbit);

    const e = addEnemy(state, 7, 2.0, 0);
    e.hp = 1; // lethal in one hit

    let evictedId = -1;
    const cd = {
      tryHit: () => true,
      evictEnemy: (id: number) => { evictedId = id; },
    };
    const events: CombatEvent[] = [];
    const ctx = makeWeaponCtx({ orbitHitCooldown: cd });

    state.tick = 0;
    tickWeapons(state, 0.05, ctx, (ev) => events.push(ev));

    expect(state.enemies.has("7")).toBe(false);
    expect(state.gems.size).toBe(1);
    expect(events.some((e) => e.type === "enemy_died" && e.enemyId === 7)).toBe(true);
    expect(evictedId).toBe(7);
  });
});
```

(`tickWeapons` will need a `ProjectileContext`-like dependency for `nextGemId` since orbit lethal hits drop gems. The existing `tickProjectiles` already uses `ctx.nextGemId`; we need the same for the orbit arm. **Decision: extend `WeaponContext` with `nextGemId: () => number`** rather than thread a separate context. Update the type accordingly.)

Update the `WeaponContext` type to include `nextGemId`:

```ts
export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
};
```

Update the `makeWeaponCtx` helper to set `nextGemId: () => 1` by default (or a counter).

- [ ] **Step 3: Run tests — expect FAIL with the current empty orbit case**

Run: `pnpm --filter @mp/shared test rules`
Expected: FAIL on the new orbit tests (the case body is `break;`).

- [ ] **Step 4: Implement the orbit arm**

In `packages/shared/src/rules.ts`, replace the `case "orbit": { break; }` placeholder with:

```ts
case "orbit": {
  const stats = statsAt(def, weapon.level);
  const tickTime = state.tick / TICK_RATE;
  const radiusSum = stats.hitRadius + ENEMY_RADIUS;
  const radiusSumSq = radiusSum * radiusSum;
  const nowMs = ctx.serverNowMs();

  const weaponIndex = (() => {
    // Resolve the index of `weapon` within `player.weapons`. ArraySchema.indexOf
    // exists; use it. Stable because we never reorder.
    return player.weapons.indexOf(weapon);
  })();

  for (let i = 0; i < stats.orbCount; i++) {
    const angle = tickTime * stats.orbAngularSpeed + i * (2 * Math.PI / stats.orbCount);
    const orbX = player.x + Math.cos(angle) * stats.orbRadius;
    const orbZ = player.z + Math.sin(angle) * stats.orbRadius;

    // Point-circle vs each enemy. Collect hits in a temporary list because
    // mutating state.enemies during a forEach causes visit order to drift.
    const toHit: Enemy[] = [];
    state.enemies.forEach((enemy: Enemy) => {
      const dx = enemy.x - orbX;
      const dz = enemy.z - orbZ;
      if (dx * dx + dz * dz <= radiusSumSq) toHit.push(enemy);
    });

    for (const enemy of toHit) {
      if (!ctx.orbitHitCooldown.tryHit(player.sessionId, weaponIndex, enemy.id, nowMs, stats.hitCooldownPerEnemyMs)) {
        continue;
      }
      enemy.hp -= stats.damage;

      // fireId=0 sentinel — orbit hits don't correlate to a fire event.
      // M4 starts nextFireId at 1, so 0 is unambiguously "non-projectile".
      emit({
        type: "hit",
        fireId: 0,
        enemyId: enemy.id,
        damage: stats.damage,
        serverTick: state.tick,
      });

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
        state.enemies.delete(String(enemy.id));
        ctx.orbitHitCooldown.evictEnemy(deathId);

        emit({
          type: "enemy_died",
          enemyId: deathId,
          x: deathX,
          z: deathZ,
        });
      }
    }
  }
  break;
}
```

Add `TICK_RATE` to the existing constants import at the top of rules.ts if not already there, and import `Gem` and `GEM_VALUE` (already imported per current file — verify).

- [ ] **Step 5: Run shared tests — expect PASS**

Run: `pnpm --filter @mp/shared test`
Expected: PASS, all orbit-arm tests + all prior tests.

- [ ] **Step 6: Update `tickProjectiles` to call `evictEnemy` on death**

In `packages/shared/src/rules.ts`, the `tickProjectiles` function has the lethal-hit block that does `state.enemies.delete(...)`. Add an `orbitHitCooldown.evictEnemy(deathId)` call right next to it. We need to pass the cooldown store into `tickProjectiles` — the cleanest path is to add it to `ProjectileContext`:

```ts
export type ProjectileContext = {
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
};
```

Inside `tickProjectiles`, after `state.enemies.delete(String(hitEnemy.id));`, add:

```ts
ctx.orbitHitCooldown.evictEnemy(deathId);
```

- [ ] **Step 7: Update existing rules.test.ts call sites that build a `ProjectileContext` to include `orbitHitCooldown`**

Search `packages/shared/test/rules.test.ts` for `ProjectileContext` constructions; add `orbitHitCooldown: { tryHit: () => true, evictEnemy: () => {} }` to each. (There are ~3 instances in the existing M4 projectile tests.)

- [ ] **Step 8: Run shared tests — expect PASS**

Run: `pnpm --filter @mp/shared test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickWeapons orbit arm + cross-tick evictEnemy hook"
```

### Task 3.3: Wire `OrbitHitCooldownStore` into `GameRoom` and update contexts

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Construct the store and extend the contexts**

Imports — add at the top:

```ts
import {
  createOrbitHitCooldownStore,
  maxOrbitHitCooldownMs,
  type OrbitHitCooldownStore,
} from "./orbitHitCooldown.js";
```

Also add `WEAPON_KINDS` to the existing `@mp/shared` import.

Inside `GameRoom`, add a private field and a member for the max-cooldown:

```ts
private orbitHitCooldown!: OrbitHitCooldownStore;
private maxOrbitHitCooldownMs!: number;
private cooldownSweepCounter = 0;
```

In `onCreate`, after constructing `this.weaponCtx`, replace the construction with:

```ts
this.orbitHitCooldown = createOrbitHitCooldownStore();
this.maxOrbitHitCooldownMs = maxOrbitHitCooldownMs(WEAPON_KINDS);

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
  nextGemId: () => this.nextGemId++,
  orbitHitCooldown: this.orbitHitCooldown,
};
this.projectileCtx = {
  nextGemId: () => this.nextGemId++,
  orbitHitCooldown: this.orbitHitCooldown,
};
```

- [ ] **Step 2: Add the periodic sweep call**

Inside the `tick()` method, near the end (after `tickSpawner`), add:

```ts
this.cooldownSweepCounter += 1;
if (this.cooldownSweepCounter >= 100) {
  this.cooldownSweepCounter = 0;
  this.orbitHitCooldown.sweep(Date.now(), this.maxOrbitHitCooldownMs);
}
```

- [ ] **Step 3: Add `evictPlayer` calls in both `onLeave` paths**

In `onLeave`, the `consented` early-return path:

```ts
if (consented) {
  this.state.players.delete(client.sessionId);
  this.orbitHitCooldown.evictPlayer(client.sessionId);
  return;
}
```

And in the `catch` block of the `allowReconnection` try:

```ts
} catch (err) {
  console.log(
    `[room ${this.state.code}] reconnect grace ended for ${client.sessionId}: ${err === false ? "timeout" : err}`,
  );
  this.state.players.delete(client.sessionId);
  this.orbitHitCooldown.evictPlayer(client.sessionId);
}
```

- [ ] **Step 4: Run typecheck — expect PASS**

Run: `pnpm typecheck`
Expected: PASS. Server now uses the broadened contexts; type errors here would mean a missed call site.

- [ ] **Step 5: Run all tests — expect PASS**

Run: `pnpm test`
Expected: PASS, including the existing M4 integration tests (Bolt unchanged at runtime).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "feat(server): wire OrbitHitCooldownStore + periodic sweep + onLeave eviction"
```

---

## Phase 4 — `debug_grant_weapon` and client `OrbitSwarm`

### Task 4.1: Add `DebugGrantWeaponMessage` to `shared/messages.ts`

**Files:**
- Modify: `packages/shared/src/messages.ts`

- [ ] **Step 1: Add the type and extend the union**

Append in the appropriate section (alongside the other `Debug*Message` types):

```ts
export type DebugGrantWeaponMessage = {
  type: "debug_grant_weapon";
  weaponKind: number;
};
```

Extend `ClientMessage`:

```ts
export type ClientMessage =
  | InputMessage
  | PingMessage
  | DebugSpawnMessage
  | DebugClearEnemiesMessage
  | DebugGrantWeaponMessage;
```

Extend `MessageType`:

```ts
export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
  DebugSpawn: "debug_spawn",
  DebugClearEnemies: "debug_clear_enemies",
  DebugGrantWeapon: "debug_grant_weapon",
  Fire: "fire",
  Hit: "hit",
  EnemyDied: "enemy_died",
  GemCollected: "gem_collected",
} as const;
```

- [ ] **Step 2: Add the GameRoom handler**

In `packages/server/src/GameRoom.ts`, inside `onCreate` under the `if (ALLOW_DEBUG_MESSAGES)` block:

```ts
this.onMessage<DebugGrantWeaponMessage>("debug_grant_weapon", (client, message) => {
  const player = this.state.players.get(client.sessionId);
  if (!player) return;
  const kindRaw = Number(message?.weaponKind);
  if (!Number.isFinite(kindRaw) || kindRaw < 0 || kindRaw >= WEAPON_KINDS.length) return;
  const kind = Math.floor(kindRaw);

  const existing = player.weapons.find((w) => w.kind === kind);
  if (existing) {
    const def = WEAPON_KINDS[kind]!;
    existing.level = Math.min(existing.level + 1, def.levels.length);
    return;
  }

  const fresh = new WeaponState();
  fresh.kind = kind;
  fresh.level = 1;
  fresh.cooldownRemaining = 0;
  player.weapons.push(fresh);
});
```

Add `DebugGrantWeaponMessage` to the existing `@mp/shared` import.

- [ ] **Step 3: Run typecheck and tests — expect PASS**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/messages.ts packages/server/src/GameRoom.ts
git commit -m "feat: debug_grant_weapon message + handler"
```

### Task 4.2: Create `OrbitSwarm.tsx`

**Files:**
- Create: `packages/client/src/game/OrbitSwarm.tsx`

- [ ] **Step 1: Write the component**

```tsx
// packages/client/src/game/OrbitSwarm.tsx
import { useMemo, useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import type { Room } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import {
  MAX_ORB_COUNT_EVER,
  TICK_RATE,
  WEAPON_KINDS,
  statsAt,
} from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const MAX_PLAYERS = 10;
const ORB_RENDER_Y = 0.7;
const ORB_CAPACITY = MAX_PLAYERS * MAX_ORB_COUNT_EVER;

export type OrbitSwarmProps = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * Per spec §AD2: orbit positions are computed deterministically from
 * (state.tick, player render-pos, weapon level). Both clients reading the
 * same synced tick produce the same orb angles. Player render-pos is the
 * predictor for the local player and the interpolated buffer sample for
 * remote players — matches PlayerCube so orbs visually stick to the
 * player at all times.
 *
 * Single InstancedMesh with capacity MAX_PLAYERS * MAX_ORB_COUNT_EVER. No
 * per-orb attribute updates other than translation matrix.
 */
export function OrbitSwarm({ room, predictor, buffers }: OrbitSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);

  useEffect(() => {
    if (meshRef.current) meshRef.current.count = 0;
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const tick = room.state.tick;
    const tickTime = tick / TICK_RATE;
    let i = 0;

    room.state.players.forEach((player: Player) => {
      // Player render position: predictor for local, interpolated remote.
      let rx: number;
      let rz: number;
      if (player.sessionId === room.sessionId) {
        rx = predictor.predictedX;
        rz = predictor.predictedZ;
      } else {
        const sample = buffers.get(player.sessionId)?.sample(performance.now() - hudState.interpDelayMs);
        if (!sample) {
          rx = player.x;
          rz = player.z;
        } else {
          rx = sample.x;
          rz = sample.z;
        }
      }

      player.weapons.forEach((weapon) => {
        const def = WEAPON_KINDS[weapon.kind];
        if (!def || def.behavior.kind !== "orbit") return;
        const stats = statsAt(def, weapon.level);

        for (let k = 0; k < stats.orbCount; k++) {
          if (i >= ORB_CAPACITY) return;
          const angle = tickTime * stats.orbAngularSpeed + k * (2 * Math.PI / stats.orbCount);
          matrix.makeTranslation(
            rx + Math.cos(angle) * stats.orbRadius,
            ORB_RENDER_Y,
            rz + Math.sin(angle) * stats.orbRadius,
          );
          mesh.setMatrixAt(i, matrix);
          i++;
        }
      });
    });

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    // No castShadow — same Three 0.164 InstancedMesh + shadow-camera
    // landmine that EnemySwarm/ProjectileSwarm dodge.
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, ORB_CAPACITY]}
      frustumCulled={false}
    >
      <sphereGeometry args={[0.25, 10, 8]} />
      <meshStandardMaterial color="#7af0ff" emissive="#7af0ff" emissiveIntensity={1.0} />
    </instancedMesh>
  );
}
```

- [ ] **Step 2: Mount it in `GameView.tsx`**

In `packages/client/src/game/GameView.tsx`, import:

```ts
import { OrbitSwarm } from "./OrbitSwarm.js";
```

Inside the `<Canvas>` block, add `<OrbitSwarm room={room} predictor={predictor} buffers={buffers} />` after `<EnemySwarm ...>` and before `<ProjectileSwarm ...>` (rendering order is cosmetic; both are emissive instanced meshes).

- [ ] **Step 3: Add the `Shift+G` debug keybind**

In `GameView.tsx`'s `keyHandler`, after the `Backslash` clear block:

```ts
} else if (e.code === "KeyG" && e.shiftKey) {
  e.preventDefault();
  // Orbit is index 1 in WEAPON_KINDS. Granting at L1, or upgrading +1.
  room.send("debug_grant_weapon", { type: "debug_grant_weapon", weaponKind: 1 });
}
```

- [ ] **Step 4: Run dev server and verify manually**

Run: `pnpm dev`
Open one tab. Press `F3` to enable HUD-gated debug keys. Press `Shift+G`. The HUD's weapon row currently shows only weapon[0]; you won't see Orbit listed yet (Phase 10 fixes this). But you SHOULD see two cyan orbs spinning around your cube. Move; they follow.

Open a second tab; verify both clients see orbs at the same positions.

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/game/OrbitSwarm.tsx packages/client/src/game/GameView.tsx
git commit -m "feat(client): OrbitSwarm + Shift+G debug grant"
```

---

## Phase 5 — Schema additions for level-up state

### Task 5.1: Add level-up fields to `Player` schema

**Files:**
- Modify: `packages/shared/src/schema.ts`

- [ ] **Step 1: Add the three fields using the `declare`+constructor+`defineTypes` pattern**

In the `Player` class in `packages/shared/src/schema.ts`, declarations block:

```ts
declare pendingLevelUp: boolean;
declare levelUpChoices: ArraySchema<number>;
declare levelUpDeadlineTick: number;
```

(Place them with the other `declare`s, e.g. after `weapons`.)

In the constructor body, after `this.weapons = new ArraySchema<WeaponState>();`:

```ts
this.pendingLevelUp = false;
this.levelUpChoices = new ArraySchema<number>();
this.levelUpDeadlineTick = 0;
```

In the `defineTypes(Player, { ... })` block, add:

```ts
pendingLevelUp: "boolean",
levelUpChoices: [ "uint8" ],
levelUpDeadlineTick: "uint32",
```

(Keep the existing entries — just append.)

- [ ] **Step 2: Add a basic schema test**

Append to `packages/shared/test/schema.test.ts` (or create if it doesn't have a Player section):

```ts
describe("Player level-up fields", () => {
  it("defaults are non-pending, empty choices, deadline 0", () => {
    const p = new Player();
    expect(p.pendingLevelUp).toBe(false);
    expect(p.levelUpChoices.length).toBe(0);
    expect(p.levelUpDeadlineTick).toBe(0);
  });

  it("levelUpChoices accepts 3 uint8 weapon-kind ints", () => {
    const p = new Player();
    p.levelUpChoices.push(0, 1, 1);
    expect(p.levelUpChoices.length).toBe(3);
    expect(p.levelUpChoices[0]).toBe(0);
    expect(p.levelUpChoices[2]).toBe(1);
  });
});
```

- [ ] **Step 3: Run typecheck and tests — expect PASS**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. The schema landmine (esbuild Object.defineProperty over setter) is avoided because we follow the `declare`+constructor pattern.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schema.ts packages/shared/test/schema.test.ts
git commit -m "feat(shared): Player schema gains pendingLevelUp + levelUpChoices + deadlineTick"
```

---

## Phase 6 — `tickXp`, `resolveLevelUp`, level-up message protocol

### Task 6.1: Add level-up messages to `shared/messages.ts`

**Files:**
- Modify: `packages/shared/src/messages.ts`

- [ ] **Step 1: Add the four new message types**

```ts
export type LevelUpChoiceMessage = {
  type: "level_up_choice";
  choiceIndex: number; // 0/1/2
};

export type LevelUpOfferedEvent = {
  type: "level_up_offered";
  playerId: string;
  newLevel: number;
  choices: number[];     // length 3, weapon-kind ints (with replacement)
  deadlineTick: number;  // RoomState.tick at which auto-pick fires
};

export type LevelUpResolvedEvent = {
  type: "level_up_resolved";
  playerId: string;
  weaponKind: number;
  newWeaponLevel: number;
  autoPicked: boolean;
};
```

Extend `ClientMessage`:

```ts
export type ClientMessage =
  | InputMessage
  | PingMessage
  | DebugSpawnMessage
  | DebugClearEnemiesMessage
  | DebugGrantWeaponMessage
  | LevelUpChoiceMessage;
```

Extend `MessageType`:

```ts
export const MessageType = {
  // ... existing ...
  LevelUpChoice: "level_up_choice",
  LevelUpOffered: "level_up_offered",
  LevelUpResolved: "level_up_resolved",
} as const;
```

Extend the `CombatEvent`-like grouping if applicable. Currently `CombatEvent` in `rules.ts` is `FireEvent | HitEvent | EnemyDiedEvent | GemCollectedEvent`. Widen it to include level-up events. In `packages/shared/src/rules.ts`:

```ts
import type {
  FireEvent,
  HitEvent,
  EnemyDiedEvent,
  GemCollectedEvent,
  LevelUpOfferedEvent,
  LevelUpResolvedEvent,
} from "./messages.js";

export type CombatEvent =
  | FireEvent
  | HitEvent
  | EnemyDiedEvent
  | GemCollectedEvent
  | LevelUpOfferedEvent
  | LevelUpResolvedEvent;
```

- [ ] **Step 2: Run typecheck — expect PASS**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/messages.ts packages/shared/src/rules.ts
git commit -m "feat(shared): level_up_choice / level_up_offered / level_up_resolved"
```

### Task 6.2: Implement `resolveLevelUp` (TDD)

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `rules.test.ts`:

```ts
import { resolveLevelUp } from "../src/rules.js";

describe("resolveLevelUp", () => {
  it("upgrades existing weapon: increments level, no new WeaponState pushed, emits resolved", () => {
    const p = new Player();
    p.sessionId = "p1";
    p.pendingLevelUp = true;
    p.levelUpChoices.push(0, 1, 0);
    p.levelUpDeadlineTick = 200;
    const w = new WeaponState();
    w.kind = 0; w.level = 1; w.cooldownRemaining = 0;
    p.weapons.push(w);

    const events: CombatEvent[] = [];
    resolveLevelUp(p, /* weaponKind */ 0, (e) => events.push(e), /* autoPicked */ false);

    expect(p.weapons.length).toBe(1);
    expect(p.weapons[0]!.level).toBe(2);
    expect(p.pendingLevelUp).toBe(false);
    expect(p.levelUpChoices.length).toBe(0);
    expect(p.levelUpDeadlineTick).toBe(0);

    const resolved = events.find((e) => e.type === "level_up_resolved")!;
    expect(resolved).toBeDefined();
    if (resolved.type === "level_up_resolved") {
      expect(resolved.playerId).toBe("p1");
      expect(resolved.weaponKind).toBe(0);
      expect(resolved.newWeaponLevel).toBe(2);
      expect(resolved.autoPicked).toBe(false);
    }
  });

  it("adds new weapon at level 1 if not present", () => {
    const p = new Player();
    p.sessionId = "p1";
    p.pendingLevelUp = true;
    p.levelUpChoices.push(1, 0, 1);

    const events: CombatEvent[] = [];
    resolveLevelUp(p, /* Orbit */ 1, (e) => events.push(e), /* autoPicked */ true);

    expect(p.weapons.length).toBe(1);
    expect(p.weapons[0]!.kind).toBe(1);
    expect(p.weapons[0]!.level).toBe(1);
    expect(p.weapons[0]!.cooldownRemaining).toBe(0);

    const resolved = events.find((e) => e.type === "level_up_resolved")!;
    if (resolved.type === "level_up_resolved") {
      expect(resolved.newWeaponLevel).toBe(1);
      expect(resolved.autoPicked).toBe(true);
    }
  });

  it("caps level at WEAPON_KINDS[kind].levels.length", () => {
    const p = new Player();
    p.sessionId = "p1";
    const def = WEAPON_KINDS[0]!; // Bolt: 5 levels
    const w = new WeaponState();
    w.kind = 0; w.level = def.levels.length; w.cooldownRemaining = 0;
    p.weapons.push(w);

    const events: CombatEvent[] = [];
    resolveLevelUp(p, 0, (e) => events.push(e), false);

    expect(p.weapons[0]!.level).toBe(def.levels.length); // capped, not 6
  });
});
```

- [ ] **Step 2: Run test — expect FAIL with "resolveLevelUp is not exported"**

Run: `pnpm --filter @mp/shared test rules`
Expected: FAIL.

- [ ] **Step 3: Implement `resolveLevelUp`**

In `packages/shared/src/rules.ts`, append:

```ts
/**
 * Pure: mutate `player` to apply the chosen level-up, then emit
 * `level_up_resolved`. Called from both the `level_up_choice` message
 * handler (autoPicked=false) and `tickLevelUpDeadlines` (autoPicked=true).
 *
 * Per spec §AD9. If the player already has a weapon of `weaponKind`,
 * increments its level (capped at WEAPON_KINDS[kind].levels.length).
 * Otherwise pushes a new WeaponState at level 1.
 */
export function resolveLevelUp(
  player: Player,
  weaponKind: number,
  emit: Emit,
  autoPicked: boolean,
): void {
  const def = WEAPON_KINDS[weaponKind];
  if (!def) {
    // Unknown kind; clear pending state to avoid wedging the player and bail.
    player.pendingLevelUp = false;
    player.levelUpChoices.length = 0;
    player.levelUpDeadlineTick = 0;
    return;
  }

  let newWeaponLevel: number;
  let existingIdx = -1;
  for (let i = 0; i < player.weapons.length; i++) {
    if (player.weapons[i]!.kind === weaponKind) {
      existingIdx = i;
      break;
    }
  }
  if (existingIdx >= 0) {
    const w = player.weapons[existingIdx]!;
    w.level = Math.min(w.level + 1, def.levels.length);
    newWeaponLevel = w.level;
  } else {
    const w = new WeaponState();
    w.kind = weaponKind;
    w.level = 1;
    w.cooldownRemaining = 0;
    player.weapons.push(w);
    newWeaponLevel = 1;
  }

  player.pendingLevelUp = false;
  player.levelUpChoices.length = 0;
  player.levelUpDeadlineTick = 0;

  emit({
    type: "level_up_resolved",
    playerId: player.sessionId,
    weaponKind,
    newWeaponLevel,
    autoPicked,
  });
}
```

(Add `WeaponState` to the existing imports from `./schema.js` if not already present.)

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm --filter @mp/shared test rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): resolveLevelUp pure function"
```

### Task 6.3: Implement `tickXp` (TDD)

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `rules.test.ts`:

```ts
import { tickXp } from "../src/rules.js";
import { mulberry32 } from "../src/rng.js";
import { LEVEL_UP_DEADLINE_TICKS, xpForLevel } from "../src/constants.js";

describe("tickXp", () => {
  it("does nothing for a player below threshold", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1) - 1; // one short

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(false);
    expect(p.level).toBe(1);
    expect(events.length).toBe(0);
  });

  it("triggers level-up exactly once when XP crosses threshold", () => {
    const state = new RoomState();
    state.tick = 50;
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1); // exact

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(true);
    expect(p.level).toBe(2);
    expect(p.xp).toBe(0);
    expect(p.levelUpChoices.length).toBe(3);
    expect(p.levelUpDeadlineTick).toBe(50 + LEVEL_UP_DEADLINE_TICKS);

    const offered = events.find((e) => e.type === "level_up_offered")!;
    expect(offered).toBeDefined();
    if (offered.type === "level_up_offered") {
      expect(offered.playerId).toBe("p1");
      expect(offered.newLevel).toBe(2);
      expect(offered.choices.length).toBe(3);
      expect(offered.deadlineTick).toBe(50 + LEVEL_UP_DEADLINE_TICKS);
    }
  });

  it("does not retrigger while pendingLevelUp is true", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 2;
    p.xp = xpForLevel(2) * 3; // way over threshold
    p.pendingLevelUp = true;

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events.push(e));
    tickXp(state, mulberry32(123), (e) => events.push(e));

    expect(events.length).toBe(0);
    expect(p.level).toBe(2);
  });

  it("retriggers on next tick after pending clears, if XP still over", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1) + xpForLevel(2); // enough for two levels

    const events1: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events1.push(e));
    expect(p.pendingLevelUp).toBe(true);
    expect(p.level).toBe(2);

    // Simulate resolution.
    p.pendingLevelUp = false;
    p.levelUpChoices.length = 0;
    p.levelUpDeadlineTick = 0;

    const events2: CombatEvent[] = [];
    tickXp(state, mulberry32(123), (e) => events2.push(e));
    expect(p.pendingLevelUp).toBe(true);
    expect(p.level).toBe(3);
    expect(events2.filter((e) => e.type === "level_up_offered").length).toBe(1);
  });

  it("rolls 3 choices in [0, WEAPON_KINDS.length) using the supplied rng", () => {
    const state = new RoomState();
    const p = addPlayer(state, "p1", 0, 0);
    p.level = 1;
    p.xp = xpForLevel(1);

    const events: CombatEvent[] = [];
    tickXp(state, mulberry32(7), (e) => events.push(e));

    expect(p.levelUpChoices.length).toBe(3);
    p.levelUpChoices.forEach((c) => {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(WEAPON_KINDS.length);
    });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL with "tickXp not exported"**

Run: `pnpm --filter @mp/shared test rules`
Expected: FAIL.

- [ ] **Step 3: Implement `tickXp`**

In `packages/shared/src/rules.ts`, append (after `resolveLevelUp`):

```ts
/**
 * For each player: if XP has crossed the threshold for their current level
 * AND they don't already have a pending level-up, drain the cost, increment
 * level, roll 3 weapon-kind choices via `rng` (with replacement), set
 * pendingLevelUp + levelUpChoices + levelUpDeadlineTick, emit
 * level_up_offered.
 *
 * Per spec §AD4 (one level per tick, drain via re-ticks) and §AD5 (room
 * rng, fixed tick order).
 */
export function tickXp(state: RoomState, rng: Rng, emit: Emit): void {
  state.players.forEach((player: Player) => {
    if (player.pendingLevelUp) return;
    const need = xpForLevel(player.level);
    if (player.xp < need) return;

    player.xp -= need;
    player.level += 1;

    // Roll 3 choices (with replacement). Mutate in place: clear+push.
    player.levelUpChoices.length = 0;
    const choicesArr: number[] = [];
    for (let i = 0; i < 3; i++) {
      const k = Math.floor(rng() * WEAPON_KINDS.length);
      player.levelUpChoices.push(k);
      choicesArr.push(k);
    }

    player.pendingLevelUp = true;
    player.levelUpDeadlineTick = state.tick + LEVEL_UP_DEADLINE_TICKS;

    emit({
      type: "level_up_offered",
      playerId: player.sessionId,
      newLevel: player.level,
      choices: choicesArr,
      deadlineTick: player.levelUpDeadlineTick,
    });
  });
}
```

Add the import for `xpForLevel` and `LEVEL_UP_DEADLINE_TICKS` to the existing constants import.

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm --filter @mp/shared test rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts
git commit -m "feat(shared): tickXp drives level-up offers from XP threshold"
```

### Task 6.4: Wire `tickXp` into `GameRoom` + handle `level_up_choice`

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Hoist `emit` to a member field**

Inside `GameRoom`, add:

```ts
private emit!: Emit;
```

In `onCreate`, after `this.setState(state)`, set:

```ts
this.emit = (e: CombatEvent) => this.broadcast(e.type, e);
```

In `tick()`, replace the local `const emit: Emit = (e: CombatEvent) => this.broadcast(e.type, e);` with use of `this.emit`. The body becomes:

```ts
private tick(): void {
  this.state.tick += 1;
  // AD6: players → enemies → weapons → projectiles → gems → xp → deadlines → spawner.
  // Order is load-bearing for RNG determinism (spec §AD5 — tickXp consumes
  // the same rng as tickSpawner; reordering forks the seed schedule).
  tickPlayers(this.state, SIM_DT_S);
  tickEnemies(this.state, SIM_DT_S);
  tickWeapons(this.state, SIM_DT_S, this.weaponCtx, this.emit);
  tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S, this.projectileCtx, this.emit);
  tickGems(this.state, this.emit);
  tickXp(this.state, this.rng, this.emit);
  tickLevelUpDeadlines(this.state, this.emit);
  tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);

  this.cooldownSweepCounter += 1;
  if (this.cooldownSweepCounter >= 100) {
    this.cooldownSweepCounter = 0;
    this.orbitHitCooldown.sweep(Date.now(), this.maxOrbitHitCooldownMs);
  }
}
```

(`tickLevelUpDeadlines` lands in Phase 8; for now, you may either stub a no-op import here OR delay this exact tick-order line until Phase 8. Pragmatic answer: include the import-and-call now; if `tickLevelUpDeadlines` doesn't exist in shared yet, this won't compile. **Do step-by-step:** in this step add only `tickXp`, not `tickLevelUpDeadlines`. Phase 8 will add the latter.)

So the actual `tick()` body for THIS step:

```ts
private tick(): void {
  this.state.tick += 1;
  tickPlayers(this.state, SIM_DT_S);
  tickEnemies(this.state, SIM_DT_S);
  tickWeapons(this.state, SIM_DT_S, this.weaponCtx, this.emit);
  tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S, this.projectileCtx, this.emit);
  tickGems(this.state, this.emit);
  tickXp(this.state, this.rng, this.emit);
  // tickLevelUpDeadlines goes here in Phase 8.
  tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);

  this.cooldownSweepCounter += 1;
  if (this.cooldownSweepCounter >= 100) {
    this.cooldownSweepCounter = 0;
    this.orbitHitCooldown.sweep(Date.now(), this.maxOrbitHitCooldownMs);
  }
}
```

Add `tickXp` and `resolveLevelUp` to the existing `@mp/shared` imports in GameRoom.

- [ ] **Step 2: Add the `level_up_choice` handler**

In `onCreate`, near the other `onMessage` blocks (outside the `ALLOW_DEBUG_MESSAGES` block — this is a real game flow, not a debug shortcut):

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

Add `LevelUpChoiceMessage` to the existing `@mp/shared` imports.

- [ ] **Step 3: Run typecheck and all tests — expect PASS**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/GameRoom.ts
git commit -m "feat(server): wire tickXp + level_up_choice handler + hoist emit"
```

---

## Phase 7 — `LevelUpOverlay` and 1/2/3 keybinds

### Task 7.1: Create `LevelUpOverlay.tsx`

**Files:**
- Create: `packages/client/src/game/LevelUpOverlay.tsx`

- [ ] **Step 1: Write the component**

```tsx
// packages/client/src/game/LevelUpOverlay.tsx
import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import { SIM_DT_S, WEAPON_KINDS, statsAt } from "@mp/shared";

const OVERLAY_STYLE: React.CSSProperties = {
  position: "fixed",
  bottom: 88, // sits above the PlayerHud row
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "center",
  zIndex: 1100,
  pointerEvents: "auto",
};

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(20,24,30,0.85)",
  border: "1px solid rgba(120,200,255,0.4)",
  borderRadius: 6,
  padding: "10px 14px",
  color: "#fff",
  font: "13px/1.4 ui-monospace, Menlo, monospace",
  minWidth: 160,
  textAlign: "center",
  cursor: "pointer",
  userSelect: "none",
};

const COUNTDOWN_STYLE: React.CSSProperties = {
  background: "rgba(0,0,0,0.6)",
  color: "#fff",
  font: "11px ui-monospace, Menlo, monospace",
  padding: "2px 8px",
  borderRadius: 3,
};

type CardLabel = { line1: string; line2: string };

function describeChoice(localPlayer: Player, weaponKind: number): CardLabel {
  const def = WEAPON_KINDS[weaponKind];
  if (!def) return { line1: "?", line2: "?" };
  const existing = localPlayer.weapons.find((w) => w.kind === weaponKind);
  if (!existing) {
    return { line1: def.name, line2: "NEW" };
  }
  const cap = def.levels.length;
  if (existing.level >= cap) {
    return { line1: def.name, line2: `L${cap} (MAX)` };
  }
  return { line1: def.name, line2: `L${existing.level} → L${existing.level + 1}` };
}

export type LevelUpOverlayProps = {
  room: Room<RoomState>;
};

/**
 * Per spec §AD6 + §AD10. Reads pendingLevelUp/levelUpChoices/
 * levelUpDeadlineTick directly from schema each rAF (same pattern as
 * PlayerHud). Source of truth for visibility is the schema; the
 * reconnection path (verification step 10) falls out for free because
 * Colyseus re-syncs full state on resume.
 */
export function LevelUpOverlay({ room }: LevelUpOverlayProps) {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);

  // rAF re-render driver. Same pattern as PlayerHud.
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

  const localPlayer = room.state.players.get(room.sessionId);
  if (!localPlayer || !localPlayer.pendingLevelUp || localPlayer.levelUpChoices.length === 0) {
    return null;
  }

  const remainingTicks = Math.max(0, localPlayer.levelUpDeadlineTick - room.state.tick);
  const remainingS = (remainingTicks * SIM_DT_S).toFixed(1);

  const send = (idx: number) => {
    if (idx < 0 || idx >= localPlayer.levelUpChoices.length) return;
    room.send("level_up_choice", { type: "level_up_choice", choiceIndex: idx });
  };

  const cards: CardLabel[] = [];
  for (let i = 0; i < localPlayer.levelUpChoices.length; i++) {
    cards.push(describeChoice(localPlayer, localPlayer.levelUpChoices[i]!));
  }

  return (
    <div style={OVERLAY_STYLE}>
      <div style={COUNTDOWN_STYLE}>level up — auto-pick in {remainingS}s</div>
      <div style={ROW_STYLE}>
        {cards.map((c, i) => (
          <div key={i} style={CARD_STYLE} onClick={() => send(i)}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{i + 1}. {c.line1}</div>
            <div style={{ opacity: 0.85 }}>{c.line2}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `GameView.tsx` + add 1/2/3 keybinds**

In `packages/client/src/game/GameView.tsx`, import:

```ts
import { LevelUpOverlay } from "./LevelUpOverlay.js";
```

Add the component outside the `<Canvas>` element (it's HTML, not Three.js), next to the other overlays:

```tsx
<PlayerHud room={room} />
<LevelUpOverlay room={room} />
<DebugHud />
```

In the `keyHandler` (the same effect that handles F3/`]`/`\\`), add 1/2/3 keys gated by overlay visibility:

```ts
if (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3") {
  const localPlayer = room.state.players.get(room.sessionId);
  if (localPlayer?.pendingLevelUp && localPlayer.levelUpChoices.length > 0) {
    e.preventDefault();
    const idx = e.code === "Digit1" ? 0 : e.code === "Digit2" ? 1 : 2;
    if (idx < localPlayer.levelUpChoices.length) {
      room.send("level_up_choice", { type: "level_up_choice", choiceIndex: idx });
    }
  }
  return;
}
```

(Place this BEFORE the `if (!hudState.visible) return;` line so 1/2/3 work without F3.)

- [ ] **Step 3: Manual verification**

Run: `pnpm dev`
Open one tab. Press `Shift+G` once to grant Orbit (helpful so the overlay has variety), then play normally. Within ~30s a level-up should fire. Overlay appears bottom-center, three cards labelled "1. Bolt L1 → L2" etc., countdown ticking.

Click card 1 OR press `1`. Overlay vanishes. Weapon level updates within ~50ms.

Move during the choice: should still work.

Open a second tab; verify the second player keeps playing while you have the overlay up.

- [ ] **Step 4: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/game/LevelUpOverlay.tsx packages/client/src/game/GameView.tsx
git commit -m "feat(client): LevelUpOverlay + 1/2/3 keybinds"
```

---

## Phase 8 — `tickLevelUpDeadlines` (auto-pick)

### Task 8.1: Implement `tickLevelUpDeadlines` (TDD)

**Files:**
- Modify: `packages/shared/src/rules.ts`
- Modify: `packages/shared/test/rules.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `rules.test.ts`:

```ts
import { tickLevelUpDeadlines } from "../src/rules.js";

describe("tickLevelUpDeadlines", () => {
  it("does not fire before the deadline tick", () => {
    const state = new RoomState();
    state.tick = 100;
    const p = addPlayer(state, "p1", 0, 0);
    p.pendingLevelUp = true;
    p.levelUpChoices.push(0, 0, 0);
    p.levelUpDeadlineTick = 200;

    const events: CombatEvent[] = [];
    tickLevelUpDeadlines(state, (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(true);
    expect(events.length).toBe(0);
  });

  it("fires exactly when state.tick === deadline (auto-picks choice 0)", () => {
    const state = new RoomState();
    state.tick = 200;
    const p = addPlayer(state, "p1", 0, 0);
    p.pendingLevelUp = true;
    p.levelUpChoices.push(1, 0, 0);
    p.levelUpDeadlineTick = 200;

    const events: CombatEvent[] = [];
    tickLevelUpDeadlines(state, (e) => events.push(e));

    expect(p.pendingLevelUp).toBe(false);
    expect(p.weapons.length).toBe(1);
    expect(p.weapons[0]!.kind).toBe(1); // chose Orbit (choice 0)
    const resolved = events.find((e) => e.type === "level_up_resolved")!;
    if (resolved.type === "level_up_resolved") {
      expect(resolved.autoPicked).toBe(true);
    }
  });

  it("ignores players without pendingLevelUp", () => {
    const state = new RoomState();
    state.tick = 200;
    const p = addPlayer(state, "p1", 0, 0);
    p.pendingLevelUp = false;
    p.levelUpDeadlineTick = 100; // would be past, but pending is false

    const events: CombatEvent[] = [];
    tickLevelUpDeadlines(state, (e) => events.push(e));
    expect(events.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL with "tickLevelUpDeadlines not exported"**

Run: `pnpm --filter @mp/shared test rules`
Expected: FAIL.

- [ ] **Step 3: Implement `tickLevelUpDeadlines`**

Append to `packages/shared/src/rules.ts`:

```ts
/**
 * Auto-pick choice 0 for any player whose level-up deadline has passed.
 * Per spec §AD9 — same resolveLevelUp path, autoPicked=true.
 */
export function tickLevelUpDeadlines(state: RoomState, emit: Emit): void {
  state.players.forEach((player: Player) => {
    if (!player.pendingLevelUp) return;
    if (state.tick < player.levelUpDeadlineTick) return;
    if (player.levelUpChoices.length === 0) {
      // Pending but no choices — defensive recovery; clear and bail.
      player.pendingLevelUp = false;
      player.levelUpDeadlineTick = 0;
      return;
    }
    const weaponKind = player.levelUpChoices[0]!;
    resolveLevelUp(player, weaponKind, emit, /* autoPicked */ true);
  });
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm --filter @mp/shared test rules`
Expected: PASS.

### Task 8.2: Wire `tickLevelUpDeadlines` into `GameRoom`

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Add to `tick()` order between `tickXp` and `tickSpawner`**

```ts
private tick(): void {
  this.state.tick += 1;
  tickPlayers(this.state, SIM_DT_S);
  tickEnemies(this.state, SIM_DT_S);
  tickWeapons(this.state, SIM_DT_S, this.weaponCtx, this.emit);
  tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S, this.projectileCtx, this.emit);
  tickGems(this.state, this.emit);
  tickXp(this.state, this.rng, this.emit);
  tickLevelUpDeadlines(this.state, this.emit);
  tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);

  this.cooldownSweepCounter += 1;
  if (this.cooldownSweepCounter >= 100) {
    this.cooldownSweepCounter = 0;
    this.orbitHitCooldown.sweep(Date.now(), this.maxOrbitHitCooldownMs);
  }
}
```

Add `tickLevelUpDeadlines` to the `@mp/shared` import.

- [ ] **Step 2: Run typecheck and all tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 3: Manual verification of auto-pick**

Run: `pnpm dev`. Trigger a level-up (play for ~30s, or use `Shift+G` then kill enemies). Do NOT press 1/2/3 or click. After 10 seconds the overlay should vanish and the weapon should reflect choice 0 in the HUD.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/rules.ts packages/shared/test/rules.test.ts packages/server/src/GameRoom.ts
git commit -m "feat: tickLevelUpDeadlines auto-picks choice 0 at deadline"
```

---

## Phase 9 — Reconnection verification + `LevelUpFlashVfx`

### Task 9.1a: Add `debug_grant_xp` message (test infrastructure)

The reconnect-during-level-up integration test (Task 9.1b) needs a way to push a player over the XP threshold from the test process. Use a small debug message — symmetric with `debug_grant_weapon`, gated by `ALLOW_DEBUG_MESSAGES`, useful for manual testing of the level-up flow too.

**Files:**
- Modify: `packages/shared/src/messages.ts`
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Add the message type**

In `packages/shared/src/messages.ts`:

```ts
export type DebugGrantXpMessage = {
  type: "debug_grant_xp";
  amount: number;
};
```

Extend `ClientMessage`:

```ts
export type ClientMessage =
  | InputMessage
  | PingMessage
  | DebugSpawnMessage
  | DebugClearEnemiesMessage
  | DebugGrantWeaponMessage
  | DebugGrantXpMessage
  | LevelUpChoiceMessage;
```

Extend `MessageType`:

```ts
DebugGrantXp: "debug_grant_xp",
```

- [ ] **Step 2: Add the GameRoom handler**

In `packages/server/src/GameRoom.ts`, inside the `if (ALLOW_DEBUG_MESSAGES)` block:

```ts
this.onMessage<DebugGrantXpMessage>("debug_grant_xp", (client, message) => {
  const player = this.state.players.get(client.sessionId);
  if (!player) return;
  const raw = Number(message?.amount);
  if (!Number.isFinite(raw) || raw <= 0) return;
  // Cap at 10000 per call to prevent runaway XP.
  player.xp += Math.min(Math.floor(raw), 10_000);
});
```

Add `DebugGrantXpMessage` to the existing `@mp/shared` import.

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/messages.ts packages/server/src/GameRoom.ts
git commit -m "feat: debug_grant_xp message + handler"
```

### Task 9.1b: Add a server integration test for reconnection during level-up

**Files:**
- Create: `packages/server/test/levelUpReconnect.test.ts`

- [ ] **Step 1: Write the test**

This test mirrors the structure of the existing `packages/server/test/reconnect.test.ts` (which is the reference for the Colyseus reconnect API in this project). Key API specifics, lifted from the existing test:

- `room.reconnectionToken` — property on the colyseus.js Room
- `(room as any).connection.transport.close()` — force-disconnect by closing the underlying transport
- `client.reconnect<any>(token)` — reconnect using the saved token
- `process.env.MP_RECONNECTION_GRACE_S = "5"` — override the grace window for the test (the existing reconnect test uses "1"; we need longer because pendingLevelUp + 200-tick deadline takes a couple seconds to set up and we don't want to race the grace window)

```ts
// packages/server/test/levelUpReconnect.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "colyseus.js";
import { GameRoom } from "../src/GameRoom.js";

const PORT = 2603;

// Override grace BEFORE GameRoom imports parseGraceSeconds. The existing
// reconnect.test.ts also sets this at module top; same pattern here.
process.env.MP_RECONNECTION_GRACE_S = "5";

let gameServer: Server;

beforeAll(async () => {
  gameServer = new Server();
  gameServer.define("game", GameRoom).filterBy(["code"]);
  await gameServer.listen(PORT, undefined, undefined);
});

afterAll(async () => {
  await gameServer.gracefullyShutdown(false);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("integration: level-up state survives reconnection", () => {
  it("pendingLevelUp + choices + deadlineTick are preserved across reconnect", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;
    const token = room.reconnectionToken;

    // Push XP over the L1 threshold (xpForLevel(1)=6) so tickXp fires the
    // next simulation tick.
    room.send("debug_grant_xp", { type: "debug_grant_xp", amount: 100 });

    await waitFor(() => {
      const me = room.state.players.get(sessionId);
      return !!me?.pendingLevelUp && me.levelUpChoices.length === 3;
    }, 2000);

    const me = room.state.players.get(sessionId)!;
    const beforeDeadline = me.levelUpDeadlineTick;
    const beforeChoices = [me.levelUpChoices[0]!, me.levelUpChoices[1]!, me.levelUpChoices[2]!];
    expect(beforeDeadline).toBeGreaterThan(0);

    // Force a non-graceful disconnect.
    (room as any).connection.transport.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect within the (overridden 5s) grace window.
    const resumed = await client.reconnect<any>(token);
    await waitFor(() => resumed.state.code !== "" && resumed.state.code != null, 1500);

    expect(resumed.sessionId).toBe(sessionId);
    const meAfter = resumed.state.players.get(sessionId)!;
    expect(meAfter.pendingLevelUp).toBe(true);
    expect(meAfter.levelUpChoices.length).toBe(3);
    expect(meAfter.levelUpChoices[0]).toBe(beforeChoices[0]);
    expect(meAfter.levelUpChoices[1]).toBe(beforeChoices[1]);
    expect(meAfter.levelUpChoices[2]).toBe(beforeChoices[2]);
    // deadlineTick is in tick-space; it persists exactly.
    expect(meAfter.levelUpDeadlineTick).toBe(beforeDeadline);

    // The choice still works post-reconnect.
    resumed.send("level_up_choice", { type: "level_up_choice", choiceIndex: 0 });
    await waitFor(() => {
      const m = resumed.state.players.get(sessionId);
      return !!m && !m.pendingLevelUp && m.weapons.length >= 1;
    }, 1500);

    await resumed.leave();
  }, 12000);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @mp/server test levelUpReconnect`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/levelUpReconnect.test.ts
git commit -m "test(server): level-up state survives reconnection within grace"
```

### Task 9.2: Create `LevelUpFlashVfx.tsx`

**Files:**
- Create: `packages/client/src/game/LevelUpFlashVfx.tsx`
- Modify: `packages/client/src/game/GameView.tsx`

- [ ] **Step 1: Write the component**

```tsx
// packages/client/src/game/LevelUpFlashVfx.tsx
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, Mesh } from "three";
import type { Room } from "colyseus.js";
import type { Player, RoomState, LevelUpResolvedEvent } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const FLASH_DURATION_MS = 250;
const RING_START_RADIUS = 0.4;
const RING_END_RADIUS = 1.6;
const RING_Y = 0.05;
const MAX_FLASHES = 16; // 10 players, plenty of headroom for stacked level-ups

type FlashState = {
  playerId: string;
  startMs: number;
  meshIdx: number;
};

export type LevelUpFlashVfxProps = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * The single game-feel exception called out in the spec's non-goals
 * section. A 250ms ring flash on the leveling player. Single Group of
 * MAX_FLASHES preallocated Mesh children, scale-animated.
 */
export function LevelUpFlashVfx({ room, predictor, buffers }: LevelUpFlashVfxProps) {
  const groupRef = useRef<Group>(null);
  const flashes = useMemo<FlashState[]>(() => [], []);
  const free = useMemo<number[]>(
    () => Array.from({ length: MAX_FLASHES }, (_, i) => MAX_FLASHES - 1 - i),
    [],
  );

  useEffect(() => {
    const off = room.onMessage("level_up_resolved", (msg: LevelUpResolvedEvent) => {
      const slot = free.pop();
      if (slot === undefined) return; // out of capacity, drop
      flashes.push({
        playerId: msg.playerId,
        startMs: performance.now(),
        meshIdx: slot,
      });
    });
    return () => off();
  }, [room, flashes, free]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const now = performance.now();

    // Hide all rings, then re-position active ones.
    for (let i = 0; i < group.children.length; i++) {
      group.children[i]!.visible = false;
    }

    let w = 0;
    for (let r = 0; r < flashes.length; r++) {
      const f = flashes[r]!;
      const elapsed = now - f.startMs;
      if (elapsed >= FLASH_DURATION_MS) {
        free.push(f.meshIdx);
        continue;
      }
      // Resolve player render-pos.
      let rx = 0, rz = 0;
      const p: Player | undefined = room.state.players.get(f.playerId);
      if (p) {
        if (f.playerId === room.sessionId) {
          rx = predictor.predictedX;
          rz = predictor.predictedZ;
        } else {
          const sample = buffers.get(f.playerId)?.sample(now - hudState.interpDelayMs);
          rx = sample?.x ?? p.x;
          rz = sample?.z ?? p.z;
        }
      }
      const t = elapsed / FLASH_DURATION_MS; // 0..1
      const radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * t;
      const opacity = 1 - t;

      const mesh = group.children[f.meshIdx] as Mesh | undefined;
      if (mesh) {
        mesh.visible = true;
        mesh.position.set(rx, RING_Y, rz);
        mesh.scale.setScalar(radius);
        const mat = mesh.material as { opacity: number; transparent: boolean };
        mat.opacity = opacity;
        mat.transparent = true;
      }
      flashes[w++] = f;
    }
    flashes.length = w;
  });

  return (
    <group ref={groupRef}>
      {Array.from({ length: MAX_FLASHES }).map((_, i) => (
        <mesh key={i} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.9, 1.0, 24]} />
          <meshBasicMaterial color="#ffd24a" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
```

- [ ] **Step 2: Mount in `GameView.tsx`**

Inside the `<Canvas>` block, after `<OrbitSwarm ...>`:

```tsx
<LevelUpFlashVfx room={room} predictor={predictor} buffers={buffers} />
```

Add the import at the top.

- [ ] **Step 3: Manual verify**

Run: `pnpm dev`. Level up. A small expanding yellow ring should briefly play under your player.

- [ ] **Step 4: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/game/LevelUpFlashVfx.tsx packages/client/src/game/GameView.tsx
git commit -m "feat(client): LevelUpFlashVfx (250ms ring on level-up resolved)"
```

---

## Phase 10 — `PlayerHud` weapon list + final integration

### Task 10.1: Update `PlayerHud.tsx` to list all weapons

**Files:**
- Modify: `packages/client/src/game/PlayerHud.tsx`

- [ ] **Step 1: Replace the row-construction block**

Find the existing row-construction loop in `PlayerHud.tsx` (the `room.state.players.forEach((p: Player) => { ... })` block). Replace with:

```ts
room.state.players.forEach((p: Player) => {
  const namePad = (p.name || "Anon").padEnd(8).slice(0, 8);
  const xpStr = String(p.xp).padStart(4);
  const levelStr = String(p.level).padStart(2);

  // Cooldown bar uses the *first* projectile-behavior weapon in the list,
  // for visual continuity with M4. Orbit weapons have no cooldown.
  const projWeapon = p.weapons.find((w) => {
    const def = WEAPON_KINDS[w.kind];
    return def?.behavior.kind === "projectile";
  });
  const cd = cooldownBar(projWeapon);

  // Weapon list, comma-joined: "Bolt L2, Orbit L1".
  const weaponList: string[] = [];
  p.weapons.forEach((w) => {
    const def = WEAPON_KINDS[w.kind];
    if (!def) return;
    weaponList.push(`${def.name} L${w.level}`);
  });
  const weaponsStr = weaponList.length > 0 ? weaponList.join(", ") : "—";

  rows.push(`${namePad} XP ${xpStr}  Lv ${levelStr}  ${cd}  ${weaponsStr}`);
});
```

(`WEAPON_KINDS` is already imported. The `cooldownBar` helper from Phase 1 already handles the projectile-only case.)

- [ ] **Step 2: Manual verify**

Run: `pnpm dev`. Grant Orbit (`Shift+G`). The HUD row should read `Anon     XP    0  Lv 01  ▓░░░░  Bolt L1, Orbit L1`. Level up Bolt and verify the "L1" updates to "L2".

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/game/PlayerHud.tsx
git commit -m "feat(client): PlayerHud lists all weapons per player"
```

### Task 10.2: Update CLAUDE.md rule 12

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace rule 12**

Find rule 12 in `CLAUDE.md` (currently begins "Combat events are server→client only and time-based"). Replace its body with the M5-revised version from the spec (§"Update to CLAUDE.md rule set"):

```markdown
12. **Combat events are server→client only and time-based, not state.**
    `fire`, `hit`, `enemy_died`, `gem_collected`, `level_up_offered`,
    `level_up_resolved` are broadcast events, not schema entries.
    Projectile-behavior weapons are simulated client-side as a closed-form
    function of the `fire` event payload. Orbit-behavior weapons are
    simulated client-side as a closed-form function of `(state.tick,
    player position, weapon level)` — no per-frame syncing. Adding a new
    weapon means adding a row to `WEAPON_KINDS` against an existing
    `WeaponBehavior` kind; adding a new behavior kind means one new arm
    in `tickWeapons` and one new client renderer. Never name-based
    branching in tick or render code.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update rule 12 for orbit-behavior weapons (M5)"
```

### Task 10.3: Full verification

- [ ] **Step 1: Run all tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 2: Manual verification per spec §Verification**

Open two browser tabs at `http://localhost:5173/` (after `pnpm dev`). Walk through each numbered verification step in the spec:

1. ✅ Both join. Play normally. Within 30s at least one player levels up.
2. ✅ Level-up overlay appears for the leveling player only. Other player's enemies, weapons, gems all keep flowing.
3. ✅ The leveling player can move during the choice.
4. ✅ Pressing 1/2/3 selects; HUD reflects within 100ms.
5. ✅ Ignore for 10s: auto-pick fires, HUD updates, overlay dismisses.
6. ✅ Pick Orbit. Two L1 orbs visible at the SAME positions on both clients.
7. ✅ Orbit damages enemies. Same enemy is not shredded in one tick.
8. ✅ Multiple level-ups; both Bolt and Orbit upgrade; HUD reflects.
9. ✅ DevTools "Slow 3G" throttle on one client; level-up choice still works.
10. ✅ Disconnect via DevTools "offline" while overlay is showing. Reconnect within 30s. Overlay re-shows; remaining time correctly continues from the deadline.
11. ✅ `pnpm typecheck` and `pnpm test` both pass.

- [ ] **Step 3: Commit any final fixes**

If any of the manual steps surface a bug, fix and commit per the existing rhythm.

---

## Self-review notes

**Spec coverage check:**

- ✅ AD1 behavior dispatch — Phase 1 + Phase 3 (single switch, no name compares).
- ✅ AD2 orbit determinism — Phase 4 OrbitSwarm + Phase 3 server arm both use `state.tick / TICK_RATE * orbAngularSpeed + i*(2π/orbCount)`.
- ✅ AD3 discriminated WeaponDef — Phase 1.
- ✅ AD4 one-level-per-tick — Phase 6 `tickXp` gates on `!pendingLevelUp`; tested.
- ✅ AD5 fixed tick order + room rng — Phase 6/8 `GameRoom.tick()` comment + tests.
- ✅ AD6 schema as source of truth — Phase 5 schema fields + Phase 7 overlay reads schema each rAF.
- ✅ AD7 server-local OrbitHitCooldownStore — Phase 3.
- ✅ AD8 hit detection in tickWeapons (point-circle) — Phase 3.
- ✅ AD9 single pure resolveLevelUp — Phase 6.2; called from message handler + deadline.
- ✅ AD10 optimistic dismiss — Phase 7 overlay, no wait on resolved.
- ✅ AD11 no name-branches enforced — Phase 1's switch on `behavior.kind` is the only place; project review can grep.
- ✅ Reconnection — Phase 9.1 server integration test; client overlay reads schema so behavior is automatic.
- ✅ Tests required by spec — all covered across Phases 1, 2, 3, 6, 8, 9.
- ✅ CLAUDE.md rule 12 update — Phase 10.2.

**Placeholder scan:** none found.

**Type consistency:**

- `OrbitHitCooldownLike` (shared) is structurally satisfied by `OrbitHitCooldownStore` (server). Both have `tryHit`, `evictPlayer`, `evictEnemy`, `sweep`. Server passes the full store; rules.ts only uses the `OrbitHitCooldownLike` subset. ✅
- `WeaponContext` has `nextGemId` everywhere it's constructed (server `weaponCtx`, test helper). ✅
- `ProjectileContext` has `orbitHitCooldown` everywhere it's constructed. ✅
- `CombatEvent` widened to include `LevelUpOfferedEvent | LevelUpResolvedEvent`. ✅

---

## Execution choice

**Plan complete and saved to `docs/superpowers/plans/2026-05-05-m5-levelup-second-weapon-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for a 10-phase plan like this where some tasks (orbit hit math, level-up reconciliation) benefit from fresh-context review.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
