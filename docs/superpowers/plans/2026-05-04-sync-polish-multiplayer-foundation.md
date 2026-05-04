# Milestone 2: Sync Polish & Multi-Player Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the sync layer with smooth interpolation, client-side prediction + server reconciliation, graceful join/leave, 30s reconnect grace, and a debug HUD — without adding any gameplay.

**Architecture:** Server uses a fixed `dt = 0.05`s per simulation tick. Each client `input` message carries a monotonic `seq`; the server stamps `Player.lastProcessedInput` so the client can re-apply unacknowledged inputs after a snapshot. Reconnection uses Colyseus's built-in `allowReconnection`. The local player is rendered from a `LocalPredictor`; remote players continue to use the existing `SnapshotBuffer` (interp delay 100 ms, no extrapolation). A debug HUD reads from a mutable `hudState` written by network code and rendered each frame.

**Tech Stack:** TypeScript strict, pnpm workspaces, Colyseus 0.16 + `@colyseus/schema` 3.x (server + shared), Vite + React 18 + R3F + drei + colyseus.js 0.16 (client), Vitest (server + shared).

**Reference:** [docs/superpowers/specs/2026-05-04-sync-polish-design.md](../specs/2026-05-04-sync-polish-design.md). The architectural decisions (AD1–AD5) and CLAUDE.md edits are defined there; this plan is the executable form.

**Repo conventions to respect (project-specific):**

1. **Schema fields use `declare` + constructor-body assignment.** Class-field initializers break the encoder under `tsx`/Vite. The 19-line banner in `schema.ts` explains why — keep it.
2. **All client→server messages live in `shared/messages.ts` as a discriminated union.**
3. **Game logic stays in `shared/rules.ts` as pure `(state, dt, rng) => void` functions.** Room handlers are thin.
4. **Commits are chunked, never squashed.** Multi-line messages explain *why*, not just *what*. Each task in this plan ends in one commit.
5. **Use the existing `Encoder` regression test pattern in `shared/test/schema.test.ts`** for any schema change — that test catches encoder breakage that unit tests miss.

---

## File Structure

**Created:**
- `packages/server/test/sync.test.ts` — integration test for fixed-dt + seq validation + ping/pong.
- `packages/server/test/reconnect.test.ts` — integration test for `allowReconnection` happy path + grace expiry.
- `packages/client/src/net/prediction.ts` — `LocalPredictor` class (predicts local-player position, reconciles against server snapshots).
- `packages/client/src/net/hudState.ts` — mutable singleton read by the debug HUD.
- `packages/client/src/game/DebugHud.tsx` — fixed-position overlay rendered on F3 toggle.

**Modified:**
- `packages/shared/src/schema.ts` — add `Player.lastProcessedInput: uint32`.
- `packages/shared/src/messages.ts` — add `seq` to `InputMessage`; add `PingMessage`; expand `ClientMessage`/`MessageType`.
- `packages/shared/test/schema.test.ts` — assert `lastProcessedInput` defaults + encodes.
- `packages/server/src/GameRoom.ts` — fixed `SIM_DT_S`, seq validation in input handler, ping handler, async `onLeave` with `allowReconnection`.
- `packages/client/src/net/snapshots.ts` — bump ring buffer 4 → 5.
- `packages/client/src/game/input.ts` — replace send-on-change with 20 Hz fixed-step loop driven by `LocalPredictor`.
- `packages/client/src/game/PlayerCube.tsx` — accept optional `predictor`; render predicted position when present.
- `packages/client/src/game/GameView.tsx` — instantiate `LocalPredictor`, wire reconcile-on-change for the local player, listen on `state.tick`, mount `DebugHud`, signal unexpected leave to App.
- `packages/client/src/App.tsx` — phase machine: `landing` / `playing` / `reconnecting` / `disconnected`.
- `packages/client/src/Landing.tsx` — accept `initialName` and `initialCode` props.
- `packages/client/src/net/client.ts` — wait for `state.code` to populate before resolving create/join.
- `CLAUDE.md` — rewrite rule 9, append a sentence to rule 7.
- `README.md` — append a manual smoke-test section.

---

## Task 1: Add `Player.lastProcessedInput` to the schema

**Why:** Server stamps the highest accepted input `seq` per player so the client can drop acked inputs from its unacked queue. `RoomState.tick` already exists from M1 — only this one field is new.

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Test: `packages/shared/test/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append two cases to `packages/shared/test/schema.test.ts` inside the existing `describe(...)` block (or in a new `describe` for `Player.lastProcessedInput`):

```ts
  it("Player.lastProcessedInput defaults to 0", () => {
    const p = new Player();
    expect(p.lastProcessedInput).toBe(0);
  });

  it("encodes Player.lastProcessedInput as uint32 without throwing", () => {
    const state = new RoomState();
    const p = new Player();
    p.sessionId = "abc";
    p.lastProcessedInput = 42;
    state.players.set(p.sessionId, p);

    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });
```

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter @mp/shared test
```

Expected: the two new cases fail (`expect(p.lastProcessedInput).toBe(0)` → `undefined`; encoder may also throw).

- [ ] **Step 3: Add the field to `Player`**

In `packages/shared/src/schema.ts`, modify the `Player` class. Keep the encoder-safety pattern: `declare`, then assign in the constructor body, then list in `defineTypes`. Do not introduce class-field initializers.

```ts
export class Player extends Schema {
  declare sessionId: string;
  declare name: string;
  declare x: number;
  declare y: number;
  declare z: number;
  declare inputDir: Vec2;
  declare lastProcessedInput: number;
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.inputDir = new Vec2();
    this.lastProcessedInput = 0;
  }
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  x: "number",
  y: "number",
  z: "number",
  inputDir: Vec2,
  lastProcessedInput: "uint32",
});
```

- [ ] **Step 4: Run tests, verify they pass**

```
pnpm --filter @mp/shared test
```

Expected: all schema tests green, including the two new cases.

- [ ] **Step 5: Typecheck the workspace**

```
pnpm typecheck
```

Expected: clean. (Server reads `player.lastProcessedInput` later — if any consumer was added prematurely, surface it now.)

- [ ] **Step 6: Commit**

```
git add packages/shared/src/schema.ts packages/shared/test/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add Player.lastProcessedInput uint32

Server will stamp this with the highest accepted input seq per player so
the client can drop acked entries from its unacked-input queue during
reconciliation. Defaults to 0; encoded as uint32 because seqs are
monotonically increasing and capped at ~4B per session — way more than
a real session will ever produce.

Field uses declare + constructor-body assignment per the schema landmine
banner; do not regress to class-field initializers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `seq` to `InputMessage` and a new `PingMessage`

**Why:** Clients tag every input with a monotonic seq (basis for reconciliation) and send 1 Hz pings to measure RTT.

**Files:**
- Modify: `packages/shared/src/messages.ts`

- [ ] **Step 1: Update the messages file**

Replace `packages/shared/src/messages.ts` contents with:

```ts
export type InputMessage = {
  type: "input";
  seq: number;
  dir: { x: number; z: number };
};

export type PingMessage = {
  type: "ping";
  t: number;
};

export type ClientMessage = InputMessage | PingMessage;

// Server→client one-shot, NOT a ClientMessage variant (rule 3 governs
// client→server only). Documented here so a grep on this file finds the
// shape:
//   pong: { t: number }   // echoed from PingMessage.t
export type PongMessage = {
  type: "pong";
  t: number;
};

export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
```

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: shared compiles cleanly. Server (`GameRoom.ts`) currently destructures only `dir` from incoming `InputMessage`; adding the `seq` field is additive and does not break the existing handler.

- [ ] **Step 3: Run shared tests**

```
pnpm --filter @mp/shared test
```

Expected: all green (no behavioral change yet).

- [ ] **Step 4: Commit**

```
git add packages/shared/src/messages.ts
git commit -m "$(cat <<'EOF'
feat(shared): add InputMessage.seq and PingMessage

InputMessage gains a monotonic per-client seq so the server can stamp
Player.lastProcessedInput and the client can drop acked inputs from its
unacked queue during reconciliation.

PingMessage is the new client→server half of a 1Hz RTT probe; the
server replies via client.send("pong", { t }) using the echoed t. Pong
is server→client and therefore not a ClientMessage variant per rule 3,
but PongMessage is exported for client-side typing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server uses fixed `SIM_DT_S` per tick + validates input seq

**Why (AD1):** Reconciliation converges to zero error in steady state only if client and server apply *exactly* the same per-input displacement. Wall-clock dt from `setSimulationInterval` introduces noise; a fixed `0.05`s makes both sides bit-identical. **Why (seq):** drops out-of-order/replayed inputs and stamps `lastProcessedInput`.

**Files:**
- Modify: `packages/server/src/GameRoom.ts`
- Test: `packages/server/test/sync.test.ts` (NEW)

- [ ] **Step 1: Write the failing integration test**

Create `packages/server/test/sync.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "colyseus.js";
import { GameRoom } from "../src/GameRoom.js";
import { PLAYER_SPEED } from "@mp/shared";

const PORT = 2599; // distinct from integration.test.ts (2598) and dev (2567)

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

describe("integration: input seq + fixed-dt simulation", () => {
  it("server stamps lastProcessedInput and integrates motion at fixed dt", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Send a single input that sets dir = (1, 0) with seq=1.
    room.send("input", { type: "input", seq: 1, dir: { x: 1, z: 0 } });

    // Wait long enough for several simulation ticks (20 Hz → 50 ms each).
    // 500 ms ≈ 10 ticks → ~10 * PLAYER_SPEED * 0.05 units of motion.
    await new Promise((r) => setTimeout(r, 500));

    const me = room.state.players.get(room.sessionId)!;
    // Loose tolerance: timer slop + the first tick may not include the input.
    // Expected window: 7–11 ticks of motion.
    const min = 7 * PLAYER_SPEED * 0.05;
    const max = 11 * PLAYER_SPEED * 0.05;
    expect(me.x).toBeGreaterThan(min);
    expect(me.x).toBeLessThan(max);
    expect(me.lastProcessedInput).toBe(1);

    await room.leave();
  }, 5000);

  it("drops stale or replayed seqs", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Bob" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    room.send("input", { type: "input", seq: 5, dir: { x: 1, z: 0 } });
    await waitFor(
      () => room.state.players.get(room.sessionId)?.lastProcessedInput === 5,
      500,
    );

    // Stale (seq < current) and replay (seq == current) must both be dropped.
    room.send("input", { type: "input", seq: 3, dir: { x: -1, z: 0 } });
    room.send("input", { type: "input", seq: 5, dir: { x: 0, z: 1 } });
    await new Promise((r) => setTimeout(r, 100));

    const me = room.state.players.get(room.sessionId)!;
    expect(me.lastProcessedInput).toBe(5);
    expect(me.inputDir.x).toBe(1);
    expect(me.inputDir.z).toBe(0);

    await room.leave();
  }, 5000);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```
pnpm --filter @mp/server test sync.test.ts
```

Expected: failures. The first test fails because the server uses `dtMs/1000` (slightly off-by-noise) AND because the input handler does not currently set `lastProcessedInput` (so `expect(me.lastProcessedInput).toBe(1)` fails). The second test fails because no seq filtering exists.

- [ ] **Step 3: Implement fixed dt + seq validation in `GameRoom`**

Modify `packages/server/src/GameRoom.ts`. Replace the file contents with:

```ts
import { Room, Client } from "colyseus";
import { Player, RoomState, tickPlayers } from "@mp/shared";
import type { InputMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";

const TICK_INTERVAL_MS = 50;            // 20 Hz
const SIM_DT_S = TICK_INTERVAL_MS / 1000; // fixed 0.05s per tick — see AD1
const MAX_PLAYERS = 10;

type JoinOptions = {
  name?: string;
  code?: string;
};

export class GameRoom extends Room<RoomState> {
  override maxClients = MAX_PLAYERS;

  override async onCreate(_options: JoinOptions): Promise<void> {
    const state = new RoomState();
    const code = generateJoinCode();
    state.code = code;
    state.seed = (Math.random() * 0xffffffff) >>> 0;
    state.tick = 0;
    console.log(`[room ${code}] created seed=${state.seed}`);
    this.setState(state);

    this.listing.code = code;
    await this.setMetadata({ code });

    this.onMessage<InputMessage>("input", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const seq = Number(message?.seq);
      if (!Number.isFinite(seq) || seq <= player.lastProcessedInput) {
        // Stale or replayed input — drop silently.
        return;
      }

      const dir = clampDirection(Number(message?.dir?.x), Number(message?.dir?.z));
      player.inputDir.x = dir.x;
      player.inputDir.z = dir.z;
      player.lastProcessedInput = seq;
    });

    this.setSimulationInterval(() => this.tick(), TICK_INTERVAL_MS);
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

  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S);
  }
}
```

Two key changes:
1. `setSimulationInterval(() => this.tick(), …)` no longer passes wall-clock dt; `tick()` calls `tickPlayers(state, SIM_DT_S)`.
2. `onMessage<InputMessage>("input", …)` validates `seq` and stamps `player.lastProcessedInput` on accept.

(`onLeave` stays the same in this task; reconnection comes in Task 5.)

- [ ] **Step 4: Run sync.test.ts, verify it passes**

```
pnpm --filter @mp/server test sync.test.ts
```

Expected: both cases green.

- [ ] **Step 5: Run the full server suite, verify no regression**

```
pnpm --filter @mp/server test
```

Expected: all green, including the existing `integration.test.ts` from M1.

- [ ] **Step 6: Typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add packages/server/src/GameRoom.ts packages/server/test/sync.test.ts
git commit -m "$(cat <<'EOF'
feat(server): fixed 0.05s sim dt + input seq validation

Two coupled changes that together make client-side reconciliation
converge to zero error in steady state:

  1. setSimulationInterval drops wall-clock dt; tick() calls tickPlayers
     with SIM_DT_S = 0.05 (20 Hz). Wall-clock dt introduces small noise
     in per-tick displacement that makes the client's re-application of
     unacked inputs disagree with the server, leaving permanent recon
     error. Using a fixed dt makes both sides bit-identical (AD1).

  2. The "input" handler now reads message.seq, drops anything <= the
     player's lastProcessedInput (stale / replayed), and stamps
     lastProcessedInput on accept. This is what lets the client know
     which inputs the server has already integrated.

Adds a real-server integration test (sync.test.ts) on a separate port
that exercises both behaviors via colyseus.js. Existing M1 integration
test still passes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Server `ping` → `pong` echo

**Why (AD4):** RTT shown in the HUD needs a clean round-trip primitive. Piggybacking on input/state arrival is fragile. One handler, three lines.

**Files:**
- Modify: `packages/server/src/GameRoom.ts`
- Test: `packages/server/test/sync.test.ts` (extend)

- [ ] **Step 1: Add the failing test case**

Append to the existing `describe(...)` block in `packages/server/test/sync.test.ts`:

```ts
  it("echoes ping as pong with the original t", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Carol" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const echoed = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pong timeout")), 500);
      room.onMessage("pong", (msg: { t: number }) => {
        clearTimeout(timer);
        resolve(msg.t);
      });
      room.send("ping", { type: "ping", t: 12345 });
    });
    expect(echoed).toBe(12345);

    await room.leave();
  }, 5000);
```

- [ ] **Step 2: Run it, verify it fails**

```
pnpm --filter @mp/server test sync.test.ts
```

Expected: pong timeout (no handler exists).

- [ ] **Step 3: Add the handler in `GameRoom.onCreate`**

In `packages/server/src/GameRoom.ts`, also import `PingMessage` from `@mp/shared`:

```ts
import type { InputMessage, PingMessage } from "@mp/shared";
```

Add the handler block immediately after the existing `onMessage<InputMessage>("input", …)` registration:

```ts
    this.onMessage<PingMessage>("ping", (client, message) => {
      const t = Number(message?.t);
      if (!Number.isFinite(t)) return;
      client.send("pong", { type: "pong", t });
    });
```

- [ ] **Step 4: Run sync.test.ts, verify all green**

```
pnpm --filter @mp/server test sync.test.ts
```

Expected: all three cases pass.

- [ ] **Step 5: Commit**

```
git add packages/server/src/GameRoom.ts packages/server/test/sync.test.ts
git commit -m "$(cat <<'EOF'
feat(server): ping/pong echo for client RTT measurement

Adds onMessage<PingMessage>("ping", …) that echoes the client-supplied
timestamp back via client.send("pong", { t }). The client subtracts
its current time from the echoed t to compute RTT for the debug HUD
(AD4). One handler, no state, no per-room bookkeeping.

Pong is a server→client one-shot and is not part of ClientMessage; the
shape is documented in shared/messages.ts for grep-ability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Server reconnection grace via `allowReconnection`

**Why (AD5):** A dropped WebSocket should resume the same `Player` within 30 s. Colyseus preserves the same `sessionId` on `allowReconnection` rebind. The player's `inputDir` is zeroed before awaiting so a held-down WASD key doesn't keep integrating during the grace window.

**Files:**
- Modify: `packages/server/src/GameRoom.ts`
- Test: `packages/server/test/reconnect.test.ts` (NEW)

- [ ] **Step 1: Write the failing reconnection test**

Create `packages/server/test/reconnect.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "colyseus.js";
import { GameRoom } from "../src/GameRoom.js";

const PORT = 2600;

// Speed up grace expiry so the negative-path test runs in ~1s.
process.env.MP_RECONNECTION_GRACE_S = "1";

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

describe("integration: reconnection grace", () => {
  it("resumes the same Player within the grace window", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;
    const token = room.reconnectionToken;

    // Send a couple inputs so the player has non-zero state before disconnect.
    room.send("input", { type: "input", seq: 1, dir: { x: 1, z: 0 } });
    await waitFor(
      () => room.state.players.get(sessionId)?.lastProcessedInput === 1,
      500,
    );

    // Force a non-graceful disconnect by closing the underlying transport.
    // colyseus.js exposes the connection on room.connection.
    (room as any).connection.transport.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect within the (overridden 1s) grace window.
    const resumed = await client.reconnect<any>(token);
    await waitFor(() => resumed.state.code !== "" && resumed.state.code != null, 1000);

    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.state.players.size).toBe(1);
    const me = resumed.state.players.get(sessionId)!;
    expect(me.lastProcessedInput).toBe(1);

    // Subsequent inputs continue to advance lastProcessedInput.
    resumed.send("input", { type: "input", seq: 2, dir: { x: 0, z: 1 } });
    await waitFor(
      () => resumed.state.players.get(sessionId)?.lastProcessedInput === 2,
      500,
    );

    await resumed.leave();
  }, 5000);

  it("removes the Player when the grace window expires", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Bob" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;

    // Spin up a second client that stays connected, so we can observe the
    // server's view of room.state.players from a live room object.
    const observer = await client.join<any>("game", { code: room.state.code, name: "Observer" });
    await waitFor(() => observer.state.players.size === 2, 1000);

    // Force-close A's transport.
    (room as any).connection.transport.close();

    // Wait beyond the 1s grace.
    await waitFor(() => observer.state.players.size === 1, 3000);
    expect(observer.state.players.has(sessionId)).toBe(false);

    await observer.leave();
  }, 5000);
});
```

- [ ] **Step 2: Run it, verify failure**

```
pnpm --filter @mp/server test reconnect.test.ts
```

Expected: the happy-path test fails because `room.reconnectionToken` may exist but the current `onLeave` immediately deletes the player; `client.reconnect()` will throw or the rebound room will not contain the original session. The grace-expiry test may pass coincidentally (player is deleted on disconnect) — fine; we're tightening behavior anyway.

- [ ] **Step 3: Rewrite `onLeave` for grace + reconnection**

In `packages/server/src/GameRoom.ts`, replace the existing `onLeave`:

```ts
  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Stop drift while the client is gone — the last-known inputDir would
    // otherwise keep being integrated each tick.
    player.inputDir.x = 0;
    player.inputDir.z = 0;

    if (consented) {
      this.state.players.delete(client.sessionId);
      return;
    }

    try {
      const graceS = Number(process.env.MP_RECONNECTION_GRACE_S ?? 30);
      await this.allowReconnection(client, graceS);
      // Reconnected. Same sessionId, same Player schema. Nothing else to do.
    } catch {
      this.state.players.delete(client.sessionId);
    }
  }
```

- [ ] **Step 4: Run the reconnect tests, verify they pass**

```
pnpm --filter @mp/server test reconnect.test.ts
```

Expected: both cases green.

- [ ] **Step 5: Run the full server suite**

```
pnpm --filter @mp/server test
```

Expected: all green.

- [ ] **Step 6: Commit**

```
git add packages/server/src/GameRoom.ts packages/server/test/reconnect.test.ts
git commit -m "$(cat <<'EOF'
feat(server): 30s reconnection grace via allowReconnection

onLeave now zeroes the player's inputDir (so a held-down WASD key
doesn't drift them across the map during the grace window), then
awaits this.allowReconnection(client, 30) inside a try/catch. On
success, Colyseus rebinds the same sessionId to the existing Player
schema and the rebound client resumes sending inputs. On timeout or
rebind failure, the Player is deleted (AD5).

Grace duration is read from MP_RECONNECTION_GRACE_S env var (default
30) so reconnect.test.ts can override to 1s and run in ~1.5s instead
of ~31s. Production runs unchanged.

Adds reconnect.test.ts with two cases: happy-path resumption preserves
sessionId + lastProcessedInput, and grace expiry removes the Player as
observed from a second live client.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Client `LocalPredictor` (with unit tests)

**Why:** Encapsulates the local-player prediction state (monotonic seq, unacked queue, predicted x/z, recon error) and the two operations the network layer performs on it (`step` once per 20 Hz tick, `reconcile` on each authoritative snapshot). Pure logic — easy to unit-test without Colyseus.

**Files:**
- Create: `packages/client/src/net/prediction.ts`
- Create: `packages/client/src/net/prediction.test.ts`

> **Note on testing client code with Vitest:** The client package currently has no Vitest setup (verified — no `vitest.config.ts`, no `test` script, no `vitest` dependency). The predictor is pure logic with no DOM or React, so a minimal Node-environment Vitest setup is sufficient.

- [ ] **Step 1: Add Vitest to the client package**

Edit `packages/client/package.json`. Add `"test": "vitest run"` to `scripts` (alongside the existing `dev`/`build`/`preview`/`typecheck`) and add `"vitest": "^1.6.0"` to `devDependencies` (matching the version pinned in `@mp/server` and `@mp/shared`):

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b",
    "test": "vitest run"
  },
```

```json
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/three": "^0.164.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0"
  }
```

Create `packages/client/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

Then install:

```
pnpm install
```

Expected: `vitest@1.6.x` resolved into `packages/client/node_modules`.

- [ ] **Step 2: Write the failing predictor tests**

Create `packages/client/src/net/prediction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LocalPredictor, PREDICT_DT_S } from "./prediction.js";
import { PLAYER_SPEED } from "@mp/shared";

describe("LocalPredictor", () => {
  it("starts at origin with seq=0", () => {
    const p = new LocalPredictor();
    expect(p.predictedX).toBe(0);
    expect(p.predictedZ).toBe(0);
    expect(p.lastReconErr).toBe(0);
  });

  it("step advances predicted position by dir * speed * fixed dt and queues input", () => {
    const p = new LocalPredictor();
    const sent: Array<{ seq: number; dir: { x: number; z: number } }> = [];
    p.step({ x: 1, z: 0 }, (msg) => sent.push({ seq: msg.seq, dir: msg.dir }));
    expect(p.predictedX).toBeCloseTo(PLAYER_SPEED * PREDICT_DT_S);
    expect(p.predictedZ).toBe(0);
    expect(sent).toEqual([{ seq: 1, dir: { x: 1, z: 0 } }]);
  });

  it("reconcile against acked seq drops queue and snaps to authoritative", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {});
    p.step({ x: 1, z: 0 }, () => {});
    p.step({ x: 1, z: 0 }, () => {});

    // Pretend the server has processed all three; authoritative pos matches.
    const expected = 3 * PLAYER_SPEED * PREDICT_DT_S;
    p.reconcile(expected, 0, 3);

    expect(p.predictedX).toBeCloseTo(expected);
    expect(p.predictedZ).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile re-applies unacked inputs after authoritative snapshot", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, () => {}); // seq 2
    p.step({ x: 1, z: 0 }, () => {}); // seq 3 — server has not yet processed

    // Server has acked through seq=2 and reports the corresponding pos.
    const ackedX = 2 * PLAYER_SPEED * PREDICT_DT_S;
    p.reconcile(ackedX, 0, 2);

    // Predicted pos = server pos + replay of seq 3 (one tick of dir 1,0).
    expect(p.predictedX).toBeCloseTo(3 * PLAYER_SPEED * PREDICT_DT_S);
  });

  it("reconcile records the magnitude of the correction in lastReconErr", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {}); // predicted x = PLAYER_SPEED * PREDICT_DT_S
    // Server reports we are actually at (0, 0) after seq 1 (e.g. clamped by
    // some not-yet-existing wall). Predicted should snap to 0.
    p.reconcile(0, 0, 1);
    expect(p.predictedX).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(PLAYER_SPEED * PREDICT_DT_S);
  });

  it("ignores stale acks (lastProcessedInput < latest queued)", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, () => {}); // seq 2

    // Server ack arrives for seq 1; queue should still contain seq 2.
    p.reconcile(PLAYER_SPEED * PREDICT_DT_S, 0, 1);

    // Predicted = server (PLAYER_SPEED * PREDICT_DT_S) + replay seq 2.
    expect(p.predictedX).toBeCloseTo(2 * PLAYER_SPEED * PREDICT_DT_S);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

```
pnpm --filter @mp/client test
```

Expected: file not found / module not exported.

- [ ] **Step 4: Implement `LocalPredictor`**

Create `packages/client/src/net/prediction.ts`:

```ts
import { PLAYER_SPEED } from "@mp/shared";

export const PREDICT_DT_S = 0.05; // must equal server SIM_DT_S — see AD1

type UnackedInput = {
  seq: number;
  dir: { x: number; z: number };
};

export type SendInput = (msg: { type: "input"; seq: number; dir: { x: number; z: number } }) => void;

/**
 * Owns the local player's predicted state. The network layer calls step()
 * once per 20 Hz client tick (sending the current input + advancing the
 * prediction), and calls reconcile() each time an authoritative snapshot
 * arrives for the local player.
 */
export class LocalPredictor {
  predictedX = 0;
  predictedZ = 0;
  lastReconErr = 0;

  private seq = 0;
  private unacked: UnackedInput[] = [];

  /**
   * Advance one prediction tick: increment seq, send the input, queue it
   * for later reconciliation, and locally apply dir * speed * dt.
   */
  step(dir: { x: number; z: number }, send: SendInput): void {
    this.seq += 1;
    const msg = { type: "input" as const, seq: this.seq, dir: { x: dir.x, z: dir.z } };
    send(msg);
    this.unacked.push({ seq: this.seq, dir: msg.dir });
    this.predictedX += dir.x * PLAYER_SPEED * PREDICT_DT_S;
    this.predictedZ += dir.z * PLAYER_SPEED * PREDICT_DT_S;
  }

  /**
   * Apply an authoritative snapshot for the local player. Drops acked
   * inputs from the queue, recomputes predicted pos by replaying any
   * remaining queued inputs onto the server position, and records the
   * magnitude of the correction in lastReconErr.
   */
  reconcile(serverX: number, serverZ: number, lastProcessedInput: number): void {
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= lastProcessedInput) {
      this.unacked.shift();
    }

    let nextX = serverX;
    let nextZ = serverZ;
    for (const u of this.unacked) {
      nextX += u.dir.x * PLAYER_SPEED * PREDICT_DT_S;
      nextZ += u.dir.z * PLAYER_SPEED * PREDICT_DT_S;
    }

    const dx = nextX - this.predictedX;
    const dz = nextZ - this.predictedZ;
    this.lastReconErr = Math.hypot(dx, dz);
    this.predictedX = nextX;
    this.predictedZ = nextZ;
  }
}
```

- [ ] **Step 5: Run tests, verify all green**

```
pnpm --filter @mp/client test
```

Expected: all six predictor cases pass.

- [ ] **Step 6: Typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add packages/client/src/net/prediction.ts packages/client/src/net/prediction.test.ts packages/client/vitest.config.ts packages/client/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(client): LocalPredictor for client-side prediction & reconciliation

Pure-logic class owning the local player's predicted state:

  - seq counter (monotonic, starts at 0)
  - unacked queue of {seq, dir} pairs
  - predictedX / predictedZ
  - lastReconErr (L2 distance of the most recent correction)

step(dir, send): increment seq, send {type:"input", seq, dir}, push to
queue, advance predicted pos by dir * PLAYER_SPEED * PREDICT_DT_S.

reconcile(x, z, lastProcessedInput): drop acked entries from the queue,
recompute predicted pos = (x, z) + replay of remaining queue, record
the correction magnitude.

PREDICT_DT_S = 0.05 mirrors the server's SIM_DT_S exactly so per-input
displacement is bit-identical and the steady-state recon error is 0
(AD1).

Adds vitest.config.ts to the client package so this pure-logic test
file can run alongside server/shared tests under `pnpm test`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Client `hudState` module + bump snapshot ring buffer to 5

**Why:** A single mutable object is the cheapest way to pass per-tick metrics from network code to the HUD without hammering React state. The snapshot bump is a one-liner per spec.

**Files:**
- Create: `packages/client/src/net/hudState.ts`
- Modify: `packages/client/src/net/snapshots.ts`

- [ ] **Step 1: Create `hudState.ts`**

```ts
// Mutable singleton read by DebugHud each requestAnimationFrame, mutated in
// place by the network/prediction code. Avoids React state churn on the
// hot loop. Treat this as a debugging surface, not an API.

export type HudState = {
  pingMs: number;
  serverTick: number;
  snapshotsPerSec: number;
  interpDelayMs: number;
  playerCount: number;
  reconErr: number;
  visible: boolean;
};

export const hudState: HudState = {
  pingMs: 0,
  serverTick: 0,
  snapshotsPerSec: 0,
  interpDelayMs: 100,
  playerCount: 0,
  reconErr: 0,
  visible: false,
};
```

- [ ] **Step 2: Bump snapshot ring buffer to 5**

In `packages/client/src/net/snapshots.ts`, change:

```ts
const HISTORY = 4;
```

to:

```ts
const HISTORY = 5;
```

No other change.

- [ ] **Step 3: Typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Run client tests (predictor still passes)**

```
pnpm --filter @mp/client test
```

Expected: green.

- [ ] **Step 5: Commit**

```
git add packages/client/src/net/hudState.ts packages/client/src/net/snapshots.ts
git commit -m "$(cat <<'EOF'
feat(client): hudState singleton + snapshot ring buffer 4→5

hudState is a plain mutable object read by DebugHud each rAF; network
and prediction code write to it (pingMs, serverTick, snapshotsPerSec,
playerCount, reconErr, visible). Going through React state on the hot
loop would force re-renders of the entire scene every snapshot — the
debug HUD does not need that and shouldn't pay for it.

Bumps the per-player Snapshot ring buffer from 4 to 5 per the M2 spec.
At 20 Hz with a 100 ms interpolation delay we typically straddle the
two newest snapshots; one extra slot of history smooths over
out-of-order or briefly-late patches without enabling extrapolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Client 20 Hz fixed-step input loop

**Why:** Today's `attachInput` sends on key-change + 200 ms heartbeat. For prediction/reconciliation each input must represent exactly one server tick of motion at the same dt — that requires a fixed-step loop driven by the predictor. This task rewires `input.ts`; rendering changes come in the next task.

**Files:**
- Modify: `packages/client/src/game/input.ts`

- [ ] **Step 1: Replace the contents of `input.ts`**

```ts
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { LocalPredictor } from "../net/prediction.js";

const KEYS = { w: false, a: false, s: false, d: false };

const CODE_TO_KEY: Record<string, "w" | "a" | "s" | "d"> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
};

const STEP_INTERVAL_MS = 50; // 20 Hz; must equal server TICK_INTERVAL_MS

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

/**
 * Owns keyboard listeners and a 20 Hz step loop that drives the predictor
 * and sends one input message per step. Caller is responsible for
 * disposing via the returned function on unmount.
 */
export function attachInput(room: Room<RoomState>, predictor: LocalPredictor): () => void {
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const k = CODE_TO_KEY[e.code];
    if (!k) return;
    if (KEYS[k] === down) return;
    KEYS[k] = down;
  };

  const downHandler = onKey(true);
  const upHandler = onKey(false);
  window.addEventListener("keydown", downHandler);
  window.addEventListener("keyup", upHandler);

  const send = (msg: { type: "input"; seq: number; dir: { x: number; z: number } }) => {
    room.send("input", msg);
  };

  const stepTimer = window.setInterval(() => {
    predictor.step(computeDir(), send);
  }, STEP_INTERVAL_MS);

  return () => {
    window.removeEventListener("keydown", downHandler);
    window.removeEventListener("keyup", upHandler);
    window.clearInterval(stepTimer);
    KEYS.w = KEYS.a = KEYS.s = KEYS.d = false;
  };
}
```

Key differences from M1:
- No `last`/`send-on-change` early return; every step sends.
- No 200 ms heartbeat; the 50 ms step is the heartbeat.
- Predictor owns seq.

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: client fails to compile *somewhere* — `GameView.tsx` calls `attachInput(room)` with one argument but the new signature requires `(room, predictor)`. That's fixed in Task 9. For now, do NOT proceed; the next task wires the new signature.

> If you stop here mid-task to commit, the workspace would be in a broken state. Roll Step 1 of Task 9 into this commit instead — see Task 9 below.

- [ ] **Step 3: Skip commit; continue to Task 9**

(The commit happens at the end of Task 9, which makes the call site match.)

---

## Task 9: Client `PlayerCube` reads predictor when local; `GameView` wires predictor + tick listener + reconcile

**Why:** This finishes the prediction wiring on the client. The local player renders from `LocalPredictor`; the rest is unchanged. `GameView` constructs the predictor, passes it to `attachInput`, listens to local-player `onChange` to call `reconcile`, listens to `state.tick` for the HUD, and reports unexpected leaves to App via a callback prop.

**Files:**
- Modify: `packages/client/src/game/PlayerCube.tsx`
- Modify: `packages/client/src/game/GameView.tsx`

- [ ] **Step 1: Update `PlayerCube` to accept an optional predictor**

Replace `packages/client/src/game/PlayerCube.tsx`:

```tsx
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import type { LocalPredictor } from "../net/prediction.js";

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
  predictor?: LocalPredictor; // present iff this is the local player
};

export function PlayerCube({ sessionId, buffer, predictor }: PlayerCubeProps) {
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => colorFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!ref.current) return;
    if (predictor) {
      ref.current.position.set(predictor.predictedX, 0.5, predictor.predictedZ);
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
    if (sample) ref.current.position.set(sample.x, 0.5, sample.z);
  }, [buffer, predictor]);

  useFrame(() => {
    if (!ref.current) return;
    if (predictor) {
      ref.current.position.x = predictor.predictedX;
      ref.current.position.z = predictor.predictedZ;
      ref.current.position.y = 0.5;
      return;
    }
    const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
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

Two changes:
- New optional `predictor` prop; when present, render path uses predicted x/z.
- `INTERP_DELAY_MS` import replaced with `hudState.interpDelayMs` so the value is the single source of truth that the HUD also reads.

- [ ] **Step 2: Remove the now-unused `INTERP_DELAY_MS` export from `snapshots.ts`**

After Step 1 the only consumer of `INTERP_DELAY_MS` (PlayerCube) reads `hudState.interpDelayMs` instead. Open `packages/client/src/net/snapshots.ts` and delete the line:

```ts
export const INTERP_DELAY_MS = 100; // render this far behind newest snapshot
```

Leave `HISTORY = 5` (set in Task 7) untouched. `hudState.interpDelayMs` is now the single source of truth for the interpolation delay; the HUD reads it and PlayerCube reads it. No other file imports `INTERP_DELAY_MS` (verify with `grep -r INTERP_DELAY_MS packages/client/src`).

- [ ] **Step 3: Update `GameView`**

Replace `packages/client/src/game/GameView.tsx`:

```tsx
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import { Ground } from "./Ground.js";
import { PlayerCube } from "./PlayerCube.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { attachInput } from "./input.js";
import { LocalPredictor } from "../net/prediction.js";
import { hudState } from "../net/hudState.js";
import { DebugHud } from "./DebugHud.js";

type PlayerEntry = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
};

export function GameView({
  room,
  onUnexpectedLeave,
}: {
  room: Room<RoomState>;
  onUnexpectedLeave: () => void;
}) {
  const [players, setPlayers] = useState<Map<string, PlayerEntry>>(new Map());
  const [code, setCode] = useState<string>(room.state.code ?? "");

  const buffers = useMemo(() => new Map<string, SnapshotBuffer>(), []);
  const predictor = useMemo(() => new LocalPredictor(), []);

  useEffect(() => {
    const detachInput = attachInput(room, predictor);

    const $ = getStateCallbacks(room);

    // Room metadata
    const updateCode = () => setCode(room.state.code ?? "");
    const offCode = $(room.state).listen("code", updateCode);
    updateCode();

    // Tick + snapshots/sec for the HUD
    let snapshotsThisSec = 0;
    let lastSecMs = performance.now();
    const offTick = $(room.state).listen("tick", (value) => {
      hudState.serverTick = Number(value);
      snapshotsThisSec += 1;
      const now = performance.now();
      if (now - lastSecMs >= 1000) {
        hudState.snapshotsPerSec = snapshotsThisSec * (1000 / (now - lastSecMs));
        snapshotsThisSec = 0;
        lastSecMs = now;
      }
    });

    const perPlayerDisposers = new Map<string, () => void>();

    const onAdd = (player: Player, sessionId: string) => {
      let buf = buffers.get(sessionId);
      if (!buf) {
        buf = new SnapshotBuffer();
        buffers.set(sessionId, buf);
      }
      buf.push({ t: performance.now(), x: player.x, z: player.z });

      const existing = perPlayerDisposers.get(sessionId);
      if (existing) existing();

      const offChange = $(player).onChange(() => {
        if (sessionId === room.sessionId) {
          // Local player: reconcile predictor against authoritative snapshot.
          predictor.reconcile(player.x, player.z, player.lastProcessedInput);
          hudState.reconErr = predictor.lastReconErr;
        } else {
          // Remote player: feed the interp buffer.
          buf!.push({ t: performance.now(), x: player.x, z: player.z });
        }
      });
      perPlayerDisposers.set(sessionId, offChange);

      setPlayers((prev) => {
        const next = new Map(prev);
        next.set(sessionId, { sessionId, name: player.name, buffer: buf! });
        return next;
      });
      hudState.playerCount = buffers.size;
    };

    const onRemove = (_player: Player, sessionId: string) => {
      const off = perPlayerDisposers.get(sessionId);
      if (off) {
        off();
        perPlayerDisposers.delete(sessionId);
      }
      buffers.delete(sessionId);
      setPlayers((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      hudState.playerCount = buffers.size;
    };

    const offAdd = $(room.state).players.onAdd(onAdd);
    const offRemove = $(room.state).players.onRemove(onRemove);

    room.state.players.forEach((p, id) => onAdd(p, id));

    // Unexpected leave → bubble to App
    const leaveHandler = (closeCode: number) => {
      if (closeCode !== 1000) onUnexpectedLeave();
    };
    room.onLeave(leaveHandler);

    // F3 toggles HUD
    const keyHandler = (e: KeyboardEvent) => {
      if (e.code === "F3") {
        hudState.visible = !hudState.visible;
      }
    };
    window.addEventListener("keydown", keyHandler);

    return () => {
      offCode();
      offTick();
      offAdd();
      offRemove();
      perPlayerDisposers.forEach((off) => off());
      perPlayerDisposers.clear();
      window.removeEventListener("keydown", keyHandler);
      detachInput();
    };
  }, [room, buffers, predictor, onUnexpectedLeave]);

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
          <PlayerCube
            key={p.sessionId}
            sessionId={p.sessionId}
            name={p.name}
            buffer={p.buffer}
            predictor={p.sessionId === room.sessionId ? predictor : undefined}
          />
        ))}
      </Canvas>
      <DebugHud />
    </div>
  );
}
```

The `DebugHud` component is created in Task 10 — for typecheck to pass, do that task immediately after this one (don't run typecheck between Task 9 and Task 10).

- [ ] **Step 4: Continue to Task 10 (DebugHud creation)**

Do NOT typecheck or run tests yet — `./game/DebugHud.js` is referenced but not yet created.

---

## Task 10: Client `DebugHud` + ping/pong wiring + commit Tasks 8–10 together

**Why:** The HUD reads `hudState` once per `requestAnimationFrame` and renders to a tiny fixed-position `<div>`. Ping/pong flows are: 1 Hz `setInterval` sends `{type:"ping", t: Date.now()}`; `room.onMessage("pong", …)` updates `hudState.pingMs` via EWMA.

**Files:**
- Create: `packages/client/src/game/DebugHud.tsx`
- Modify: `packages/client/src/game/GameView.tsx` (add ping interval + pong handler in the same effect)

- [ ] **Step 1: Create `DebugHud.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { hudState } from "../net/hudState.js";

const HUD_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 8,
  right: 8,
  padding: "6px 10px",
  background: "rgba(0,0,0,0.7)",
  color: "#0f0",
  font: "12px/1.4 ui-monospace, Menlo, monospace",
  pointerEvents: "none",
  whiteSpace: "pre",
  zIndex: 1000,
};

export function DebugHud() {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);

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

  if (!hudState.visible) return null;

  const lines = [
    `ping       ${hudState.pingMs.toFixed(0)} ms`,
    `server tick ${hudState.serverTick}`,
    `snapshots  ${hudState.snapshotsPerSec.toFixed(1)} / s`,
    `interp     ${hudState.interpDelayMs} ms`,
    `players    ${hudState.playerCount}`,
    `recon err  ${hudState.reconErr.toFixed(3)} u`,
  ];
  return <div style={HUD_STYLE}>{lines.join("\n")}</div>;
}
```

- [ ] **Step 2: Add ping interval + pong handler to GameView's effect**

Inside the `useEffect` in `packages/client/src/game/GameView.tsx`, add the ping wiring next to the existing listeners (e.g. just below `room.onLeave(leaveHandler)`):

```ts
    // Ping/pong RTT for the HUD.
    const offPong = room.onMessage("pong", (msg: { t: number }) => {
      const rtt = Date.now() - Number(msg.t);
      // EWMA smoothing (alpha 0.2 — fast enough to track changes, smooth enough not to twitch).
      hudState.pingMs = hudState.pingMs === 0 ? rtt : hudState.pingMs * 0.8 + rtt * 0.2;
    });
    const pingTimer = window.setInterval(() => {
      room.send("ping", { type: "ping", t: Date.now() });
    }, 1000);
```

And in the cleanup function:

```ts
      offPong();
      window.clearInterval(pingTimer);
```

- [ ] **Step 3: Typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Run all tests**

```
pnpm test
```

Expected: all green (server, shared, client). The new client wiring is not directly tested by Vitest; manual smoke test in Task 12 verifies UX.

- [ ] **Step 5: Manual smoke test**

```
pnpm dev
```

Open two tabs at `http://localhost:5173`, create a room in tab A, join with the code in tab B. Move both with WASD. Verify:
- Both cubes move smoothly.
- Press F3 in either tab — the HUD appears top-right with non-zero `ping`, monotonically increasing `server tick`, `snapshots ≈ 20 / s`, `interp 100 ms`, `players 2`, `recon err` near zero in steady state.
- Press F3 again to hide.

- [ ] **Step 6: Commit Tasks 8 + 9 + 10 together (single chunk)**

Tasks 8, 9, and 10 only typecheck as a unit because each leaves a broken reference until the next is done. They're committed as one chunk:

```
git add packages/client/src/game/input.ts \
        packages/client/src/game/PlayerCube.tsx \
        packages/client/src/game/GameView.tsx \
        packages/client/src/game/DebugHud.tsx \
        packages/client/src/net/snapshots.ts
git commit -m "$(cat <<'EOF'
feat(client): 20Hz fixed-step input loop + local-player prediction + debug HUD

Three coupled changes that only typecheck together:

  1. input.ts now runs a 20 Hz setInterval that calls predictor.step()
     once per tick. Removes the old send-on-change + 200 ms heartbeat —
     each tick is one input message, one queued unacked entry, one
     local prediction step. Matches server cadence exactly so per-input
     displacement is bit-identical (AD1).

  2. PlayerCube takes an optional predictor prop. When present (i.e.
     this is the local player) it renders predictor.predictedX/Z each
     frame instead of sampling the snapshot buffer. Remote players are
     unchanged — interpolated 100 ms behind the newest snapshot.

  3. GameView constructs a single LocalPredictor per room mount, wires
     it into attachInput, and reconciles in the per-player onChange
     callback when sessionId === room.sessionId. Adds a state.tick
     listener (snapshots/sec for HUD), a F3 keydown toggle for the
     HUD, an unexpected-leave callback that bubbles to App, and a
     1Hz ping/pong loop driving hudState.pingMs (EWMA-smoothed).

DebugHud is a fixed-position monospace overlay reading hudState each
rAF — no React state in the hot loop. It renders nothing when
hudState.visible is false (default).

Manually smoke-tested with two tabs: cubes move smoothly, HUD shows
non-zero ping, ~20 snapshots/s, recon err near 0 in steady state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Client App phase machine + Reconnecting/Disconnected overlays + Landing prefill

**Why (AD3):** Two-phase disconnect UX. On unexpected `room.onLeave`, App enters `reconnecting` and auto-attempts `colyseusClient.reconnect(token)`. On success, GameView re-mounts with the new room. On failure, App enters `disconnected` and shows a Rejoin button that pops back to Landing with name + code prefilled.

**Files:**
- Modify: `packages/client/src/App.tsx`
- Modify: `packages/client/src/Landing.tsx`
- Modify: `packages/client/src/net/client.ts`

- [ ] **Step 1: Make `createRoom`/`joinRoom` wait for `state.code` to populate**

In `packages/client/src/net/client.ts`, replace the file:

```ts
import { Client, Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "ws://localhost:2567";

export const colyseusClient = new Client(SERVER_URL);

async function waitForCode(room: Room<RoomState>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!room.state.code) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function createRoom(name: string): Promise<Room<RoomState>> {
  const room = await colyseusClient.create<RoomState>("game", { name });
  await waitForCode(room);
  return room;
}

export async function joinRoom(code: string, name: string): Promise<Room<RoomState>> {
  const room = await colyseusClient.join<RoomState>("game", { code, name });
  await waitForCode(room);
  return room;
}
```

This makes `room.state.code` defined by the time the promise resolves, simplifying the App phase transition.

- [ ] **Step 2: Update `Landing` to accept initial values**

Replace `packages/client/src/Landing.tsx`:

```tsx
import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { createRoom, joinRoom } from "./net/client.js";

type Props = {
  onJoined: (room: Room<RoomState>, name: string) => void;
  initialName?: string;
  initialCode?: string;
  banner?: string;
};

export function Landing({ onJoined, initialName = "", initialCode = "", banner }: Props) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
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
      onJoined(room, trimmedName);
    } catch (err) {
      setError((err as Error).message ?? "failed to join");
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <h1>monkey-punch</h1>
      {banner ? <div className="banner-msg">{banner}</div> : null}
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

- [ ] **Step 3: Replace `App.tsx` with a phase machine**

```tsx
import { useEffect, useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Landing } from "./Landing.js";
import { GameView } from "./game/GameView.js";
import { colyseusClient } from "./net/client.js";

type Phase =
  | { kind: "landing"; initialName?: string; initialCode?: string; banner?: string }
  | { kind: "playing"; room: Room<RoomState>; code: string; name: string; token: string }
  | { kind: "reconnecting"; code: string; name: string; token: string }
  | { kind: "disconnected"; code: string; name: string };

const OVERLAY: React.CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.6)", color: "white",
  display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center",
  font: "16px/1.4 system-ui, sans-serif",
  zIndex: 2000,
};

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "landing" });

  // Drive the reconnect attempt whenever we enter the reconnecting phase.
  useEffect(() => {
    if (phase.kind !== "reconnecting") return;
    let cancelled = false;
    (async () => {
      try {
        const room = await colyseusClient.reconnect<RoomState>(phase.token);
        // Wait briefly for state.code on the rebound room.
        for (let i = 0; i < 100 && !room.state.code; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        if (cancelled) {
          await room.leave();
          return;
        }
        setPhase({
          kind: "playing",
          room,
          code: room.state.code,
          name: phase.name,
          token: room.reconnectionToken,
        });
      } catch {
        if (!cancelled) {
          setPhase({ kind: "disconnected", code: phase.code, name: phase.name });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  if (phase.kind === "landing") {
    return (
      <Landing
        initialName={phase.initialName}
        initialCode={phase.initialCode}
        banner={phase.banner}
        onJoined={(room, name) => {
          setPhase({
            kind: "playing",
            room,
            code: room.state.code,
            name,
            token: room.reconnectionToken,
          });
        }}
      />
    );
  }

  if (phase.kind === "reconnecting") {
    return (
      <div style={OVERLAY}>
        <div>Reconnecting…</div>
        <div style={{ opacity: 0.7, marginTop: 8 }}>room {phase.code}</div>
      </div>
    );
  }

  if (phase.kind === "disconnected") {
    return (
      <div style={OVERLAY}>
        <div>Disconnected</div>
        <button
          style={{ marginTop: 16, padding: "8px 16px" }}
          onClick={() => setPhase({
            kind: "landing",
            initialName: phase.name,
            initialCode: phase.code,
            banner: "session ended — rejoin?",
          })}
        >
          Rejoin
        </button>
      </div>
    );
  }

  // playing
  return (
    <GameView
      key={phase.room.sessionId}
      room={phase.room}
      onUnexpectedLeave={() => {
        setPhase({
          kind: "reconnecting",
          code: phase.code,
          name: phase.name,
          token: phase.token,
        });
      }}
    />
  );
}
```

The `key={phase.room.sessionId}` on `GameView` ensures it fully unmounts/re-mounts on a successful reconnect, giving us a fresh `LocalPredictor` and clean state.

- [ ] **Step 4: Typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Run all tests**

```
pnpm test
```

Expected: all green.

- [ ] **Step 6: Manual smoke test (server-restart path)**

```
pnpm dev
```

In two tabs, create a room and join with the code. With both tabs visible, kill the dev server (`Ctrl-C` in the terminal). Both tabs should show `Reconnecting…`. Restart `pnpm dev`; the reconnect attempt will fail because the new server has no record of the token (the old room is gone). Both tabs should land on `Disconnected` with a `Rejoin` button. Click `Rejoin` — Landing appears with the name + code prefilled and a "session ended" banner. Click `join` and confirm a fresh room works.

> The grace-window happy path (drop the WebSocket but keep the server alive) is hard to trigger from the browser without dev tools tricks. The server-side test in Task 5 (`reconnect.test.ts`) already exercises that path end-to-end.

- [ ] **Step 7: Commit**

```
git add packages/client/src/App.tsx packages/client/src/Landing.tsx packages/client/src/net/client.ts
git commit -m "$(cat <<'EOF'
feat(client): reconnection phase machine + Disconnected UI

App is now a phase machine: landing → playing → reconnecting →
{playing | disconnected}. On unexpected room.onLeave (close code != 1000)
GameView calls onUnexpectedLeave; App enters "reconnecting" and runs
colyseusClient.reconnect(token) once. Success rebinds the same
sessionId and re-mounts GameView with a fresh LocalPredictor (via
key=room.sessionId). Failure transitions to "disconnected" with a
Rejoin button that pops back to Landing carrying the saved name + code
as initialName / initialCode, plus a small "session ended — rejoin?"
banner (AD3).

createRoom / joinRoom now await room.state.code before resolving so
phase transitions can read it directly.

Reconnection token is held in App component state only (AD2): a hard
tab refresh loses it and falls back to the rejoin path. No
sessionStorage / localStorage involvement.

Server-restart smoke-tested manually: both tabs progress through
Reconnecting → Disconnected → Landing with prefill, and rejoin works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Update CLAUDE.md and README

**Why:** Rule 9 currently says "no client prediction yet"; it's now wrong. Rule 7 should call out that reconnect within 30 s preserves sessionId. README needs a manual smoke-test section so future contributors can verify M2 invariants.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Read the current CLAUDE.md verbatim**

Open `CLAUDE.md` with the Read tool and locate rules 7 and 9 in the "Architectural rules" section. Use the actual text from the file when crafting the replacement edits below; do not rely on memory.

- [ ] **Step 2: Edit rule 9 in CLAUDE.md**

Replace rule 9's body with:

```
9. **Tickrate.** Server simulates at 20Hz with a fixed `dt` of `0.05`s.
   The client renders at 60fps and interpolates remote players between
   the two most recent server snapshots (≈100ms behind newest). The
   local player runs client-side prediction at 20Hz and reconciles
   with the server on each snapshot: unacknowledged inputs (those with
   `seq > Player.lastProcessedInput`) are re-applied to the server's
   authoritative position to produce the predicted current frame.
```

- [ ] **Step 3: Append a sentence to rule 7**

After the existing rule-7 body, append:

```
   Reconnection within a 30s grace window preserves the same sessionId;
   clients that reconnect after the window get a new sessionId and a
   fresh `Player`. There is no cross-tab or cross-room identity.
```

- [ ] **Step 4: Append the manual smoke-test section to README.md**

Append at the end of `README.md`:

```markdown
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
```

- [ ] **Step 5: Typecheck + tests for sanity**

```
pnpm typecheck
pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md rule 9 + 7 reflect M2; README smoke test

Rule 9 is rewritten to describe fixed-dt simulation, 100ms remote
interpolation delay, and the local-player prediction/reconciliation
loop (drop the now-stale "no client prediction yet" parenthetical).

Rule 7 gains a sentence calling out that reconnection within 30s
preserves the same Colyseus sessionId; reconnects after the grace
window get a new sessionId and a fresh Player. No cross-tab or
cross-room identity (AD5).

README appends a manual smoke-test checklist for M2 sync invariants:
two-tab create/join, network throttle, F3 HUD readout, third-tab join
without flicker, server-kill → Reconnecting → Disconnected → Rejoin.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

After all 12 tasks land, run the full verification gate from the spec:

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm test` — all suites green (`@mp/shared`, `@mp/server`, `@mp/client`).
- [ ] Two-tab manual smoke:
  - Smooth motion on remote cube under DevTools "Fast 3G" throttle.
  - Local motion responsive to keypress on throttled network.
  - F3 HUD shows non-zero ping, ~20 snapshots/s, monotonically increasing server tick, recon err ≈ 0 in steady state.
- [ ] Third-tab join: existing cubes do not flicker or snap.
- [ ] Server-restart smoke: both tabs progress Reconnecting → Disconnected → Rejoin, and rejoin succeeds with prefilled code.

If any of these fail, fix before declaring M2 done. Each fix should be its own commit on top — do NOT amend the chunk commits — per the project's chunked-commit convention.
