import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "@colyseus/sdk";
import { GameRoom } from "../src/GameRoom.js";

// End-to-end integration test. Boots a real Colyseus server in-process and
// connects two real colyseus.js clients over WebSocket. Catches the failure
// modes that the unit tests miss:
//
//   - Schema encoder crashes on first client connect (the "Cannot read
//     properties of undefined (reading 'Symbol(Symbol.metadata)')" bug
//     from the @type-decorator → defineTypes() refactor).
//   - Matchmaker join-by-code failures (the "no rooms found with
//     provided criteria" bug from filterBy filtering against creation
//     options instead of metadata).
//
// If either fails, this test errors out — instead of the production server.

const PORT = 2598; // unlikely to clash with a dev server on 2567

let gameServer: Server;

beforeAll(async () => {
  gameServer = new Server();
  gameServer.define("game", GameRoom).filterBy(["code"]);
  await gameServer.listen(PORT, undefined, undefined);
});

afterAll(async () => {
  await gameServer.gracefullyShutdown(false);
});

describe("integration: room create → join-by-code → state sync", () => {
  it("two clients can join the same room via 4-char code and see each other", async () => {
    const client = new Client(`ws://localhost:${PORT}`);

    // Tab A creates a room. The server generates a code in onCreate and
    // sets it on state.code; the encoder runs at this point.
    const roomA = await client.create<{ code: string; players: { keys: () => IterableIterator<string> } }>(
      "game",
      { name: "Alice" },
    );

    // Wait for the first state patch so room.state.code is populated.
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);

    const code = roomA.state.code;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);

    // Tab B joins by code. This is the matchmaker path that filterBy(["code"])
    // exercises. Will fail with "no rooms found" if the listing's top-level
    // code field isn't set.
    const roomB = await client.join<{ code: string; players: { keys: () => IterableIterator<string> } }>(
      "game",
      { code, name: "Bob" },
    );

    // Wait for both rooms to see both players.
    await waitFor(
      () => Array.from(roomA.state.players.keys()).length === 2 &&
            Array.from(roomB.state.players.keys()).length === 2,
      1000,
    );

    const aPlayers = Array.from(roomA.state.players.keys()).sort();
    const bPlayers = Array.from(roomB.state.players.keys()).sort();
    expect(aPlayers).toEqual([roomA.sessionId, roomB.sessionId].sort());
    expect(bPlayers).toEqual([roomA.sessionId, roomB.sessionId].sort());

    await roomB.leave();
    await roomA.leave();
  }, 5000);
});

describe("integration: enemy spawn + movement over real ticks", () => {
  it("spawns ~5 enemies in 5 seconds and they move toward the connected player", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<{
      code: string;
      enemies: { size: number; forEach: (cb: (e: { x: number; z: number }, k: string) => void) => void };
    }>("game", { name: "Solo" });

    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Server runs at 20 Hz; spawn interval is 1.0 s. Wait ~5.5 s wall time.
    await new Promise((r) => setTimeout(r, 5500));

    const enemyCount = room.state.enemies.size;
    expect(enemyCount).toBeGreaterThanOrEqual(4);
    expect(enemyCount).toBeLessThanOrEqual(6);

    // Snapshot current enemy positions; wait 4 ticks; assert at least one
    // enemy moved.
    const before = new Map<string, { x: number; z: number }>();
    room.state.enemies.forEach((e, k) => before.set(k, { x: e.x, z: e.z }));

    await new Promise((r) => setTimeout(r, 200));

    let moved = 0;
    room.state.enemies.forEach((e, k) => {
      const prev = before.get(k);
      if (!prev) return;
      if (Math.abs(e.x - prev.x) > 1e-4 || Math.abs(e.z - prev.z) > 1e-4) moved++;
    });
    expect(moved).toBeGreaterThan(0);

    await room.leave();
  }, 10_000);
});

describe("integration: kill + gem drop end-to-end", () => {
  it("auto-fire kills several enemies and drops gems within ~12s", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type CombatRoomState = {
      code: string;
      enemies: { size: number };
      gems: { size: number };
    };
    const room = await client.create<CombatRoomState>("game", { name: "Solo" });

    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Burst-spawn 20 enemies via debug. They spawn at ENEMY_SPAWN_RADIUS=30
    // (outside TARGETING_MAX_RANGE=20) and walk inward at ENEMY_SPEED=2 u/s.
    // First enemies enter range after ~5s; Bolt does 10 dmg/0.6s vs 30 hp.
    room.send("debug_spawn", { type: "debug_spawn", count: 20 });

    // Let the state patch propagate so we can measure the post-burst baseline.
    await new Promise((r) => setTimeout(r, 300));
    const countAfterBurst = room.state.enemies.size; // ≥ 20

    // Wait long enough for several kills.
    await new Promise((r) => setTimeout(r, 12_000));

    // The regular spawner adds ~1 enemy/s; over 12s that's ≤12 more.
    // If no combat kills occurred: enemies ≈ countAfterBurst + 12.
    // Requiring enemies < countAfterBurst + 12 proves at least some were killed.
    const maxWithoutKills = countAfterBurst + 12;
    expect(room.state.gems.size).toBeGreaterThan(0);
    expect(room.state.enemies.size).toBeLessThan(maxWithoutKills);

    await room.leave();
  }, 20_000);
});

describe("integration: XP gain on gem pickup end-to-end", () => {
  it("player walks to a gem and picks it up; xp increments and gem is gone", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type RoomShape = {
      code: string;
      enemies: { size: number };
      gems: {
        size: number;
        forEach: (cb: (g: { id: number; x: number; z: number }, k: string) => void) => void;
        has: (k: string) => boolean;
      };
      players: { get: (sid: string) => { xp: number; x: number; z: number } | undefined };
    };
    const room = await client.create<RoomShape>("game", { name: "Solo" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Get a gem on the ground.
    room.send("debug_spawn", { type: "debug_spawn", count: 20 });
    await waitFor(() => room.state.gems.size > 0, 15_000);

    // Pick the first gem; capture its position and id.
    let target: { id: number; x: number; z: number } | null = null;
    room.state.gems.forEach((g) => {
      if (target == null) target = { id: g.id, x: g.x, z: g.z };
    });
    if (!target) throw new Error("expected at least one gem");
    const targetGem = target as { id: number; x: number; z: number };

    // Walk the player toward the gem at full speed by sending input
    // messages every ~50ms. Use the player's current position (from
    // room.state, slightly stale but fine — the gem isn't moving).
    let seq = 1;
    let stopWalking = false;
    const walker = setInterval(() => {
      if (stopWalking) return;
      const player = room.state.players.get(room.sessionId);
      if (!player) return;
      const dx = targetGem.x - player.x;
      const dz = targetGem.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      room.send("input", {
        type: "input",
        seq: seq++,
        dir: { x: dx / len, z: dz / len },
      });
    }, 50);

    try {
      // Wait for pickup (or fail): both xp > 0 and gem removed arrive in
      // the same server patch, but poll both to be safe against partial
      // delivery ordering in the WebSocket framing.
      await waitFor(() => {
        const player = room.state.players.get(room.sessionId);
        return (
          !!player &&
          player.xp > 0 &&
          !room.state.gems.has(String(targetGem.id))
        );
      }, 10_000);
    } finally {
      stopWalking = true;
      clearInterval(walker);
    }

    const player = room.state.players.get(room.sessionId);
    expect(player).toBeDefined();
    expect(player!.xp).toBeGreaterThan(0);
    expect(room.state.gems.has(String(targetGem.id))).toBe(false);

    await room.leave();
  }, 30_000);
});

describe("integration: cross-client fire event determinism", () => {
  it("two clients see bit-identical FireEvent payloads for shared fireIds", async () => {
    const a = new Client(`ws://localhost:${PORT}`);
    const b = new Client(`ws://localhost:${PORT}`);

    type RoomShape = { code: string };
    const roomA = await a.create<RoomShape>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);

    const roomB = await b.join<RoomShape>("game", { code: roomA.state.code, name: "Bob" });

    type FirePayload = {
      fireId: number;
      originX: number;
      originY: number;
      originZ: number;
      dirX: number;
      dirY: number;
      dirZ: number;
      serverFireTimeMs: number;
      ownerId: string;
      weaponKind: number;
      // M8 US-002: new fields on FireEvent. weaponLevel powers per-level
      // visual scaling on the client; lockedTargetId powers deterministic
      // homing (Gakkung Bow US-003). Asserting them here is the encoder
      // regression guard — if either were dropped from the schema the
      // assertion below would catch it before any runtime crash.
      weaponLevel: number;
      lockedTargetId: number;
    };
    const firesA = new Map<number, FirePayload>();
    const firesB = new Map<number, FirePayload>();

    roomA.onMessage("fire", (msg: FirePayload) => firesA.set(msg.fireId, msg));
    roomB.onMessage("fire", (msg: FirePayload) => firesB.set(msg.fireId, msg));

    // Burst-spawn enemies so auto-fire actually fires within the test
    // window. (With no enemies, no fire events occur and the test passes
    // vacuously — bad. We need at least one shared fireId.)
    roomA.send("debug_spawn", { type: "debug_spawn", count: 20 });

    // Wait ~10s — long enough for enemies to walk in and combat to occur.
    await new Promise((r) => setTimeout(r, 10_000));

    // Find the intersection of fireIds seen by both.
    const shared: number[] = [];
    firesA.forEach((_, id) => { if (firesB.has(id)) shared.push(id); });
    expect(shared.length).toBeGreaterThan(0);

    for (const id of shared) {
      const ea = firesA.get(id)!;
      const eb = firesB.get(id)!;
      expect(ea.originX).toBe(eb.originX);
      expect(ea.originY).toBe(eb.originY);
      expect(ea.originZ).toBe(eb.originZ);
      expect(ea.dirX).toBe(eb.dirX);
      expect(ea.dirY).toBe(eb.dirY);
      expect(ea.dirZ).toBe(eb.dirZ);
      expect(ea.serverFireTimeMs).toBe(eb.serverFireTimeMs);
      expect(ea.ownerId).toBe(eb.ownerId);
      expect(ea.weaponKind).toBe(eb.weaponKind);
      expect(ea.weaponLevel).toBe(eb.weaponLevel);
      expect(ea.lockedTargetId).toBe(eb.lockedTargetId);
    }

    await roomB.leave();
    await roomA.leave();
  }, 25_000);
});

describe("integration: M6 player_damaged → player_downed → run_ended", () => {
  it("solo room: damage chain reaches client; downed flag flips; runEnded broadcasts", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type RoomShape = {
      code: string;
      runEnded: boolean;
      players: { get: (sid: string) => { hp: number; downed: boolean; lastProcessedInput: number } | undefined };
    };
    const room = await client.create<RoomShape>("game", { name: "Solo" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    type Damaged = { playerId: string; damage: number };
    type Downed = { playerId: string };
    type Ended = { serverTick: number };

    const damages: Damaged[] = [];
    let downedFor: string | null = null;
    let runEndedSeen = false;

    room.onMessage("player_damaged", (msg: Damaged) => damages.push(msg));
    room.onMessage("player_downed", (msg: Downed) => { downedFor = msg.playerId; });
    room.onMessage("run_ended", (_msg: Ended) => { runEndedSeen = true; });

    // Drop hp to zero via the debug message. The handler emits player_damaged +
    // player_downed, sets downed=true. tickRunEndCheck on the next tick flips
    // state.runEnded and emits run_ended (single-player room → all-downed).
    room.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });

    await waitFor(() => damages.length >= 1, 1500);
    expect(damages[0]!.playerId).toBe(room.sessionId);
    expect(damages[0]!.damage).toBe(100);

    await waitFor(() => downedFor === room.sessionId, 1500);
    // Also wait for the schema patch to propagate (message arrives before patch).
    await waitFor(() => room.state.players.get(room.sessionId)?.downed === true, 1000);
    const me = room.state.players.get(room.sessionId);
    expect(me?.downed).toBe(true);
    expect(me?.hp).toBe(0);

    // Snapshot lastProcessedInput; sending an input as a downed player must NOT
    // bump it (input handler drops silently per the gate added in Task 2.3).
    const seqBefore = me?.lastProcessedInput ?? 0;
    room.send("input", {
      type: "input",
      seq: seqBefore + 1,
      dir: { x: 1, z: 0 },
    });
    await new Promise((r) => setTimeout(r, 200));
    const meAfterInput = room.state.players.get(room.sessionId);
    expect(meAfterInput?.lastProcessedInput).toBe(seqBefore);

    await waitFor(() => runEndedSeen, 1500);
    // Also wait for the schema patch to propagate (message arrives before patch).
    await waitFor(() => room.state.runEnded, 1000);
    expect(room.state.runEnded).toBe(true);

    await room.leave();
  }, 8000);

  it("two-client room: damaging one client does NOT end the run; both go down does", async () => {
    const a = new Client(`ws://localhost:${PORT}`);
    const b = new Client(`ws://localhost:${PORT}`);

    type RoomShape = {
      code: string;
      runEnded: boolean;
      players: {
        get: (sid: string) => { hp: number; downed: boolean } | undefined;
        forEach: (cb: (p: { sessionId: string; downed: boolean }) => void) => void;
        size: number;
      };
    };
    const roomA = await a.create<RoomShape>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);

    const roomB = await b.join<RoomShape>("game", { code: roomA.state.code, name: "Bob" });
    await waitFor(() => roomA.state.players.size === 2 && roomB.state.players.size === 2, 1500);

    let runEndedAtA = false;
    let runEndedAtB = false;
    roomA.onMessage("run_ended", () => { runEndedAtA = true; });
    roomB.onMessage("run_ended", () => { runEndedAtB = true; });

    // Down Alice. Run should NOT end (Bob is still up).
    roomA.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });
    await waitFor(
      () => roomA.state.players.get(roomA.sessionId)?.downed === true,
      1500,
    );
    // Give the next tick a chance to potentially fire run_ended (it must not).
    await new Promise((r) => setTimeout(r, 200));
    expect(runEndedAtA).toBe(false);
    expect(runEndedAtB).toBe(false);
    expect(roomA.state.runEnded).toBe(false);

    // Down Bob. Run ends at the next tick.
    roomB.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });
    await waitFor(() => runEndedAtA && runEndedAtB, 2000);
    // Also wait for the schema patch to propagate (message arrives before patch).
    await waitFor(() => roomA.state.runEnded && roomB.state.runEnded, 1000);
    expect(roomA.state.runEnded).toBe(true);
    expect(roomB.state.runEnded).toBe(true);

    await roomB.leave();
    await roomA.leave();
  }, 12000);
});

describe("integration: M7 US-009 jump trajectory end-to-end", () => {
  it("solo room: jump input lifts player Y off the ground; trajectory rises and lands", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    type RoomShape = {
      code: string;
      players: { get: (sid: string) => { x: number; y: number; z: number; vy: number; grounded: boolean } | undefined };
    };
    const room = await client.create<RoomShape>("game", { name: "Jumper" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    // Wait for initial player state to be ready (y == 0 at spawn flat).
    await waitFor(() => {
      const me = room.state.players.get(room.sessionId);
      return !!me && me.grounded === true;
    }, 1500);

    const meStart = room.state.players.get(room.sessionId)!;
    expect(meStart.y).toBe(0);
    expect(meStart.vy).toBe(0);
    expect(meStart.grounded).toBe(true);

    // Send a single jump input. Server should set vy to JUMP_VELOCITY (=9)
    // on the next tick, integrate gravity, and lift Y off the ground.
    room.send("input", {
      type: "input",
      seq: 1,
      dir: { x: 0, z: 0 },
      jump: true,
    });

    // Wait for liftoff (Y > 0 is the unambiguous signal — even one tick of
    // post-jump physics produces y ≈ 0.39).
    await waitFor(() => {
      const me = room.state.players.get(room.sessionId);
      return !!me && me.y > 0.1 && me.grounded === false;
    }, 1500);

    // Sample peak height by polling for ~1s. JUMP_VELOCITY^2 / (2*GRAVITY)
    // = 81 / 50 = 1.62 (continuous-time formula). Discrete symplectic
    // Euler at 20Hz produces a peak ~14% lower (≈1.40) — see the matching
    // unit test in shared/test/rules.test.ts for the integration-scheme
    // explanation. We assert the peak is in the range [70%, 120%] of the
    // formula: enough headroom for the integration scheme + WebSocket
    // sampling slop, tight enough to fail if jump didn't fire.
    let peak = 0;
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const me = room.state.players.get(room.sessionId);
      if (me && me.y > peak) peak = me.y;
      if (me && me.grounded) break;        // landed
      await new Promise((r) => setTimeout(r, 20));
    }
    const expectedPeak = (9 * 9) / (2 * 25);
    expect(peak).toBeGreaterThan(expectedPeak * 0.7);
    expect(peak).toBeLessThan(expectedPeak * 1.2);

    // After ~1s the jump should be fully resolved and player back on ground.
    await waitFor(() => {
      const me = room.state.players.get(room.sessionId);
      return !!me && me.grounded === true && Math.abs(me.y) < 1e-6;
    }, 1500);
    const meEnd = room.state.players.get(room.sessionId)!;
    expect(meEnd.y).toBe(0);
    expect(meEnd.vy).toBe(0);
    expect(meEnd.grounded).toBe(true);

    // Subsequent input WITHOUT jump=true must NOT re-jump.
    room.send("input", {
      type: "input",
      seq: 2,
      dir: { x: 0, z: 0 },
      jump: false,
    });
    await new Promise((r) => setTimeout(r, 200));
    const meAfter = room.state.players.get(room.sessionId)!;
    expect(meAfter.grounded).toBe(true);
    expect(meAfter.y).toBe(0);

    await room.leave();
  }, 8000);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
