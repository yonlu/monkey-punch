# Milestone 2: Sync Polish and Multi-Player Foundation — Design

**Date**: 2026-05-04
**Status**: Approved (awaiting written-spec review)
**Scope**: Sync layer hardening only. No gameplay. After this milestone the
sync model is frozen — gameplay PRs depend on it being predictable.

## Goal

Make the multiplayer sync feel correct under typical LAN/WiFi latency, before
any gameplay lands. Specifically:

1. Remote players move smoothly (no jitter, no rubber-banding) under
   throttled network.
2. The local player feels responsive — movement starts on keypress with no
   perceptible delay, even on throttled network — via client-side prediction
   with server reconciliation.
3. Players joining and leaving mid-session don't cause flicker, snap, or
   stale ghosts.
4. A dropped WebSocket can be reconnected within 30s and resume controlling
   the same `Player`.
5. A debug HUD on the client (toggled with F3) shows ping (RTT), observed
   server snapshot rate, interpolation delay, player count, and the local
   player's reconciliation error per tick.

Nothing else. This milestone freezes the sync model; gameplay PRs build on it.

## Non-Goals

- Gameplay of any kind: enemies, weapons, projectiles, XP, waves.
- Lag compensation, anti-cheat, prediction smoothing tricks beyond the basic
  Gaffer-on-Games loop.
- Extrapolation past the last received snapshot for any player.
- Persistence of identity beyond a single in-memory session: no
  `localStorage`, no cross-tab session sharing, no account/auth.
- Tab refresh recovery (Cmd+R loses the session — see Architectural Decision 2).
- Custom serialization. Colyseus schema patches as-is.
- Physics engine. Movement remains `inputDir * speed * dt`.
- Refactors to `rules.ts` beyond the schema additions and the fixed-dt change.

## Architectural Decisions

These resolve open questions the goal description doesn't pin down. Each is
small but affects implementation correctness.

**AD1: Server tick uses fixed `dt = 0.05`s, not wall-clock dt.**
Today `GameRoom.tick` calls `tickPlayers(state, dtMs / 1000)` where `dtMs` is
the `setSimulationInterval` callback's wall-clock delta. For reconciliation
to converge to zero error in steady state, the client must apply the *exact*
same per-input displacement the server applied. Using a fixed `0.05` on both
sides gives bit-identical results; using wall-clock `dt` produces a small,
permanent, noisy reconciliation error. The cost — simulated time can fall
behind wall time during a GC pause — is invisible at this scale, and
`setSimulationInterval` continues firing on schedule once the pause is over.

**AD2: Reconnection token is in-memory only.**
On successful join the client stores `room.reconnectionToken` in React
component state. If the WebSocket drops, the client calls
`colyseusClient.reconnect(token)` to resume. A hard tab refresh loses the
token and falls back to the rejoin-with-prefilled-code path. We deliberately
do not persist the token to `sessionStorage` — the spec phrasing
("WebSocket drops") frames this as in-session resilience, not refresh
recovery. Adding `sessionStorage` is ~10 lines later if it's actually wanted.

**AD3: Disconnect UX is two-phase.**
- `Reconnecting…` overlay: shown immediately on unexpected `room.onLeave`.
  Spinner + auto-attempt of `colyseusClient.reconnect(token)`.
- `Disconnected — Rejoin?` overlay: shown on reconnect failure or grace
  expiry. A single button routes back to `Landing` with the saved name and
  code pre-filled.

The two-phase split makes the user state visible and disambiguates
"transient network blip" from "session is gone".

**AD4: Ping uses a dedicated `ping`/`pong` message pair, 1Hz.**
Client sends `{type:"ping", t: Date.now()}` once per second. Server echoes
via `client.send("pong", { t: msg.t })`. Client computes `RTT = Date.now() - t`
on the response and EWMA-smooths into the HUD. Piggybacking on `input` or
on `state` arrival is unreliable: input is fire-and-forget (no response),
and state diffs aren't 1:1 with any client message. Adding one
`ClientMessage` variant is cheap and clean.

**AD5: Identity across reconnect is the Colyseus `sessionId`.**
This is what `allowReconnection(client, 30)` already preserves — when a
client reconnects within the grace window, the same `Client` object (same
`sessionId`) is rebound to the room and the existing `Player` schema entry
is reused. No separate stable player ID is introduced. After grace expiry,
the player is deleted and a fresh rejoin gets a new `sessionId` and a new
`Player`. This is consistent with CLAUDE.md rule 7. CLAUDE.md gets a
clarifying note (see "CLAUDE.md update" below).

## Schema Changes (`packages/shared/src/schema.ts`)

One field added to `Player`. `RoomState.tick` already exists from M1.

```ts
export class Player extends Schema {
  declare sessionId: string;
  declare name: string;
  declare x: number;
  declare y: number;
  declare z: number;
  declare inputDir: Vec2;
  declare lastProcessedInput: number;     // NEW
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.inputDir = new Vec2();
    this.lastProcessedInput = 0;          // NEW
  }
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  x: "number",
  y: "number",
  z: "number",
  inputDir: Vec2,
  lastProcessedInput: "uint32",           // NEW
});
```

The `declare` + constructor-body pattern is required (see the schema
landmines memory). The 19-line banner stays.

## Message Changes (`packages/shared/src/messages.ts`)

`InputMessage` gains `seq: number`. A new `PingMessage` is added to the
union.

```ts
export type InputMessage = {
  type: "input";
  seq: number;                            // monotonic per client
  dir: { x: number; z: number };
};

export type PingMessage = {
  type: "ping";
  t: number;                              // client wall-clock millis
};

export type ClientMessage = InputMessage | PingMessage;

// Server→client one-shot (not a ClientMessage; not governed by rule 3).
// Documented here for grep-ability:
//   pong: { t: number }   // echoed from PingMessage.t

export const MessageType = {
  Input: "input",
  Ping: "ping",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
```

## Server Changes (`packages/server/src/GameRoom.ts`)

Four changes.

**1. Fixed-dt simulation.** Replace `tickPlayers(state, dtMs / 1000)` with
a fixed `0.05`s step. Define a constant `SIM_DT_S = TICK_INTERVAL_MS / 1000`
to keep the relationship explicit.

**2. Input handler validates `seq` and updates `lastProcessedInput`.**
Drop messages with `seq <= player.lastProcessedInput` (replayed/stale).
Otherwise clamp the direction (existing `clampDirection`), set `inputDir`,
and set `lastProcessedInput = msg.seq`.

**3. Ping handler.** New `onMessage<PingMessage>("ping", …)` echoes
`client.send("pong", { t: msg.t })`.

**4. Reconnection in `onLeave`.**

```ts
override async onLeave(client: Client, consented: boolean): Promise<void> {
  const player = this.state.players.get(client.sessionId);
  if (!player) return;

  // Stop drift during the grace window — last-known inputDir would otherwise
  // keep being integrated each tick.
  player.inputDir.x = 0;
  player.inputDir.z = 0;

  if (consented) {
    this.state.players.delete(client.sessionId);
    return;
  }

  try {
    const graceS = Number(process.env.MP_RECONNECTION_GRACE_S ?? 30);
    await this.allowReconnection(client, graceS);
    // Reconnected. Same sessionId, same Player schema. Nothing to do —
    // the rebound client will resume sending inputs.
  } catch {
    // Grace expired or rebind failed.
    this.state.players.delete(client.sessionId);
  }
}
```

No other handler changes. `tickPlayers` and `clampDirection` are unchanged.

## Client Changes

### Net layer (`packages/client/src/net/`)

**`prediction.ts` (new).** Owns the local player's predicted state:

- A monotonic `seq` counter (starts at 1).
- An `unackedInputs: Array<{ seq: number; dir: { x:number; z:number } }>`.
- `predictedX`, `predictedZ` numbers.
- `lastReconErr: number` for the HUD.

Two methods on a `LocalPredictor` class:
- `step(dir, sendFn)`: called by the 20Hz client tick. Increments `seq`,
  pushes `{seq, dir}` to `unackedInputs`, advances `predictedX/Z` by
  `dir * PLAYER_SPEED * 0.05`, calls `sendFn({type:"input", seq, dir})`.
- `reconcile(serverX, serverZ, lastProcessedInput)`: drops acked inputs from
  `unackedInputs`, recomputes `predictedX/Z` from `(serverX, serverZ)` plus
  the remaining queue, records `lastReconErr` as the L2 distance between
  the new predicted and the predicted value before reconciliation.

`PLAYER_SPEED` is imported from `@mp/shared` so client and server agree.

**`hudState.ts` (new).** A small mutable object:
```ts
export const hudState = {
  pingMs: 0,
  serverTick: 0,
  snapshotsPerSec: 0,
  interpDelayMs: 100,
  playerCount: 0,
  reconErr: 0,
  visible: false,
};
```
Mutated in place by network code; read each frame by `DebugHud`. No React
state — keeps the render path off the hot loop.

**`snapshots.ts` (existing).** Bump ring buffer from 4 to 5. No other change;
behavior is already correct.

### Game layer (`packages/client/src/game/`)

**`GameView.tsx` (existing, modified).**

- On mount, instantiate `LocalPredictor`. Pass it down to `attachInput`.
- Subscribe to local-player `onChange` separately from remote-player
  `onChange`: when the local player changes, call
  `predictor.reconcile(player.x, player.z, player.lastProcessedInput)`
  and update `hudState.reconErr`.
- Use `$(state).listen("tick", …)` to update `hudState.serverTick` and
  bump a rolling snapshots-per-second counter on each tick change.
- Mount `DebugHud` overlay. Add a global `keydown` listener for `F3` that
  toggles `hudState.visible`.
- Receive an `onUnexpectedLeave` callback from `App` as a prop. Register
  `room.onLeave((closeCode) => { if (closeCode !== 1000) onUnexpectedLeave(); })`
  so the phase transition lives in `App` while GameView only signals.

**`PlayerCube.tsx` (existing, modified).** Take an optional `predictor`
prop. If present (i.e. this is the local player), read `predictor.predictedX`
/ `predictor.predictedZ` in `useFrame` instead of sampling the snapshot
buffer. The remote-player path is unchanged.

**`input.ts` (existing, rewritten).** Replace the send-on-change +
heartbeat loop with a 20Hz fixed-step loop driven by `setInterval(50)`.
Each step:
1. Read the current direction from key state.
2. Call `predictor.step(dir, room.send.bind(room, "input"))`.

The interval is the only sender. There is no separate heartbeat. Direction
is computed from the same `KEYS` map as today.

### App layer (`packages/client/src/App.tsx`)

Add a phase machine:

```ts
type Phase =
  | { kind: "landing" }
  | { kind: "playing"; room: Room<RoomState>; code: string; name: string; token: string }
  | { kind: "reconnecting"; code: string; name: string; token: string }
  | { kind: "disconnected"; code: string; name: string };
```

Transitions:
- `landing → playing`: on successful create/join. Save token + code + name.
- `playing → reconnecting`: on unexpected `room.onLeave`. Trigger
  `colyseusClient.reconnect(token)` immediately.
- `reconnecting → playing`: on successful `reconnect()`. New `Room` object;
  GameView re-mounts. Predictor is freshly constructed; first server snapshot
  snaps the predicted position.
- `reconnecting → disconnected`: on `reconnect()` rejection or 30s timeout.
- `disconnected → landing`: on click of "Rejoin"; the Landing form receives
  pre-filled name and code via props.

`Landing.tsx` accepts optional `initialName` and `initialCode` props. If
given, it auto-populates the inputs.

### Debug HUD (`packages/client/src/game/DebugHud.tsx`, new)

Fixed-position top-right `<div>`, hidden by default. Toggled by F3. Reads
`hudState` once per `requestAnimationFrame`, displays:

```
ping       42 ms
server tick 1234
snapshots  19.8 / s
interp     100 ms
players    3
recon err  0.012 u
```

Monospace font, solid background, no styling beyond legibility. The
component is unmounted (or `display: none`) when `hudState.visible` is
false.

## CLAUDE.md Update

Two edits.

**Rule 9 — replace** the "(no client prediction yet)" parenthetical:

> 9. **Tickrate.** Server simulates at 20Hz with a fixed `dt` of `0.05`s.
>    The client renders at 60fps and interpolates remote players between the
>    two most recent server snapshots (≈100ms behind newest). The local
>    player runs client-side prediction at 20Hz and reconciles with the
>    server on each snapshot: unacknowledged inputs (those with `seq >
>    Player.lastProcessedInput`) are re-applied to the server's authoritative
>    position to produce the predicted current frame.

**Rule 7 — append** a clarifying sentence:

> 7. **No identity beyond Colyseus sessionId.** … Reconnection within a 30s
>    grace window preserves the same sessionId; clients that reconnect after
>    the window get a new sessionId and a fresh `Player`. There is no
>    cross-tab or cross-room identity.

## Tests

Two new server-side integration tests, plus the existing M1 integration test
must continue to pass.

**`packages/server/test/sync.test.ts` (new).** Spins up a real Colyseus
server. Connects two `colyseus.js` clients. Both send a stream of `input`
messages with monotonic `seq`. Asserts:
- Both `Player` records show `lastProcessedInput` equal to the highest
  `seq` each client sent.
- Each `Player.x`, `z` matches the expected position from
  `n_inputs * PLAYER_SPEED * 0.05` for their direction (within
  floating-point tolerance).
- `RoomState.tick` advances monotonically and is non-decreasing across
  observed patches.
- An out-of-order or replayed `seq` is dropped (no movement on a duplicate
  send).

**`packages/server/test/reconnect.test.ts` (new).** Spins up the same in-
process server. Client A creates a room and sends a few inputs. The
underlying WebSocket is closed mid-session (force-close, not graceful
leave). Within the 30s grace window, the client calls
`colyseusClient.reconnect(reconnectionToken)`. Asserts:
- `room.state.players` still contains exactly one entry, keyed by the
  original `sessionId`.
- The `Player`'s `x`, `z`, and `lastProcessedInput` are preserved.
- After reconnect, sending a new input with the next `seq` advances the
  player as normal.

A second case in the same file: same setup, but the client does not
reconnect within the grace window; assert the `Player` entry is gone after
the grace expires. To keep the test fast, `GameRoom` reads its grace value
from `process.env.MP_RECONNECTION_GRACE_S` (default `30`); the test sets
it to `1` via `vi.stubEnv` before construction. Production runs with the
default unchanged.

**Manual smoke test (README).** Add a section explaining:
1. Open two tabs, create + join, move both around. Visually confirm
   smooth motion, then throttle DevTools network to "Fast 3G" and confirm
   remote motion remains smooth and local motion remains responsive.
2. Press F3 in either tab — confirm HUD appears with the listed metrics.
3. Kill `pnpm dev` server. Both tabs should show `Reconnecting…` then
   `Disconnected — Rejoin?`. Restart server, click Rejoin, verify rejoin
   succeeds via the prefilled code.
4. Open a third tab, join. Existing tabs see the new cube appear without
   any flicker on existing cubes.

## Verification Gates

The milestone is complete only when **all** of these pass:

1. `pnpm typecheck` — clean.
2. `pnpm test` — all Vitest suites green, including the two new server tests
   and the existing M1 integration test.
3. Two-tab manual smoke test (above): visually smooth, responsive, no
   flicker on join, HUD readable.
4. Throttled-network smoke (DevTools Fast 3G): `recon err` in HUD is near
   zero in steady state and recovers within a few ticks after a packet
   blip; remote cube motion has no visible jitter.
5. Server-restart smoke: kill + restart server with two clients connected;
   both show `Reconnecting…` → `Disconnected — Rejoin?` → successful rejoin
   with prefilled code.

## Commit Plan

Follows the project's chunked-commits rhythm. Each chunk is independently
reviewable.

1. `feat(shared): add Player.lastProcessedInput, InputMessage.seq, PingMessage`
   — schema + messages + tests in shared (no behavior change yet).
2. `feat(server): fixed-dt sim, seq validation, ping handler`
   — `GameRoom` simulation tick uses `SIM_DT_S`, input handler reads/sets
   `lastProcessedInput`, ping echoes pong.
3. `feat(server): reconnection grace via allowReconnection(30)`
   — `onLeave` zeroes inputDir then awaits reconnect; new
   `reconnect.test.ts`.
4. `test(server): seq + reconciliation integration test`
   — `sync.test.ts` (covers seq drop, monotonic tick, expected positions).
5. `feat(client): LocalPredictor + hudState + snapshot ring=5`
   — net-layer additions, no UI yet.
6. `feat(client): 20Hz fixed-step input loop + local prediction render`
   — `input.ts` rewrite, `PlayerCube` reads predictor when local.
7. `feat(client): debug HUD with F3 toggle`
   — `DebugHud.tsx`, F3 listener, ping/pong wiring.
8. `feat(client): reconnection phase machine + Disconnected UI`
   — App phase state, Reconnecting/Disconnected overlays, Landing prefill.
9. `docs: update CLAUDE.md (rule 9, rule 7) and README smoke test`
   — final doc sync.

Each commit message multi-line, explains *why* not just *what*, per the
project's commit conventions.
