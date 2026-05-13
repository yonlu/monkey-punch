# monkey-punch

3D online co-op bullet-heaven, ~10 players per room, joined via shared link.
Server-authoritative. This file documents the architecture rules. Treat them as
binding — violations are bugs.

## Stack

- pnpm workspaces monorepo. Three packages: `client/`, `server/`, `shared/`.
- TypeScript strict everywhere. No `any` outside narrowly-scoped escape hatches.
- Client: Vite + React + React Three Fiber + drei.
- Server: Colyseus on Node 20.
- Shared: pure TS. Runtime deps: `@colyseus/schema` only. Terrain and
  environmental props used to require `simplex-noise` + `alea` for
  bit-identical server/client output, but both were retired (terrain is
  flat; `generateProps` returns []) and the deps were removed. Any
  future shared dep needs the same load-bearing-determinism
  justification — see "Things NOT to do" below.
- Tests: Vitest in `server/` and `shared/`.
- Single Dockerfile for the server. Deploy target: Fly.io (later).

## Architectural rules

1. **Server is authoritative.** Clients send inputs. Clients never send state.
   The server's RoomState is the only truth.
2. **All synced state is in `shared/schema.ts`** as Colyseus `Schema` classes.
   If a value needs to reach clients, it lives in a schema. Nothing else.
3. **All client→server messages live in `shared/messages.ts`** as a single
   discriminated union (`ClientMessage`) keyed by `type`. Adding a message means
   editing one file.
4. **Game logic is pure functions in `shared/rules.ts`.** Signature shape:
   `(state, dt, rng) => void` (mutates state) or `(state, dt, rng) => Result`.
   Room handlers are thin: they receive input, mutate `player.inputDir`, and
   call into `rules.ts` on the simulation tick. Room handlers contain no logic
   that decides outcomes.
5. **Entities are data, not objects.** Schema classes hold fields only — no
   methods. Behavior lives in `rules.ts`. This keeps logic testable without a
   live Colyseus runtime.
6. **Determinism.** Anything that affects gameplay uses the seeded PRNG in
   `shared/rng.ts` (`mulberry32`). Never `Math.random` in gameplay code. The
   seed is set per-run and stored on `RoomState`.
7. **No identity beyond Colyseus sessionId.** No accounts, no auth, no
   persistence. Display name is passed at join time and stored on the Player
   schema. Treat sessionId as the only identity. Reconnection within a 30s
   grace window preserves the same sessionId; clients that reconnect after
   the window get a new sessionId and a fresh `Player`. There is no
   cross-tab or cross-room identity.
8. **Projectiles do not sync.** Only weapon state syncs. Clients simulate
   projectile spawn/motion/lifetime locally from synced weapon state and the
   seeded PRNG. (Not implemented yet — but no design choice may foreclose this.)
9. **Tickrate.** Server simulates at 20Hz with a fixed `dt` of `0.05`s.
   The client renders at 60fps and interpolates remote players between
   the two most recent server snapshots (≈100ms behind newest). The
   local player runs client-side prediction at 20Hz and reconciles
   with the server on each snapshot: unacknowledged inputs (those with
   `seq > Player.lastProcessedInput`) are re-applied to the server's
   authoritative position to produce the predicted current frame.
10. **Enemies are simulated server-only and rendered client-side via
    InstancedMesh.** Never one Three.js Mesh per enemy. The single
    InstancedMesh has capacity `MAX_ENEMIES`; per-instance position comes
    from interpolating a per-enemy `SnapshotBuffer`, identified by the
    server-assigned `Enemy.id` (never by `MapSchema` iteration order).
    Spawner state (`accumulator`, `nextEnemyId`) lives on the GameRoom
    instance, not on RoomState — server-only counters do not pollute the
    schema.
11. **Tick order.** Each server tick runs in this fixed order:
    `tickPlayers → tickStatusEffects → tickEnemies → tickContactDamage
    → tickRunEndCheck → tickWeapons → tickProjectiles → tickBoomerangs
    → tickBloodPools → tickGems → tickXp → tickLevelUpDeadlines
    → tickSpawner`.
    Players first so weapons see fresh positions; status effects before
    enemies so movement uses fresh slow state (an enemy whose slow
    expires this tick is moved at full speed); contact damage after
    enemies so contact tests see post-movement positions; run-end check
    immediately after so weapons/projectiles/spawner all see the
    post-end state; weapons before projectiles so a same-tick fire is
    integrated next tick (it starts with `age = 0` and the projectile's
    first movement is in the *following* `tickProjectiles` call);
    boomerangs after projectiles so a same-tick boomerang throw is
    integrated next tick (mirrors the projectile pattern); blood pools
    after boomerangs so pools spawned this tick can DoT immediately if
    they overlap an enemy; gems after blood pools so this-tick pool
    kills drop pickups before pickup checks run; xp after gems so
    this-tick gem pickups feed the level-up threshold check; deadlines
    immediately after xp so an auto-pick that fires this tick uses
    fresh choices; spawner last so the rng schedule is fixed (xp +
    spawner both consume the room rng — reordering forks the seed;
    tickStatusEffects, tickBoomerangs, and tickBloodPools do NOT
    consume rng, so their insertion leaves the schedule intact).
    This order is load-bearing for fairness AND for cross-client
    determinism — do not reorder.
    Universal invariant (M6 onward): every tick function early-outs at
    its top with `if (state.runEnded) return;`. The frozen-world recap
    state is one branch in each function, not a per-system gate.
12. **Combat events are server→client only and time-based, not state.**
    `fire`, `hit`, `enemy_died`, `gem_collected`, `level_up_offered`,
    `level_up_resolved`, `player_damaged`, `player_downed`, `run_ended`
    are broadcast events, not schema entries.
    Projectile-behavior weapons are simulated client-side as a closed-form
    function of the `fire` event payload. Orbit-behavior weapons are
    simulated client-side as a closed-form function of `(state.tick,
    player position, weapon level)` — no per-frame syncing. Adding a new
    weapon means adding a row to `WEAPON_KINDS` against an existing
    `WeaponBehavior` kind; adding a new behavior kind means one new arm
    in `tickWeapons` and one new client renderer. Never name-based
    branching in tick or render code.

## Things NOT to do

- Do not put behavior on schema classes. No methods, no getters with logic.
- Do not call `Math.random` anywhere a gameplay outcome can read it.
- Do not let the client send `{ x, y, z }` positions, health, kills, or any
  other state. Clients send inputs and intents only.
- Do not add a database, ORM, auth provider, or session store. None of those
  exist in this project.
- Do not add npm packages to `shared/` casually. The bar: a dep belongs in
  `shared/` only if its output must be bit-identical between server and
  client — e.g. seeded noise for terrain that both sides query during
  prediction. If a `client/`-only or `server/`-only home would work, the
  code belongs there instead. Currently no approved exceptions — the
  previous `simplex-noise` + `alea` pair (terrain + props) was removed
  when terrain became flat and props were disabled. Re-adding either,
  or adding new deps, requires the same load-bearing-determinism
  justification.
- Do not introduce a physics engine. Movement is direct integration; collision
  (when it exists) will be radius checks in `rules.ts`.
- Do not put gameplay code in Colyseus room handlers. Handlers route messages
  and call into `rules.ts`. That's it.
- Do not extrapolate snapshots on the client. Interpolate between the two most
  recent only; tolerate a small render-time delay (~100ms).
- Do not couple client rendering to server tick boundaries. The render loop and
  the simulation loop are independent.
- Do not check in build artifacts (`dist/`), `.env` files, or `node_modules/`.
- **Status effects scale to two kinds, not three.** `Enemy` carries
  `slowMultiplier` and `slowExpiresAt` directly as fields — a
  single-effect shape, deliberate for one effect kind (slow, applied by
  Kronos in M8 US-010). If a future weapon needs a second effect kind
  (burn, freeze, stun, poison), add it the same way (a parallel pair of
  fields). If a third kind is needed, **refactor first**: replace the
  per-effect fields with `ArraySchema<StatusEffect>` per enemy (kind,
  magnitude, expiresAt), then add the third effect on top of the
  generic shape. The current per-effect fields are not infinitely
  extensible.

## Layout

- `packages/shared/` — schemas, messages, pure rules, rng. Imported by both
  others. No side effects on import.
- `packages/server/` — Colyseus bootstrap, GameRoom, join code generator. Thin.
- `packages/client/` — Vite + R3F app. Renders state, sends inputs.

## Dev commands

- `pnpm dev` — runs server (`tsx watch`) and client (`vite`) concurrently.
- `pnpm typecheck` — `tsc -b` over all references.
- `pnpm test` — Vitest in shared, server, and client.
- `pnpm build` — builds shared, server, and client for production.
