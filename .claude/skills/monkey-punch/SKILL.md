---
name: monkey-punch
description: Use when modifying any gameplay code in monkey-punch — schema fields, tick functions, weapons, enemies, projectiles, RNG, networking sync, the matchmaker, or anything in `packages/shared`. Encodes the architecture's load-bearing rules, the standard procedures for the most common changes, and three landmines that have already shipped bugs. Read before writing or editing code in `packages/{shared,server,client}/src`. Skip for pure tooling/CI/docs changes.
---

# monkey-punch — project skill

Game architecture is server-authoritative, deterministic, and lives almost entirely in `packages/shared`. The rules below are not preferences — they exist because each one has either been broken in production or designed in to enable a future capability that hasn't shipped yet (notably client-side projectile simulation).

CLAUDE.md at the repo root is the canonical rules document. This skill is the *procedural* companion: how to make the common kinds of changes without tripping the project's known wires.

## Quick architecture refresher

- Three packages: `shared/` (schema + messages + pure rules + rng), `server/` (Colyseus rooms, thin), `client/` (R3F renderer, sends inputs only).
- Server simulates at 20Hz with fixed `dt = 0.05s`. Client renders at 60fps, interpolates remote players ~100ms behind newest snapshot, predicts the local player and reconciles using `Player.lastProcessedInput`.
- Synced state lives in `packages/shared/src/schema.ts`. Client→server messages live in `packages/shared/src/messages.ts` as the `ClientMessage` discriminated union. All gameplay logic is pure functions in `packages/shared/src/rules.ts`.
- The fixed tick order (rules.ts) is load-bearing. Reordering can fork the seeded RNG schedule across clients:
  ```
  tickPlayers → tickEnemies → tickWeapons → tickProjectiles
              → tickGems → tickXp → tickLevelUpDeadlines → tickSpawner
  ```
  Both `tickXp` and `tickSpawner` consume the room rng. Reordering them desyncs clients deterministically. Don't.

## How to make the common changes

### Adding a new weapon

If the new weapon fits an existing behavior kind (`projectile` or `orbit`):
1. Add a row to `WEAPON_KINDS` in `packages/shared/src/weapons.ts` with five level entries.
2. Done. `tickWeapons` and the client renderer pick it up by behavior kind, not name. **No new branches in tick code or render code.**

If it requires a *new* behavior kind:
1. Add a new arm to the `WeaponDef` union and a corresponding `*Level` shape.
2. Add exactly one new arm in `tickWeapons` (server simulation).
3. Add exactly one new client renderer driven by the appropriate event (`fire` for projectile-like, or closed-form `(state.tick, player position, weapon level)` for orbit-like).
4. Read `CLAUDE.md` rule 12 before writing it. Never name-based branching.

### Adding a field to a Schema class

This is a landmine zone — read the **Schema field landmine** below before touching `schema.ts`. Then:
1. In `packages/shared/src/schema.ts`, add `declare fieldName: T;` to the class body.
2. Assign it in the constructor (`this.fieldName = ...`).
3. Add it to the `defineTypes(ClassName, { ... })` call below the class.
4. Run `pnpm --filter @mp/shared build` — consumers in server/client resolve `@mp/shared` through `dist/`, not `src/` (see **Stale dist landmine**).
5. Run `pnpm --filter @mp/server test` to catch encoder regressions via the integration test.

### Adding a client→server message

1. Define a new `XxxMessage` type in `packages/shared/src/messages.ts`.
2. Add it to the `ClientMessage` discriminated union.
3. Handle it in `packages/server/src/GameRoom.ts` `onMessage` dispatcher. Handler must be thin: parse → mutate `player.inputDir` (or equivalent intent field) → call into `rules.ts`. **No outcome-deciding logic in the handler.**
4. Send from client via the existing room channel.

### Adding a server→client event

Combat-style events (fire, hit, enemy_died, gem_collected, level_up_*) are broadcasts, not schema entries. They're time-based, not state.
1. Define the event payload type in `packages/shared/src/messages.ts` (e.g. `FireEvent`).
2. Build and broadcast from inside the relevant `tickX` function via the `emit` callback the room provides.
3. Client subscribes in `packages/client/src/net/`.
4. Never put combat events into schema.

### Modifying a tick function

1. Preserve tick order (see refresher above).
2. If the change consumes the room rng, every client must consume it identically. Do not call `rng()` conditionally on something that varies per-client (such as a player's local view).
3. Add a Vitest case in `packages/shared/test/rules.test.ts`. Tick functions are pure; they're cheap to test directly without a Colyseus runtime.

### Touching the matchmaker

Read the **Matchmaker filter landmine** below first. Any new filter field needs `this.listing.<field> = ...` set explicitly in `onCreate`.

## Determinism rules with teeth

- **Never `Math.random()` in any gameplay path.** Use `state.rng()` (mulberry32 from `packages/shared/src/rng.ts`). VFX-only randomness (e.g. screen shake) on the client can use Math.random because it doesn't affect outcomes — but if in doubt, use the rng.
- **The seed is set per-room and stored on `RoomState`.** Same seed + same input sequence = identical state on every client. This is what enables client-side projectile simulation (rule 8) — don't break it.
- **No wall-clock time in gameplay.** Use `state.tick` for time-based logic. `Date.now()` is fine for client-side animation/interpolation, never for outcome-affecting code.
- **Iteration order matters.** `MapSchema.forEach` order is implementation-defined; never rely on it for gameplay decisions. Always identify enemies by `Enemy.id`, never by iteration index (CLAUDE.md rule 10).

## Three landmines that have already shipped bugs

### 1. Schema field initializers silently break the encoder

Wrong:
```ts
class Player extends Schema {
  x = 0;                       // BREAKS UNDER tsx/Vite
  inputDir = new Vec2();
}
```

Right:
```ts
class Player extends Schema {
  declare x: number;
  declare inputDir: Vec2;
  constructor() { super(); this.x = 0; this.inputDir = new Vec2(); }
}
defineTypes(Player, { x: "number", inputDir: Vec2 });
```

**Why:** tsc honors `useDefineForClassFields: false`; esbuild (used by tsx and Vite) does not when crossing tsconfig path boundaries. esbuild emits `Object.defineProperty(this, "x", { value: 0 })`, which creates an own data property that shadows the prototype setter `defineTypes` installed. The setter never runs, `MapSchema.$childType` is never set, the encoder crashes the first real client connect with `Cannot read properties of undefined (reading 'Symbol(Symbol.metadata)')`. **Vitest unit tests do not catch this** — they don't drive the encoder.

**Regression guard:** `packages/server/test/integration.test.ts` boots a real Colyseus server and connects two real WebSocket clients. Run `pnpm --filter @mp/server test` after any schema change. Don't replace it with mocks.

The 19-line banner comment at the top of `packages/shared/src/schema.ts` documents this. Don't remove it.

### 2. Stale `@mp/shared` dist returns `undefined` for new exports

`packages/server` and `packages/client` import from `@mp/shared`, which resolves through `packages/shared/package.json`'s `exports` field — pointing at `dist/index.js`, **not `src/`**. New exports added to `shared/src/` are invisible to consumers until `dist/` is rebuilt.

**Symptom:** mysterious `undefined` reads, NaN math, tests failing on imports that "obviously" exist.

**Fix:** after editing `packages/shared/src/`, run one of:
- `pnpm typecheck` (workspace-wide; `tsc -b` rebuilds dist transitively via project references), or
- `pnpm --filter @mp/shared build` then `pnpm --filter @mp/<consumer> test`

Don't try to "fix" this by adding `src/` to `exports` — that breaks `tsc -b` ordering.

### 3. `<instancedMesh castShadow>` silently disappears

In Three.js 0.164 + R3F 8.18 with `<Canvas shadows>` and a default `<directionalLight castShadow>`, an `<instancedMesh castShadow>` whose instances live outside the directional light's shadow camera bounds (default ~5×5 world units) gets silently dropped from the **main** render pass. No console error, `mesh.visible === true`, `mesh.count` correct, geometry/material attached — `gl.info.render.calls` shows the InstancedMesh isn't submitted at all.

**Fix:** do NOT add `castShadow` to an `<instancedMesh>` unless you also expand the directional light's shadow camera bounds (`shadow-camera-left`, `shadow-camera-right`, etc.) to cover the instance area. The current `EnemySwarm` (`packages/client/src/game/EnemySwarm.tsx`) has a comment block explaining this — keep it.

### Bonus: Colyseus 0.16 internals don't match older docs

If poking Colyseus internals for instrumentation:
- `state.encodeAll()` does not exist on 0.16. Use `(this as any)._serializer.getFullState(null)` for full-state byte size.
- `Room#broadcastPatch()` returns `boolean` (`hasChanges`), not the encoded buffer.

Wrap any `(this as any)` cast over Colyseus internals in try/catch with a one-shot warn, so a future Colyseus upgrade fails loudly. `installSnapshotLogger` in `packages/server/src/GameRoom.ts` is the working reference.

## Verification before claiming a milestone or fix is done

The bare minimum after gameplay code changes:

```bash
pnpm typecheck            # builds dist transitively, catches the dist staleness landmine
pnpm test                 # vitest across shared, server, client
pnpm --filter @mp/server test    # explicitly runs integration.test.ts (real Colyseus, real WS)
```

For changes that affect rendering, sync, or perf, also run `pnpm dev` and verify visually with two browser tabs. Tests catch the schema/encoder/messaging surface; they do not catch the InstancedMesh-vanishing class of bug.

When in doubt, invoke `superpowers:verification-before-completion` — it makes "produce evidence before claiming done" structural.

## Where to learn more

- `CLAUDE.md` — canonical architecture rules (binding).
- `docs/superpowers/specs/` — per-milestone designs. Read the spec for a milestone before modifying code from that milestone.
- `docs/superpowers/plans/` — execution plans paired with each spec.
- `packages/shared/src/weapons.ts` — the data-only WEAPON_KINDS table; new weapon = new row here.
- `packages/server/test/integration.test.ts` — the encoder-and-matchmaker safety net.
