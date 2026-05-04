import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "colyseus.js";
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

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
