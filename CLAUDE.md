# monkey-punch

3D online co-op bullet-heaven, ~10 players per room, joined via shared link.
Server-authoritative. This file documents the architecture rules. Treat them as
binding — violations are bugs.

## Stack

- pnpm workspaces monorepo. Three packages: `client/`, `server/`, `shared/`.
- TypeScript strict everywhere. No `any` outside narrowly-scoped escape hatches.
- Client: Vite + React + React Three Fiber + drei.
- Server: Colyseus on Node 20.
- Shared: pure TS. Only runtime dep is `@colyseus/schema`.
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

## Things NOT to do

- Do not put behavior on schema classes. No methods, no getters with logic.
- Do not call `Math.random` anywhere a gameplay outcome can read it.
- Do not let the client send `{ x, y, z }` positions, health, kills, or any
  other state. Clients send inputs and intents only.
- Do not add a database, ORM, auth provider, or session store. None of those
  exist in this project.
- Do not add npm packages to `shared/` beyond `@colyseus/schema`. If you find
  yourself wanting to, the code probably belongs in `server/` or `client/`.
- Do not introduce a physics engine. Movement is direct integration; collision
  (when it exists) will be radius checks in `rules.ts`.
- Do not put gameplay code in Colyseus room handlers. Handlers route messages
  and call into `rules.ts`. That's it.
- Do not extrapolate snapshots on the client. Interpolate between the two most
  recent only; tolerate a small render-time delay (~100ms).
- Do not couple client rendering to server tick boundaries. The render loop and
  the simulation loop are independent.
- Do not check in build artifacts (`dist/`), `.env` files, or `node_modules/`.

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
