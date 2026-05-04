# Monkey-Punch Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm-workspaces monorepo (`shared`, `server`, `client`) with a Colyseus server, R3F client, deterministic shared rules, and end-to-end verification of two browser tabs joining the same room.

**Architecture:** Three TypeScript packages under `packages/`, wired together with TS project references for IDE typing and `tsc -b`. Dev-time consumption of `shared` happens through tsconfig `paths` aliasing `@mp/shared` to source, so neither `tsx` (server) nor Vite (client) needs `dist/`. Production server consumes built `dist/` via the package's `exports` field.

**Tech Stack:** pnpm 9, Node 20 LTS, TypeScript 5.4+ strict, Colyseus ^0.16, `@colyseus/schema` ^3 (decorator API, `experimentalDecorators: true`, `useDefineForClassFields: false`), Vite 5 + `@vitejs/plugin-react`, React 18, `@react-three/fiber` 8, `@react-three/drei` 9, `colyseus.js` ^0.16, Vitest, `tsx` for server dev.

**Spec:** [docs/superpowers/specs/2026-05-03-scaffold-design.md](../specs/2026-05-03-scaffold-design.md)

**Note on alias naming:** The spec used `@shared` for the client-side Vite/tsconfig alias. This plan uses `@mp/shared` (the workspace package name) consistently in both client and server, so there is one name for the shared module everywhere. If you want the `@shared` alias instead, change the import name and the alias string in the relevant tasks; nothing else moves.

---

## File Structure

| Chunk | Files created                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------- |
| 1     | Root configs, `CLAUDE.md`, `tsconfig.base.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `.nvmrc` |
| 2     | `packages/shared/{package.json,tsconfig.json,vitest.config.ts,src/{index,schema,messages,rules,rng}.ts,test/{rng,rules}.test.ts}` |
| 3     | `packages/server/{package.json,tsconfig.json,vitest.config.ts,src/{index,GameRoom,joinCode}.ts,test/joinCode.test.ts}` |
| 4     | `packages/client/{package.json,tsconfig.json,vite.config.ts,index.html,src/{main.tsx,App.tsx,Landing.tsx,styles.css,net/{client,snapshots}.ts,game/{GameView,Ground,PlayerCube,input}.{tsx,ts}}}` |
| 5     | `README.md`, `Dockerfile`                                                                           |

Per the spec, the only commits are the five chunk commits — no per-task commits.

---

## Chunk 1: Workspace skeleton + CLAUDE.md

**Goal:** A pnpm workspace that `pnpm install` accepts, with the shared TS base config and the binding architectural rules captured in `CLAUDE.md`.

### Task 1.1: Root `package.json`

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "monkey-punch",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=20.11"
  },
  "scripts": {
    "dev": "pnpm --parallel -r --filter @mp/server --filter @mp/client run dev",
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "tsc -b",
    "clean": "pnpm -r exec rm -rf dist && rm -rf node_modules/.cache"
  },
  "devDependencies": {
    "typescript": "^5.4.5"
  }
}
```

### Task 1.2: `pnpm-workspace.yaml`

**Files:**
- Create: `pnpm-workspace.yaml`

- [ ] **Step 1: Create the workspace file**

```yaml
packages:
  - "packages/*"
```

### Task 1.3: `tsconfig.base.json`

**Files:**
- Create: `tsconfig.base.json`

- [ ] **Step 1: Write the shared compiler options**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "verbatimModuleSyntax": false
  }
}
```

Why `useDefineForClassFields: false`: Colyseus schema decorators rely on legacy class-field semantics (initializers running in the constructor). With ES2022 target, TypeScript would default this to `true`, which breaks the decorator API.

### Task 1.4: Root solution `tsconfig.json`

**Files:**
- Create: `tsconfig.json`

- [ ] **Step 1: Write the solution file**

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

### Task 1.5: `.gitignore`, `.dockerignore`, `.nvmrc`

**Files:**
- Create: `.gitignore`
- Create: `.dockerignore`
- Create: `.nvmrc`

- [ ] **Step 1: `.gitignore`**

```
node_modules
dist
.DS_Store
*.log
.tsbuildinfo
.vite
*.local
.env
.env.*
!.env.example
```

- [ ] **Step 2: `.dockerignore`**

```
node_modules
**/node_modules
dist
**/dist
.git
.tsbuildinfo
**/.tsbuildinfo
.vite
**/*.log
docs
README.md
```

- [ ] **Step 3: `.nvmrc`**

```
20
```

### Task 1.6: `CLAUDE.md`

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write `CLAUDE.md`** (full content from the spec)

```markdown
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
   schema. Treat sessionId as the only identity.
8. **Projectiles do not sync.** Only weapon state syncs. Clients simulate
   projectile spawn/motion/lifetime locally from synced weapon state and the
   seeded PRNG. (Not implemented yet — but no design choice may foreclose this.)
9. **Tickrate.** Server simulates at 20Hz. Client renders at 60fps and
   interpolates between the most recent two server snapshots for non-local
   players. Local player position is also driven by server state (no client
   prediction yet).

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
- `pnpm test` — Vitest in shared + server.
- `pnpm build` — builds shared, server, and client for production.
```

### Task 1.7: Verify and commit Chunk 1

- [ ] **Step 1: Install (no packages yet, validates root config)**

Run: `pnpm install`
Expected: succeeds with a message like "Lockfile is up to date" or generates an empty `pnpm-lock.yaml`. No errors.

- [ ] **Step 2: Confirm `tsc -b` accepts the empty solution**

Run: `pnpm typecheck`
Expected: succeeds (the three referenced packages don't exist yet, but a fresh `tsc -b` will fail because the references can't be resolved). **If it fails with "File 'packages/shared/tsconfig.json' not found", that's expected — skip and let Chunk 2 onwards add the referenced packages. Do not commit yet if this fails; finish the chunk first.**

Actually re-running with current state: `tsc -b` requires the referenced `tsconfig.json` files to exist. So this command WILL fail until Chunk 2 starts. Skip the typecheck on Chunk 1 — it'll be exercised in Chunk 2.

- [ ] **Step 3: Commit Chunk 1**

```bash
git add CLAUDE.md package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json .gitignore .dockerignore .nvmrc
git commit -m "$(cat <<'EOF'
chore: pnpm workspace skeleton + tsconfig base + CLAUDE.md

Sets up the empty monorepo shell: workspace declaration, shared strict
TS compiler options (with experimentalDecorators and
useDefineForClassFields:false for Colyseus schema), solution-file
references, and the binding architectural rules.
EOF
)"
```

---

## Chunk 2: Shared package

**Goal:** `@mp/shared` exports `RoomState`, `Player`, `Vec2`, `Enemy`, `ClientMessage`, `tickPlayers`, `mulberry32`, with Vitest coverage on the pure functions.

### Task 2.1: `packages/shared/package.json`

**Files:**
- Create: `packages/shared/package.json`

- [ ] **Step 1: Write the package manifest**

```json
{
  "name": "@mp/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "clean": "rm -rf dist .tsbuildinfo"
  },
  "dependencies": {
    "@colyseus/schema": "^3.0.0"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

`exports` points at `dist/`. In dev, server and client bypass this via tsconfig `paths` aliases (added in Chunks 3 and 4) that point `@mp/shared` directly at source. In prod, the built `dist/` is what runs.

### Task 2.2: `packages/shared/tsconfig.json`

**Files:**
- Create: `packages/shared/tsconfig.json`

- [ ] **Step 1: Write the package tsconfig**

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

### Task 2.3: `packages/shared/vitest.config.ts`

**Files:**
- Create: `packages/shared/vitest.config.ts`

- [ ] **Step 1: Write the Vitest config**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

### Task 2.4: `shared/src/rng.ts` (TDD)

**Files:**
- Test: `packages/shared/test/rng.test.ts`
- Create: `packages/shared/src/rng.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/test/rng.test.ts
import { describe, it, expect } from "vitest";
import { mulberry32 } from "../src/rng.js";

describe("mulberry32", () => {
  it("produces identical sequences for identical seeds", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("returns values in the half-open range [0, 1)", () => {
    const r = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
```

- [ ] **Step 2: Install shared deps (first time pnpm reaches into the package)**

Run from repo root: `pnpm install`
Expected: pulls `@colyseus/schema` and `vitest`. `pnpm-lock.yaml` updates.

- [ ] **Step 3: Run the test, expect failure**

Run from repo root: `pnpm --filter @mp/shared test`
Expected: FAIL with "Failed to load url ../src/rng.js" or similar.

- [ ] **Step 4: Write the minimal implementation**

```typescript
// packages/shared/src/rng.ts
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

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @mp/shared test`
Expected: PASS — all three `mulberry32` tests green.

### Task 2.5: `shared/src/schema.ts`

**Files:**
- Create: `packages/shared/src/schema.ts`

- [ ] **Step 1: Write the schema**

```typescript
// packages/shared/src/schema.ts
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

- [ ] **Step 2: Verify the schema typechecks in isolation**

Run: `pnpm --filter @mp/shared exec tsc -b`
Expected: success, produces `packages/shared/dist/`.

### Task 2.6: `shared/src/messages.ts`

**Files:**
- Create: `packages/shared/src/messages.ts`

- [ ] **Step 1: Write the message types**

```typescript
// packages/shared/src/messages.ts
export type InputMessage = {
  type: "input";
  dir: { x: number; z: number };
};

export type ClientMessage = InputMessage;

export const MessageType = {
  Input: "input",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
```

### Task 2.7: `shared/src/rules.ts` (TDD)

**Files:**
- Test: `packages/shared/test/rules.test.ts`
- Create: `packages/shared/src/rules.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/test/rules.test.ts
import { describe, it, expect } from "vitest";
import { RoomState, Player } from "../src/schema.js";
import { tickPlayers, PLAYER_SPEED } from "../src/rules.js";

function addPlayer(state: RoomState, id: string, dirX: number, dirZ: number): Player {
  const p = new Player();
  p.sessionId = id;
  p.inputDir.x = dirX;
  p.inputDir.z = dirZ;
  state.players.set(id, p);
  return p;
}

describe("tickPlayers", () => {
  it("moves a player by inputDir * PLAYER_SPEED * dt on each axis", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);

    tickPlayers(state, 0.5);

    expect(p.x).toBeCloseTo(PLAYER_SPEED * 0.5);
    expect(p.z).toBe(0);
  });

  it("zero inputDir produces no movement", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);

    tickPlayers(state, 1.0);

    expect(p.x).toBe(0);
    expect(p.z).toBe(0);
  });

  it("moves multiple players independently", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 1, 0);
    const b = addPlayer(state, "b", 0, -1);

    tickPlayers(state, 0.1);

    expect(a.x).toBeCloseTo(PLAYER_SPEED * 0.1);
    expect(a.z).toBe(0);
    expect(b.x).toBe(0);
    expect(b.z).toBeCloseTo(-PLAYER_SPEED * 0.1);
  });

  it("integration over multiple ticks accumulates", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);

    for (let i = 0; i < 10; i++) {
      tickPlayers(state, 0.05);
    }

    expect(p.x).toBeCloseTo(PLAYER_SPEED * 0.5);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @mp/shared test`
Expected: FAIL with "Failed to load url ../src/rules.js" or "tickPlayers is not a function".

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/rules.ts
import type { RoomState } from "./schema.js";

export const PLAYER_SPEED = 5; // world units per second

export function tickPlayers(state: RoomState, dt: number): void {
  state.players.forEach((p) => {
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
  });
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @mp/shared test`
Expected: PASS — all four `tickPlayers` tests + three `mulberry32` tests green.

### Task 2.8: `shared/src/index.ts` re-exports

**Files:**
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the public surface**

```typescript
// packages/shared/src/index.ts
export * from "./schema.js";
export * from "./messages.js";
export * from "./rules.js";
export * from "./rng.js";
```

### Task 2.9: Verify and commit Chunk 2

- [ ] **Step 1: Build shared (verifies the package compiles standalone)**

Run: `pnpm --filter @mp/shared run build`
Expected: success, populates `packages/shared/dist/` with `.js`, `.d.ts`, and `.tsbuildinfo`.

- [ ] **Step 2: Re-run shared tests**

Run: `pnpm --filter @mp/shared test`
Expected: 7 tests pass (3 rng + 4 rules).

- [ ] **Step 3: Commit Chunk 2**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(shared): schema, messages, rules, rng + tests

Adds the @mp/shared package: Colyseus schema classes (RoomState,
Player, Vec2, Enemy), the ClientMessage discriminated union, the
deterministic mulberry32 PRNG, and tickPlayers — a pure function over
RoomState that moves each player by inputDir * PLAYER_SPEED * dt.
Vitest covers rng determinism and tickPlayers integration.
EOF
)"
```

---

## Chunk 3: Server package

**Goal:** A Colyseus server with one `GameRoom` (4-char join code via `filterBy`), 20Hz simulation loop calling into `tickPlayers`, and an `input` message handler.

### Task 3.1: `packages/server/package.json`

**Files:**
- Create: `packages/server/package.json`

- [ ] **Step 1: Write the package manifest**

```json
{
  "name": "@mp/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "clean": "rm -rf dist .tsbuildinfo"
  },
  "dependencies": {
    "@colyseus/schema": "^3.0.0",
    "@mp/shared": "workspace:*",
    "colyseus": "^0.16.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "tsx": "^4.7.0",
    "vitest": "^1.6.0"
  }
}
```

### Task 3.2: `packages/server/tsconfig.json`

**Files:**
- Create: `packages/server/tsconfig.json`

- [ ] **Step 1: Write the package tsconfig**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@mp/shared": ["../shared/src/index.ts"]
    }
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

The `paths` alias makes `@mp/shared` resolve to source for both `tsx` (dev) and editor type-checking. At prod build time, `tsc` preserves the import string; at runtime, Node resolves `@mp/shared` via the workspace symlink to the package's `exports` (which point at `dist/`). Two resolution paths, one import string.

### Task 3.3: `packages/server/vitest.config.ts`

**Files:**
- Create: `packages/server/vitest.config.ts`

- [ ] **Step 1: Write the Vitest config**

```typescript
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@mp/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
});
```

Vitest needs the alias too because it doesn't read tsconfig `paths` by default.

### Task 3.4: `server/src/joinCode.ts` (TDD)

**Files:**
- Test: `packages/server/test/joinCode.test.ts`
- Create: `packages/server/src/joinCode.ts`

- [ ] **Step 1: Install server deps**

Run from repo root: `pnpm install`
Expected: pulls `colyseus`, `tsx`, `@types/node`, `vitest`. Workspace symlink created at `packages/server/node_modules/@mp/shared` → `packages/shared`.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/server/test/joinCode.test.ts
import { describe, it, expect } from "vitest";
import { mulberry32 } from "@mp/shared";
import { generateJoinCode, JOIN_CODE_ALPHABET } from "../src/joinCode.js";

const ALPHABET_RE = new RegExp(`^[${JOIN_CODE_ALPHABET}]+$`);

describe("generateJoinCode", () => {
  it("returns a 4-character string", () => {
    expect(generateJoinCode()).toHaveLength(4);
  });

  it("uses only the unambiguous alphabet (no 0/O/1/I/L)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(ALPHABET_RE);
    }
  });

  it("is deterministic when the same RNG is supplied", () => {
    const seed = 12345;
    const codeA = generateJoinCode(mulberry32(seed));
    const codeB = generateJoinCode(mulberry32(seed));
    expect(codeA).toBe(codeB);
  });

  it("produces varied output across calls (smoke test)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(generateJoinCode());
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @mp/server test`
Expected: FAIL with module-not-found for `../src/joinCode.js`.

- [ ] **Step 4: Write the implementation**

```typescript
// packages/server/src/joinCode.ts
// Excludes ambiguous glyphs: 0, 1, I, L, O.
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateJoinCode(rng: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(rng() * JOIN_CODE_ALPHABET.length);
    code += JOIN_CODE_ALPHABET.charAt(idx);
  }
  return code;
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @mp/server test`
Expected: PASS — 4 tests green.

### Task 3.5: `server/src/GameRoom.ts`

**Files:**
- Create: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Write the room**

```typescript
// packages/server/src/GameRoom.ts
import { Room, Client } from "colyseus";
import { Player, RoomState, tickPlayers } from "@mp/shared";
import type { InputMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";

const TICK_INTERVAL_MS = 50; // 20 Hz
const MAX_PLAYERS = 10;

type JoinOptions = {
  name?: string;
  code?: string;
};

export class GameRoom extends Room<RoomState> {
  override maxClients = MAX_PLAYERS;

  override onCreate(_options: JoinOptions): void {
    const state = new RoomState();
    const code = generateJoinCode();
    state.code = code;
    state.seed = (Math.random() * 0xffffffff) >>> 0;
    state.tick = 0;
    this.setState(state);

    // setMetadata is what filterBy(["code"]) actually filters against; state.code is for
    // the client UI to display. Both writes are required.
    this.setMetadata({ code });

    this.onMessage<InputMessage>("input", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const dx = Number(message?.dir?.x);
      const dz = Number(message?.dir?.z);
      if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
      const len = Math.hypot(dx, dz);
      const scale = len > 1 ? 1 / len : 1;
      player.inputDir.x = dx * scale;
      player.inputDir.z = dz * scale;
    });

    this.setSimulationInterval((dt) => this.tick(dt), TICK_INTERVAL_MS);
  }

  override onJoin(client: Client, options: JoinOptions): void {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = (options?.name ?? "Anon").slice(0, 24);
    player.x = 0;
    player.y = 0;
    player.z = 0;
    this.state.players.set(client.sessionId, player);
  }

  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
  }

  private tick(dtMs: number): void {
    this.state.tick += 1;
    tickPlayers(this.state, dtMs / 1000);
  }
}
```

### Task 3.6: `server/src/index.ts` (bootstrap)

**Files:**
- Create: `packages/server/src/index.ts`

- [ ] **Step 1: Write the bootstrap**

```typescript
// packages/server/src/index.ts
import { Server } from "colyseus";
import { GameRoom } from "./GameRoom.js";

const port = Number(process.env.PORT ?? 2567);
const gameServer = new Server();

gameServer
  .define("game", GameRoom)
  .filterBy(["code"]);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[server] listening on ws://localhost:${port}`);
  })
  .catch((err) => {
    console.error("[server] failed to start:", err);
    process.exit(1);
  });
```

`filterBy(["code"])` registers `code` as a matchmaking option. When a client calls `client.join("game", { code: "ABCD" })`, Colyseus only routes to rooms whose metadata `code === "ABCD"`. When a client calls `client.create("game", { name })` (no code), it always creates a fresh room, which then sets its own metadata `code` in `onCreate`.

### Task 3.7: Verify and commit Chunk 3

- [ ] **Step 1: Run server tests**

Run: `pnpm --filter @mp/server test`
Expected: 4 tests pass.

- [ ] **Step 2: Typecheck the whole solution**

Run from repo root: `pnpm typecheck`
Expected: success — `tsc -b` walks shared → server → client (client refs will fail until Chunk 4; if so, run `pnpm --filter @mp/shared --filter @mp/server exec tsc -b` instead, or skip and re-run after Chunk 4).

- [ ] **Step 3: Smoke-test that the server boots**

Run: `pnpm --filter @mp/server dev` in one terminal.
Expected: console prints `[server] listening on ws://localhost:2567` within ~3 seconds. Stop it with Ctrl+C.

- [ ] **Step 4: Commit Chunk 3**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(server): GameRoom, joinCode, 20Hz loop + tests

Adds the @mp/server package: Colyseus bootstrap on port 2567, a single
GameRoom registered with filterBy(["code"]) so clients join by 4-char
code, a 20Hz simulation loop calling tickPlayers from @mp/shared, and
an input handler that validates and clamps player direction. Join code
generator excludes ambiguous glyphs (0/1/I/L/O); Vitest covers
alphabet, length, and determinism.
EOF
)"
```

---

## Chunk 4: Client package

**Goal:** Vite + R3F app with a landing page (Create / Join) and a `GameView` that renders one cube per player on a flat plane. WASD sends input; remote players are interpolated between the last two server snapshots.

### Task 4.1: `packages/client/package.json`

**Files:**
- Create: `packages/client/package.json`

- [ ] **Step 1: Write the package manifest**

```json
{
  "name": "@mp/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b"
  },
  "dependencies": {
    "@mp/shared": "workspace:*",
    "@react-three/drei": "^9.105.0",
    "@react-three/fiber": "^8.16.0",
    "colyseus.js": "^0.16.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "three": "^0.164.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/three": "^0.164.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.2.0"
  }
}
```

### Task 4.2: `packages/client/tsconfig.json`

**Files:**
- Create: `packages/client/tsconfig.json`

- [ ] **Step 1: Write the package tsconfig**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": false,
    "baseUrl": ".",
    "paths": {
      "@mp/shared": ["../shared/src/index.ts"]
    },
    "types": ["vite/client"]
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

### Task 4.3: `packages/client/vite.config.ts`

**Files:**
- Create: `packages/client/vite.config.ts`

- [ ] **Step 1: Write the Vite config**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@mp/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
  },
});
```

### Task 4.4: `packages/client/index.html`

**Files:**
- Create: `packages/client/index.html`

- [ ] **Step 1: Write the entry HTML**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>monkey-punch</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### Task 4.5: `packages/client/src/styles.css`

**Files:**
- Create: `packages/client/src/styles.css`

- [ ] **Step 1: Write the bare-minimum stylesheet**

```css
:root {
  font-family: system-ui, -apple-system, sans-serif;
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body, #root { margin: 0; padding: 0; height: 100%; background: #111; color: #eee; }

.landing {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 1rem;
}

.landing input {
  font-size: 1rem;
  padding: 0.5rem 0.75rem;
  background: #222;
  color: #eee;
  border: 1px solid #444;
  border-radius: 4px;
  text-transform: uppercase;
}

.landing button {
  font-size: 1rem;
  padding: 0.5rem 1rem;
  background: #2a2a8a;
  color: #fff;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

.landing button:disabled { background: #333; cursor: not-allowed; }

.landing .row { display: flex; gap: 0.5rem; align-items: center; }

.landing .error { color: #f77; min-height: 1.2em; }

.banner {
  position: absolute;
  top: 0; left: 0; right: 0;
  padding: 0.5rem 1rem;
  background: rgba(0,0,0,0.5);
  font-family: ui-monospace, monospace;
  pointer-events: none;
  z-index: 10;
}
```

### Task 4.6: `client/src/net/client.ts`

**Files:**
- Create: `packages/client/src/net/client.ts`

- [ ] **Step 1: Write the Colyseus client wrapper**

```typescript
// packages/client/src/net/client.ts
import { Client, Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "ws://localhost:2567";

export const colyseusClient = new Client(SERVER_URL);

export async function createRoom(name: string): Promise<Room<RoomState>> {
  return colyseusClient.create<RoomState>("game", { name });
}

export async function joinRoom(code: string, name: string): Promise<Room<RoomState>> {
  return colyseusClient.join<RoomState>("game", { code, name });
}
```

### Task 4.7: `client/src/net/snapshots.ts`

**Files:**
- Create: `packages/client/src/net/snapshots.ts`

- [ ] **Step 1: Write the interpolation buffer**

```typescript
// packages/client/src/net/snapshots.ts
export type Snapshot = { t: number; x: number; z: number };

const HISTORY = 4; // keep a small ring buffer per player
export const INTERP_DELAY_MS = 100; // render this far behind newest snapshot

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];

  push(snap: Snapshot): void {
    this.snaps.push(snap);
    if (this.snaps.length > HISTORY) this.snaps.shift();
  }

  /**
   * Return interpolated {x,z} for the given render time (in the same time base as snapshots).
   * No extrapolation: clamps to most recent snapshot if renderTime is past it.
   */
  sample(renderTime: number): { x: number; z: number } | null {
    if (this.snaps.length === 0) return null;
    if (this.snaps.length === 1) {
      const only = this.snaps[0]!;
      return { x: only.x, z: only.z };
    }

    const last = this.snaps[this.snaps.length - 1]!;
    if (renderTime >= last.t) return { x: last.x, z: last.z };

    const first = this.snaps[0]!;
    if (renderTime <= first.t) return { x: first.x, z: first.z };

    for (let i = this.snaps.length - 1; i > 0; i--) {
      const a = this.snaps[i - 1]!;
      const b = this.snaps[i]!;
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t;
        const u = span > 0 ? (renderTime - a.t) / span : 0;
        return {
          x: a.x + (b.x - a.x) * u,
          z: a.z + (b.z - a.z) * u,
        };
      }
    }
    return { x: last.x, z: last.z };
  }
}
```

Time base is `performance.now()` (caller passes timestamps in milliseconds). Render time is `performance.now() - INTERP_DELAY_MS`.

### Task 4.8: `client/src/game/input.ts`

**Files:**
- Create: `packages/client/src/game/input.ts`

- [ ] **Step 1: Write the WASD listener**

```typescript
// packages/client/src/game/input.ts
import type { Room } from "colyseus.js";
import type { InputMessage, RoomState } from "@mp/shared";

const KEYS = { w: false, a: false, s: false, d: false };

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

export function attachInput(room: Room<RoomState>): () => void {
  let last = { x: 0, z: 0 };

  const send = () => {
    const dir = computeDir();
    if (dir.x === last.x && dir.z === last.z) return;
    last = dir;
    const msg: InputMessage = { type: "input", dir };
    room.send("input", msg);
  };

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k !== "w" && k !== "a" && k !== "s" && k !== "d") return;
    if (KEYS[k] === down) return;
    KEYS[k] = down;
    send();
  };

  const downHandler = onKey(true);
  const upHandler = onKey(false);
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);

  // Heartbeat: re-send current dir periodically while non-zero, in case a packet was lost.
  const heartbeat = window.setInterval(() => {
    const dir = computeDir();
    if (dir.x === 0 && dir.z === 0) return;
    const msg: InputMessage = { type: "input", dir };
    room.send("input", msg);
  }, 200);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.clearInterval(heartbeat);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
  };
}
```

### Task 4.9: `client/src/game/Ground.tsx`

**Files:**
- Create: `packages/client/src/game/Ground.tsx`

- [ ] **Step 1: Write the ground plane**

```typescript
// packages/client/src/game/Ground.tsx
export function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#2c3e50" />
    </mesh>
  );
}
```

### Task 4.10: `client/src/game/PlayerCube.tsx`

**Files:**
- Create: `packages/client/src/game/PlayerCube.tsx`

- [ ] **Step 1: Write the cube component**

```typescript
// packages/client/src/game/PlayerCube.tsx
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import { SnapshotBuffer, INTERP_DELAY_MS } from "../net/snapshots.js";

export type PlayerView = {
  sessionId: string;
  name: string;
  x: number;
  y: number;
  z: number;
};

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export type PlayerCubeProps = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
};

export function PlayerCube({ sessionId, buffer }: PlayerCubeProps) {
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => colorFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!ref.current) return;
    const sample = buffer.sample(performance.now() - INTERP_DELAY_MS);
    if (sample) ref.current.position.set(sample.x, 0.5, sample.z);
  }, [buffer]);

  useFrame(() => {
    if (!ref.current) return;
    const sample = buffer.sample(performance.now() - INTERP_DELAY_MS);
    if (!sample) return;
    ref.current.position.x = sample.x;
    ref.current.position.z = sample.z;
    ref.current.position.y = 0.5;
  });

  return (
    <mesh ref={ref} castShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}
```

### Task 4.11: `client/src/game/GameView.tsx`

**Files:**
- Create: `packages/client/src/game/GameView.tsx`

- [ ] **Step 1: Write the game view**

```typescript
// packages/client/src/game/GameView.tsx
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { Room } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import { Ground } from "./Ground.js";
import { PlayerCube } from "./PlayerCube.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { attachInput } from "./input.js";

type PlayerEntry = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
};

export function GameView({ room }: { room: Room<RoomState> }) {
  const [players, setPlayers] = useState<Map<string, PlayerEntry>>(new Map());
  const [code, setCode] = useState<string>(room.state.code ?? "");

  // The buffer map is mutable across re-renders; we just trigger renders when entries change.
  const buffers = useMemo(() => new Map<string, SnapshotBuffer>(), []);

  useEffect(() => {
    const detachInput = attachInput(room);

    const updateCode = () => setCode(room.state.code ?? "");
    room.state.listen("code", updateCode);
    updateCode();

    const onAdd = (player: Player, sessionId: string) => {
      let buf = buffers.get(sessionId);
      if (!buf) {
        buf = new SnapshotBuffer();
        buffers.set(sessionId, buf);
      }
      buf.push({ t: performance.now(), x: player.x, z: player.z });

      player.onChange(() => {
        buf!.push({ t: performance.now(), x: player.x, z: player.z });
      });

      setPlayers((prev) => {
        const next = new Map(prev);
        next.set(sessionId, { sessionId, name: player.name, buffer: buf! });
        return next;
      });
    };

    const onRemove = (_player: Player, sessionId: string) => {
      buffers.delete(sessionId);
      setPlayers((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    };

    room.state.players.onAdd(onAdd);
    room.state.players.onRemove(onRemove);

    // Seed any players already present at the moment we attach.
    room.state.players.forEach((p, id) => onAdd(p, id));

    return () => {
      detachInput();
    };
  }, [room, buffers]);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <div className="banner">room: <strong>{code}</strong> · share this code with friends</div>
      <Canvas
        shadows
        camera={{ position: [0, 12, 12], fov: 55 }}
        style={{ width: "100%", height: "100%" }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 5]} intensity={1.0} castShadow />
        <Ground />
        {Array.from(players.values()).map((p) => (
          <PlayerCube key={p.sessionId} sessionId={p.sessionId} name={p.name} buffer={p.buffer} />
        ))}
      </Canvas>
    </div>
  );
}
```

### Task 4.12: `client/src/Landing.tsx`

**Files:**
- Create: `packages/client/src/Landing.tsx`

- [ ] **Step 1: Write the landing page**

```typescript
// packages/client/src/Landing.tsx
import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { createRoom, joinRoom } from "./net/client.js";

type Props = {
  onJoined: (room: Room<RoomState>) => void;
};

export function Landing({ onJoined }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const trimmedName = name.trim();
  const cleanCode = code.trim().toUpperCase();
  const canCreate = !busy && trimmedName.length > 0;
  const canJoin = canCreate && cleanCode.length === 4;

  const handle = async (action: () => Promise<Room<RoomState>>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const room = await action();
      onJoined(room);
    } catch (err) {
      setError((err as Error).message ?? "failed to join");
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <h1>monkey-punch</h1>
      <input
        placeholder="display name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={24}
      />
      <button
        disabled={!canCreate}
        onClick={() => handle(() => createRoom(trimmedName))}
      >
        create room
      </button>
      <div className="row">
        <input
          placeholder="CODE"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={4}
          style={{ width: "6rem", textAlign: "center" }}
        />
        <button
          disabled={!canJoin}
          onClick={() => handle(() => joinRoom(cleanCode, trimmedName))}
        >
          join
        </button>
      </div>
      <div className="error">{error}</div>
    </div>
  );
}
```

### Task 4.13: `client/src/App.tsx`

**Files:**
- Create: `packages/client/src/App.tsx`

- [ ] **Step 1: Write the top-level routing component**

```typescript
// packages/client/src/App.tsx
import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Landing } from "./Landing.js";
import { GameView } from "./game/GameView.js";

export function App() {
  const [room, setRoom] = useState<Room<RoomState> | null>(null);

  if (!room) return <Landing onJoined={setRoom} />;
  return <GameView room={room} />;
}
```

### Task 4.14: `client/src/main.tsx`

**Files:**
- Create: `packages/client/src/main.tsx`

- [ ] **Step 1: Write the React entry point**

```typescript
// packages/client/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("no #root element");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

### Task 4.15: Verify and commit Chunk 4

- [ ] **Step 1: Install client deps**

Run from repo root: `pnpm install`
Expected: pulls React, three, R3F, drei, colyseus.js, vite, plugin-react, @types/*. Updates `pnpm-lock.yaml`.

- [ ] **Step 2: Typecheck the whole solution**

Run from repo root: `pnpm typecheck`
Expected: success, all three packages typecheck.

- [ ] **Step 3: Smoke-test the Vite dev server**

Run: `pnpm --filter @mp/client dev` in one terminal.
Expected: Vite prints `Local: http://localhost:5173`. Open it in a browser; landing page renders with name input and Create / Join buttons. Stop with Ctrl+C.

- [ ] **Step 4: Commit Chunk 4**

```bash
git add packages/client pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(client): Vite + R3F app, landing, GameView, snapshots, input

Adds the @mp/client package: Vite + React 18 entry, a landing page
with Create / Join flows, and a GameView that subscribes to the
Colyseus room state. Each player renders as a colored cube on a flat
plane; remote players interpolate between the last two server
snapshots with a 100ms render delay (no extrapolation). WASD input is
normalized client-side, deduped, and re-sent on a 200ms heartbeat.
EOF
)"
```

---

## Chunk 5: Dev script wiring + README + Dockerfile + verification

**Goal:** `pnpm dev` brings up server + client together. README documents the workflow. Dockerfile exists as a placeholder. End-to-end verification: two browser tabs see each other move smoothly.

### Task 5.1: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

````markdown
# monkey-punch

3D online co-op bullet-heaven. Server-authoritative, ~10 players per room, joined by 4-character code.

## Status

Foundation only. No gameplay yet — see [docs/superpowers/specs/](docs/superpowers/specs/) for the design.

## Stack

- pnpm workspaces + TypeScript strict
- Server: Colyseus on Node 20
- Client: Vite + React + React Three Fiber + drei
- Shared: pure TS (Colyseus schemas, message types, deterministic rules, mulberry32 PRNG)

## Requirements

- Node ≥ 20.11 (`nvm use` reads `.nvmrc`)
- pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`)

## Quickstart

```bash
pnpm install
pnpm dev
```

This runs the Colyseus server on `ws://localhost:2567` and the Vite client on `http://localhost:5173` in parallel.

Open the client in two browser tabs:
1. Tab A: enter a name, click **create room**. The banner shows a 4-character code.
2. Tab B: enter a name, paste the code, click **join**.
3. Move with **W A S D**. Each tab sees its own cube and the other player's cube.

## Scripts

- `pnpm dev` — server + client in parallel (no build step needed).
- `pnpm build` — `tsc -b` everywhere; client is built by Vite.
- `pnpm test` — Vitest in `packages/shared` and `packages/server`.
- `pnpm typecheck` — `tsc -b` over the whole solution.

## Layout

```
packages/
├── shared/   # @mp/shared — schemas, messages, rules, rng. Pure TS.
├── server/   # @mp/server — Colyseus bootstrap, GameRoom, joinCode.
└── client/   # @mp/client — Vite + R3F app.
```

See [CLAUDE.md](CLAUDE.md) for the binding architectural rules.

## Deployment

Not deployed. Target is Fly.io for the server. The included [Dockerfile](Dockerfile) is a placeholder for that work.
````

### Task 5.2: Dockerfile placeholder

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
# Placeholder multi-stage build for the Colyseus server. Not exercised this session.

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile --filter @mp/shared --filter @mp/server

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN pnpm --filter @mp/server run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY --from=build /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist

RUN pnpm install --prod --frozen-lockfile --filter @mp/shared --filter @mp/server

ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567
CMD ["node", "packages/server/dist/index.js"]
```

### Task 5.3: Commit Chunk 5 docs

- [ ] **Step 1: Commit README + Dockerfile**

```bash
git add README.md Dockerfile
git commit -m "$(cat <<'EOF'
chore: README + Dockerfile placeholder

README documents the dev workflow and architecture entry points.
Dockerfile is a multi-stage placeholder (node:20-alpine, pnpm,
shared+server build). Not exercised this session.
EOF
)"
```

### Task 5.4: End-to-end verification

This is the acceptance test for the whole scaffold. Do not consider the plan complete until every step here passes.

- [ ] **Step 1: Clean install from a fresh shell**

```bash
rm -rf node_modules packages/*/node_modules packages/*/dist
pnpm install
```

Expected: pnpm completes without errors. Workspace symlinks present at `packages/server/node_modules/@mp/shared` and `packages/client/node_modules/@mp/shared`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0. No errors from `tsc -b`.

- [ ] **Step 3: Tests**

Run: `pnpm test`
Expected: 4 server tests + 7 shared tests pass (4 `tickPlayers` + 3 `mulberry32`). 11 total.

- [ ] **Step 4: Start `pnpm dev`**

Run in terminal A: `pnpm dev`
Expected: within ~5 seconds, the server logs `[server] listening on ws://localhost:2567` and Vite logs `Local: http://localhost:5173`. Both stay running.

- [ ] **Step 5: Two-tab join test**

In a browser:
1. Open `http://localhost:5173` in Tab A. Enter name "A". Click **create room**. The banner shows a 4-character code (e.g. `H7K2`). One cube renders at the origin.
2. Open `http://localhost:5173` in Tab B. Enter name "B". Type the code from Tab A. Click **join**. Both tabs now show two cubes.
3. In Tab A: hold **W**. Tab A's cube moves smoothly. In Tab B: the other cube moves smoothly with no perceptible teleporting.
4. In Tab A: release **W**. Tab A's cube stops cleanly. Tab B sees the cube settle without overshoot (we do not extrapolate).
5. In Tab B: hold **D**. Tab B's cube moves; Tab A sees it move.
6. Close Tab B. Tab A sees its cube disappear (player removed on disconnect).

- [ ] **Step 6: Stop dev**

Stop `pnpm dev` with Ctrl+C in terminal A. Both processes exit cleanly.

- [ ] **Step 7: Final sanity build**

Run: `pnpm build`
Expected: builds shared (`packages/shared/dist`), server (`packages/server/dist`), and client (`packages/client/dist`). No errors.

- [ ] **Step 8: Verify git state**

Run: `git status`
Expected: clean (or shows only untracked artifacts like `dist/`, `.tsbuildinfo`, `node_modules/` — all of which `.gitignore` should already exclude).

If everything above passes, the scaffold is done. Stop here, per the user's instruction.

---

## Self-Review

Spec coverage check (each spec section → task that implements it):

- Goal: monorepo + Colyseus 20Hz + R3F client + 4-char code + WASD + interpolation + 2-tab verify → Chunks 1–5, verified in Task 5.4.
- Non-goals: no gameplay, no physics, no auth, no DB, no styling beyond minimum, no lint → respected (no tasks for any of these).
- Stack & versions: Node 20, pnpm 9, TS 5.4, Colyseus ^0.16, schema ^3, Vite 5, React 18, R3F 8, drei 9 → pinned in Tasks 1.1, 2.1, 3.1, 4.1.
- Architectural rules → Task 1.6 writes `CLAUDE.md` containing all 9 rules + the "things NOT to do" section.
- Repo layout → matches Tasks 2–4 file paths.
- TS wiring (`tsconfig.base.json`, solution refs, composite shared, paths alias) → Tasks 1.3, 1.4, 2.2, 3.2, 4.2.
- Vite alias → Task 4.3 (with the `@mp/shared` naming refinement called out at the top).
- `shared/schema.ts` (Vec2, Player, Enemy, RoomState with code/seed/tick) → Task 2.5, exact code from spec.
- `shared/messages.ts` (InputMessage, ClientMessage union, MessageType const) → Task 2.6, exact code from spec.
- `shared/rules.ts` (PLAYER_SPEED, tickPlayers) → Task 2.7, exact code from spec.
- `shared/rng.ts` (mulberry32) → Task 2.4, exact code from spec.
- `server/joinCode.ts` (4-char, unambiguous alphabet, RNG-injectable) → Task 3.4.
- `server/GameRoom.ts` (onCreate sets metadata + state.code, seed, simulation interval; input handler with finite-check + length-clamp; onJoin with 24-char name truncation; onLeave deletes) → Task 3.5.
- `server/index.ts` (Server, define + filterBy, listen) → Task 3.6.
- `client/net/client.ts` (singleton Client, createRoom, joinRoom — using `client.join`, NOT `joinById`) → Task 4.6.
- `client/net/snapshots.ts` (ring buffer, INTERP_DELAY = 100ms, no extrapolation per rule 9) → Task 4.7.
- `client/Landing.tsx` (name input, Create / Join, inline error) → Task 4.12.
- `client/game/GameView.tsx` (Canvas, Ground, PlayerCube per player, room-code banner) → Task 4.11.
- `client/game/PlayerCube.tsx` (interpolated position, deterministic color) → Task 4.10.
- `client/game/input.ts` (WASD listener, normalize, dedupe, 200ms heartbeat) → Task 4.8.
- Dockerfile placeholder (multi-stage, node:20-alpine) → Task 5.2.
- Verification (clean install, typecheck, test, dev, two-tab manual test) → Task 5.4.
- Commit plan (5 chunked commits) → one commit step per chunk.

Placeholder scan: no TBDs, no "implement appropriately", every code step contains the actual code.

Type consistency check:
- `RoomState` fields used in `tickPlayers` (Task 2.7), `GameRoom` (Task 3.5), `GameView` (Task 4.11), and `client.ts` (Task 4.6) are all consistent.
- `InputMessage` shape (`{ type: "input", dir: { x, z } }`) matches between `messages.ts` (2.6), server input handler (3.5), and client `attachInput` (4.8).
- `SnapshotBuffer.sample()` (4.7) returns `{ x, z } | null`; consumers in `PlayerCube` (4.10) handle the null case.
- `joinCode` API: `generateJoinCode(rng?)` and `JOIN_CODE_ALPHABET` exported from 3.4, used in test (3.4) and `GameRoom` (3.5).
- `attachInput(room)` returns a teardown function (4.8); `GameView` calls it in cleanup (4.11).

No issues found.
