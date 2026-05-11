import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "@colyseus/sdk";
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
    await waitFor(() => observer.state?.players?.size === 2, 1000);

    // Force-close A's transport.
    (room as any).connection.transport.close();

    // Wait beyond the 1s grace.
    await waitFor(() => observer.state?.players?.size === 1, 3000);
    expect(observer.state.players.has(sessionId)).toBe(false);

    await observer.leave();
  }, 5000);

  it("downed state and recap fields survive reconnection within grace window", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Down" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;
    const token = room.reconnectionToken;

    // Drop the player to 0 hp via the debug message; tickContactDamage isn't
    // running (no enemies in contact), so this is the deterministic path.
    // The handler emits player_damaged + player_downed and sets downed=true.
    room.send("debug_damage_self", { type: "debug_damage_self", amount: 100 });

    await waitFor(() => {
      const me = room.state.players.get(sessionId);
      return !!me && me.downed === true && me.hp === 0;
    }, 1500);

    // Snapshot joinTick BEFORE disconnect so we can assert exact equality
    // post-resume. (joinTick is uint32, so a `>= 0` assertion is trivially
    // true and would not catch a regression that re-ran onJoin on reconnect.)
    const joinTickBefore = room.state.players.get(sessionId)!.joinTick;

    // Force-close transport and reconnect within the (overridden 1s) grace.
    (room as any).connection.transport.close();
    await new Promise((r) => setTimeout(r, 100));

    const resumed = await client.reconnect<any>(token);
    await waitFor(() => resumed.state.code !== "" && resumed.state.code != null, 1500);

    expect(resumed.sessionId).toBe(sessionId);
    const meAfter = resumed.state.players.get(sessionId)!;
    expect(meAfter.downed).toBe(true);
    expect(meAfter.hp).toBe(0);
    // joinTick must be the same value as before disconnect (set once in onJoin,
    // not touched on reconnect).
    expect(meAfter.joinTick).toBe(joinTickBefore);
    // kills and xpGained are zero in this test because no kills happened, but
    // we assert they persist as schema fields (not `undefined`).
    expect(meAfter.kills).toBe(0);
    expect(meAfter.xpGained).toBe(0);

    await resumed.leave();
  }, 5000);
});
