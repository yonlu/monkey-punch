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
