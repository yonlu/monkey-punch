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

## Manual smoke test (M2 sync invariants)

After any non-trivial sync change, run through these in two browser tabs.

1. `pnpm dev`, open two tabs at `http://localhost:5173`. Create in tab A;
   join with the displayed code in tab B.
2. Move both cubes with WASD. Throttle the network in DevTools to "Fast
   3G" in one tab. Confirm the remote cube still moves smoothly (no
   jitter, no rubber-banding) and the local cube remains responsive.
3. Press `F3` in either tab. The debug HUD appears top-right with
   `ping`, `server tick`, `snapshots`, `interp`, `players`, `recon err`.
   In steady state `recon err` should be ≈ 0; brief spikes after a
   network blip should recover within a few ticks.
4. Open a third tab and join. The two existing tabs should see the new
   cube appear without any flicker on existing cubes.
5. Kill the dev server with the two tabs still connected. Both tabs
   should show `Reconnecting…` then `Disconnected — Rejoin?`. Click
   `Rejoin` and confirm Landing pre-fills the name and code and a
   fresh join works.
