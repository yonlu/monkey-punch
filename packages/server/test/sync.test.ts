import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "@colyseus/sdk";
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
});
