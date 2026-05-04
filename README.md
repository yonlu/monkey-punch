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

## Manual perf test (M3)

Run on 2026-05-04, M2 MacBook Pro, two connected Chrome tabs.

| Enemies | Client FPS | Server tick | Full-state bytes | Draw calls |
|--------:|-----------:|------------:|-----------------:|-----------:|
| 0       | 60         | 20Hz        | 192              | 3          |
| ~210    | 60         | 20Hz        | 6,776            | 4          |
| 300     | 60         | 20Hz        | 9,944            | 4          |

Notes:

- Full-state size scales linearly at ~32 bytes per enemy; 300 enemies = 9.9 KB,
  well under the 50 KB stop threshold from the M3 spec.
- Per-tick patch size logs as `n/a` because Colyseus 0.16's `broadcastPatch()`
  returns a boolean (`hasChanges`) rather than the encoded buffer, so the
  byte-counting hook can't sample. The `[room XXXX] patch instrumentation
  produced no measurable bytes` warn fires once per room. Full-state numbers
  are the reliable signal at this stage.
- Draw calls are constant at 4 with any non-zero enemy count: 1 ground + 2
  player cubes + 1 InstancedMesh (regardless of how many cones it draws).
  This is the empirical confirmation that instanced rendering is doing its
  job — the architecture would have to change before draw calls grew.
- FPS held at 60 in both tabs across all measurements; never observed below
  60. No GC stutter visible in DevTools Performance tab.
- Cross-client determinism verified: each enemy at the same world position
  in both tabs (same seeded RNG, server-only spawning).
- Reconnect mid-spawn verified: tab A dropped to Offline for ~5s with ~100
  enemies on screen, restored cleanly with no duplicates and same enemy ids
  as tab B.
