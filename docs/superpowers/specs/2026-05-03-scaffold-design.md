# Monkey-Punch Scaffold Design

**Date**: 2026-05-03
**Status**: Approved (awaiting written-spec review)
**Scope**: Foundation only. No gameplay features. Stop after scaffold is verified end-to-end with two browser tabs joining the same room.

## Goal

Stand up a pnpm-workspaces monorepo with three packages (`client`, `server`, `shared`), correctly wired so that:

- TypeScript project references propagate types across packages with no build step at dev time.
- A Colyseus server runs at 20Hz, holds authoritative state, and accepts a single `input` message type.
- A Vite + React Three Fiber client renders one cube per player on a flat plane, sends WASD input, and interpolates other players' positions between the most recent two server snapshots.
- Two browser tabs can join the same 4-character room code and see each other move smoothly.
- `pnpm typecheck` and `pnpm test` pass.

Nothing else. No enemies, combat, weapons, XP, persistence, auth, or chat.

## Non-Goals (this session)

- Gameplay of any kind: enemies, spawning, combat, weapons, XP, level-up, waves.
- Physics engine. Distance checks come later, in `rules.ts`.
- Database, auth, Discord OAuth, lobby list, chat.
- UI styling beyond what's needed to enter a name and a room code.
- Deployment configuration beyond a placeholder Dockerfile.
- Client-side prediction or extrapolation. Local player position is driven by server state, same as remote players.
- Lint / Prettier / Husky. Skipped per YAGNI.

## Stack and Versions

| Layer        | Choice                                                     |
| ------------ | ---------------------------------------------------------- |
| Node         | 20 LTS (≥20.11). `.nvmrc` pins `20`.                       |
| pnpm         | 9.x. `packageManager` field in root `package.json`.        |
| TypeScript   | 5.4+, strict mode everywhere.                              |
| Client       | Vite 5, React 18, `@react-three/fiber` 8, `@react-three/drei` 9, `colyseus.js` ^0.16. |
| Server       | Colyseus ^0.16, `@colyseus/schema` ^3, `tsx` for dev.      |
| Shared       | Pure TS. Only runtime dep: `@colyseus/schema`.             |
| Tests        | Vitest in `server/` and `shared/`.                         |
| Container    | Single placeholder Dockerfile, multi-stage, builds server. |

## Architectural Rules (binding)

These are written in their final form into `CLAUDE.md` at the repo root. Reproduced here for spec completeness.

1. **Server-authoritative.** Clients send inputs. Clients never send state.
2. **Synced state lives in `shared/schema.ts`** as Colyseus `Schema` classes. Anything reaching clients lives in a schema.
3. **Client→server messages live in `shared/messages.ts`** as a single discriminated union (`ClientMessage`) keyed by `type`.
4. **Game logic is pure functions in `shared/rules.ts`**, signature `(state, dt, rng) => void`. Room handlers route messages to schema mutations and call into `rules.ts` on tick. Handlers contain no decision logic.
5. **Entities are data, not objects.** Schemas hold fields only — no methods, no logic-bearing getters. Behavior lives in `rules.ts`.
6. **Determinism.** Anything affecting gameplay uses `mulberry32` from `shared/rng.ts`. Never `Math.random` in gameplay code. Seed is set per-run and stored on `RoomState`.
7. **No identity beyond Colyseus `sessionId`.** No accounts, no auth, no persistence. Display name passed at join, stored on `Player`.
8. **Projectiles do not sync.** Only weapon state syncs. Clients simulate projectiles locally from synced weapon state + seeded PRNG. (Not implemented this session, but no design choice may foreclose this.)
9. **Tickrate.** Server simulates at 20Hz. Client renders at 60fps and interpolates between the two most recent server snapshots for non-local players. Local player position is also server-driven (no client prediction yet).

## Repository Layout

```
monkey-punch/
├── CLAUDE.md
├── README.md
├── Dockerfile                       # placeholder, multi-stage server build
├── .dockerignore
├── .gitignore
├── .nvmrc                           # 20
├── package.json                     # workspace root, scripts, packageManager
├── pnpm-workspace.yaml
├── tsconfig.base.json               # shared strict compiler options
├── tsconfig.json                    # solution file: references all 3 packages
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-05-03-scaffold-design.md
├── packages/
│   ├── shared/
│   │   ├── package.json             # name: "@mp/shared"
│   │   ├── tsconfig.json            # composite: true, outDir dist
│   │   ├── src/
│   │   │   ├── index.ts             # re-exports schema, messages, rules, rng
│   │   │   ├── schema.ts            # RoomState, Player, Vec2, Enemy
│   │   │   ├── messages.ts          # ClientMessage union, MessageType const
│   │   │   ├── rules.ts             # tickPlayers + PLAYER_SPEED constant
│   │   │   └── rng.ts               # mulberry32
│   │   └── test/
│   │       └── rules.test.ts        # tickPlayers tests
│   ├── server/
│   │   ├── package.json             # name: "@mp/server"
│   │   ├── tsconfig.json            # references shared
│   │   ├── vitest.config.ts
│   │   ├── src/
│   │   │   ├── index.ts             # bootstraps Colyseus server
│   │   │   ├── GameRoom.ts          # Room<RoomState>, 20Hz loop, input handler
│   │   │   └── joinCode.ts          # 4-char code generator
│   │   └── test/
│   │       └── joinCode.test.ts
│   └── client/
│       ├── package.json             # name: "@mp/client"
│       ├── tsconfig.json            # references shared
│       ├── vite.config.ts           # alias @shared -> ../shared/src
│       ├── index.html
│       └── src/
│           ├── main.tsx             # React root
│           ├── App.tsx              # routes between Landing and GameView
│           ├── Landing.tsx          # name input, Create / Join buttons
│           ├── net/
│           │   ├── client.ts        # Colyseus.Client singleton
│           │   └── snapshots.ts     # ring buffer for interpolation
│           ├── game/
│           │   ├── GameView.tsx     # <Canvas> + scene
│           │   ├── Ground.tsx       # flat plane
│           │   ├── PlayerCube.tsx   # one cube; lerps toward interpolated position
│           │   └── input.ts         # WASD listener -> normalized {x,z}
│           └── styles.css
```

## TypeScript and Build Wiring

### `tsconfig.base.json`

Shared compiler options consumed by every package's `tsconfig.json` via `extends`.

- `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`.
- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`.
- `experimentalDecorators: true`, `useDefineForClassFields: false` (required for `@colyseus/schema` decorator API).
- `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`.
- `resolveJsonModule: true`, `isolatedModules: true`.

### `tsconfig.json` (solution file at repo root)

```json
{
  "files": [],
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/server" },
    { "path": "packages/client" }
  ]
}
```

Runs `pnpm typecheck` → `tsc -b` over the whole solution.

### `packages/shared/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

### `packages/server/tsconfig.json`

References shared. Server uses `tsx watch` for dev (no build needed), and `tsc -b` for prod via the Dockerfile.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"]
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*", "test/**/*"]
}
```

### `packages/client/tsconfig.json`

References shared. Vite handles the build. tsconfig is for IDE typing + `pnpm typecheck`.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true,
    "paths": {
      "@shared": ["../shared/src/index.ts"],
      "@shared/*": ["../shared/src/*"]
    }
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

### Vite alias

`packages/client/vite.config.ts` mirrors the tsconfig `paths`:

```typescript
resolve: {
  alias: {
    "@shared": path.resolve(__dirname, "../shared/src/index.ts"),
    "@shared/": path.resolve(__dirname, "../shared/src/") + "/",
  },
}
```

This lets the client import `@shared` directly from TS source — no `dist/` needed at dev time.

### How `pnpm dev` works

Root script uses `concurrently` (or pnpm's `--parallel`):

```
"dev": "pnpm -r --parallel --filter @mp/server --filter @mp/client run dev"
```

- Server `dev`: `tsx watch src/index.ts`
- Client `dev`: `vite`

Both watch shared TS source via the file system. No build step in dev.

## Shared Package Contents

### `shared/src/schema.ts`

```typescript
import { Schema, MapSchema, type } from "@colyseus/schema";

export class Vec2 extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
}

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type(Vec2) inputDir = new Vec2();
}

export class Enemy extends Schema {
  // intentionally empty for now; first gameplay PR fills this in.
}

export class RoomState extends Schema {
  @type("string") code = "";
  @type("uint32") seed = 0;
  @type("number") tick = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Enemy }) enemies = new MapSchema<Enemy>();
}
```

### `shared/src/messages.ts`

```typescript
export type InputMessage = {
  type: "input";
  dir: { x: number; z: number };
};

export type ClientMessage = InputMessage;

export const MessageType = {
  Input: "input",
} as const;
```

### `shared/src/rules.ts`

```typescript
import type { RoomState } from "./schema.js";

export const PLAYER_SPEED = 5; // units per second

export function tickPlayers(state: RoomState, dt: number): void {
  state.players.forEach((p) => {
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
  });
}
```

Future tick functions will accept an `rng` argument; `tickPlayers` doesn't need one yet.

### `shared/src/rng.ts`

```typescript
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Pure, deterministic, well-known. Used in `rules.test.ts` to verify reproducibility patterns even before any gameplay logic needs it.

### `shared/src/index.ts`

Public surface:

```typescript
export * from "./schema.js";
export * from "./messages.js";
export * from "./rules.js";
export * from "./rng.js";
```

### `shared/test/rules.test.ts`

Vitest. At minimum:

- `tickPlayers` moves a player by `inputDir * PLAYER_SPEED * dt`.
- Zero `inputDir` produces no movement.
- Multiple players move independently.
- `mulberry32` produces identical sequences for identical seeds (smoke test for the determinism contract).

## Server Package

### `server/src/joinCode.ts`

- Generates uppercase 4-char codes from an unambiguous alphabet (no `0`, `O`, `1`, `I`, `L`).
- Pure function: `generateJoinCode(rng: () => number = Math.random): string`.
- Uses `Math.random` only as the default; the function is parameterized so tests inject deterministic RNG.
- Unit-tested for length and alphabet.

### `server/src/GameRoom.ts`

- `class GameRoom extends Room<RoomState>`.
- `onCreate(options)`:
  - Generates a join code. Calls `this.setMetadata({ code })` so the matchmaker's `filterBy(["code"])` can route join requests to this room. Also writes `state.code = code` so connected clients can display it in the UI. Both writes are required and serve different consumers.
  - Initializes `RoomState`: `state.seed = (Math.random() * 0xFFFFFFFF) >>> 0`, `state.tick = 0`.
  - Registers handler for `"input"` messages: validates `dir.x` and `dir.z` are finite numbers; clamps vector length to ≤ 1; writes to `player.inputDir`.
  - Starts `setSimulationInterval(this.tick.bind(this), 50)` (20Hz).
- `onJoin(client, options)`:
  - Creates a `Player` with `sessionId = client.sessionId`, `name = options.name ?? "Anon"`, position `(0, 0, 0)`.
  - Adds to `state.players`.
- `onLeave(client)`: deletes from `state.players`.
- `tick(dt)`: increments `state.tick`; calls `tickPlayers(this.state, dt / 1000)`. (Colyseus passes dt in ms; rules expect seconds.)

### `server/src/index.ts`

Bootstraps `colyseus`'s `Server` on `process.env.PORT ?? 2567`. Defines the room with `gameServer.define("game", GameRoom).filterBy(["code"])` so clients can join by passing `{ code: "ABCD" }`.

### `server/test/joinCode.test.ts`

- Length is 4.
- Only uses allowed alphabet.
- Same seed → same code (when injecting deterministic RNG).

## Client Package

### `client/src/net/client.ts`

- Singleton `Colyseus.Client` pointed at `import.meta.env.VITE_SERVER_URL ?? "ws://localhost:2567"`.
- `createRoom(name: string): Promise<Room<RoomState>>` — calls `client.create("game", { name })`. Server picks the code; we read it from `room.state.code` after the first state sync.
- `joinRoom(code: string, name: string): Promise<Room<RoomState>>` — calls `client.join("game", { code, name })`. The matchmaker uses `filterBy(["code"])` to route the client to the room with that code. We deliberately do NOT use `joinById`, because the user enters the join code (which lives in metadata), not the internal Colyseus room id.

### `client/src/net/snapshots.ts`

Per-player ring buffer of `{ serverTime: number, x: number, z: number }`. Pushes on each `room.state.players` change. `interpolatedPosition(player, renderTime)` returns the position for `renderTime = now - INTERP_DELAY` by lerping between the two surrounding snapshots. If only one snapshot exists, returns it. If `renderTime` is past the latest, returns the latest (no extrapolation, per rule 9).

`INTERP_DELAY = 100` (ms). Two ticks at 20Hz.

### `client/src/Landing.tsx`

- Text input for display name.
- Two flows:
  - "Create room" button → calls `createRoom(name)` → on success, transitions to `GameView` with the room.
  - 4-char code input + "Join" button → calls `joinRoom(code, name)` → on success, transitions to `GameView`.
- Inline error if name is empty or join fails.
- No styling beyond what's needed for legibility.

### `client/src/game/GameView.tsx`

`@react-three/fiber` `<Canvas>` with:
- `<Ground />` — large flat plane at y=0.
- For each `state.players` entry: `<PlayerCube playerId={sessionId} room={room} />`.
- Top-banner overlay with the room code (so the host can copy it).

### `client/src/game/PlayerCube.tsx`

- Subscribes to the player's snapshot buffer.
- On each `useFrame`, computes interpolated position and lerps the mesh toward it (small smoothing).
- Renders a unit cube. Color-by-sessionId is OK (deterministic palette) — bare-minimum visual differentiation.

### `client/src/game/input.ts`

- Listens to `keydown` / `keyup` for WASD.
- On any change, computes `{ x, z }` from active keys, normalizes (so diagonal isn't faster), sends `room.send("input", { type: "input", dir: { x, z } })`.
- Throttle: send only when `dir` changes (don't spam every frame). Optional safety: also send a heartbeat on a 200ms timer if `dir` is non-zero, so a missed packet doesn't strand the player.

## Dockerfile (placeholder)

Multi-stage:

1. `FROM node:20-alpine AS build` — install pnpm, copy workspace, `pnpm install --frozen-lockfile`, `pnpm -r build`.
2. `FROM node:20-alpine AS run` — copy server `dist/` and shared `dist/`, `pnpm install --prod`, expose `2567`, `CMD ["node", "packages/server/dist/index.js"]`.

Not deployed this session. Just exists so Fly.io setup later is a small step.

## Verification

Acceptance criteria for this session:

1. `pnpm install` from a clean checkout completes without warnings beyond known peer-dep noise.
2. `pnpm typecheck` exits 0.
3. `pnpm test` runs Vitest in `shared/` and `server/`, all pass.
4. `pnpm dev` starts server on `:2567` and client on `:5173` (or Vite default).
5. Open two browser tabs:
   - Tab A: enter name "A", click Create. UI shows the room code.
   - Tab B: enter name "B", paste code, click Join.
   - Both tabs render two cubes on the ground.
   - Pressing WASD in either tab moves that tab's cube smoothly.
   - The other tab sees the moving cube interpolate (no teleporting, no extrapolation overshoot when keys release).
6. Closing a tab removes the corresponding cube in the other tab.

## Commit Plan

Logical chunks, not squashed:

1. `chore: pnpm workspace skeleton + tsconfig base + CLAUDE.md`
2. `feat(shared): schema, messages, rules, rng + tests`
3. `feat(server): GameRoom, joinCode, 20Hz loop + tests`
4. `feat(client): Vite + R3F app, landing, GameView, snapshots, input`
5. `chore: README + Dockerfile placeholder`

## Open Risks

- **Colyseus 0.16 schema API drift.** `@colyseus/schema` has had API changes between minor versions. If decorator syntax differs from what's specified, fall back to `defineTypes()` while keeping the same field shapes; document the deviation in the PR.
- **`MapSchema` iteration order.** `forEach` order isn't guaranteed across Colyseus versions. `tickPlayers` doesn't depend on order, but future code must not assume any.
- **Snapshot interpolation correctness under tab throttling.** When a tab is backgrounded, `requestAnimationFrame` slows to ~1Hz. Interpolation will fall behind. Acceptable for this session; revisit when networking is real.
- **Join code collisions.** ~32^4 ≈ 1M codes. Collision probability is low for friends-only use, but `onCreate` should retry on collision. Out of scope for this session if Colyseus's `filterBy` already errors on duplicate metadata; check at implementation time and either retry-loop or accept first-attempt failure.
