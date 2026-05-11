import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server, matchMaker } from "colyseus";
import { Client } from "@colyseus/sdk";
import { GameRoom } from "../src/GameRoom.js";

const PORT = 2601;

let gameServer: Server;

beforeAll(async () => {
  gameServer = new Server();
  gameServer.define("game", GameRoom).filterBy(["code"]);
  await gameServer.listen(PORT, undefined, undefined);
});

afterAll(async () => {
  await gameServer.gracefullyShutdown(false);
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await Promise.resolve(cond())) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

type RoomMetadata = { code: string; hostName: string | null };

async function getRoomMetadata(code: string): Promise<RoomMetadata | undefined> {
  const rooms = await matchMaker.query({ name: "game" });
  const r = rooms.find((r) => (r.metadata as RoomMetadata | undefined)?.code === code);
  return r?.metadata as RoomMetadata | undefined;
}

describe("integration: GameRoom listing metadata hostName lifecycle", () => {
  it("hostName becomes the first joiner's name", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);
    const code = room.state.code as string;

    await waitFor(async () => (await getRoomMetadata(code))?.hostName === "Alice", 1000);

    const md = await getRoomMetadata(code);
    expect(md?.code).toBe(code);
    expect(md?.hostName).toBe("Alice");

    await room.leave();
  }, 5000);

  it("hostName rotates to next player when host consents to leave", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const roomA = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);
    const code = roomA.state.code as string;

    const roomB = await client.join<any>("game", { code, name: "Bob" });
    await waitFor(
      () => Array.from(roomA.state.players.keys()).length === 2,
      1000,
    );

    expect((await getRoomMetadata(code))?.hostName).toBe("Alice");

    await roomA.leave(true);

    await waitFor(
      async () => (await getRoomMetadata(code))?.hostName === "Bob",
      1000,
    );

    expect((await getRoomMetadata(code))?.hostName).toBe("Bob");

    await roomB.leave();
  }, 5000);

  it("hostName does not change when a non-host leaves", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const roomA = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);
    const code = roomA.state.code as string;

    const roomB = await client.join<any>("game", { code, name: "Bob" });
    await waitFor(
      () => Array.from(roomA.state.players.keys()).length === 2,
      1000,
    );
    await waitFor(async () => (await getRoomMetadata(code))?.hostName === "Alice", 500);

    await roomB.leave(true);

    await new Promise((r) => setTimeout(r, 100));

    expect((await getRoomMetadata(code))?.hostName).toBe("Alice");

    await roomA.leave();
  }, 5000);
});
