import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    await waitFor(() => observer.state?.players?.size === 2, 1000);

    // Force-close A's transport.
    (room as any).connection.transport.close();

    // Wait beyond the 1s grace.
    await waitFor(() => observer.state?.players?.size === 1, 3000);
    expect(observer.state.players.has(sessionId)).toBe(false);

    await observer.leave();
  }, 5000);
});
