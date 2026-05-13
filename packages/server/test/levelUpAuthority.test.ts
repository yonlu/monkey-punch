import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "@colyseus/sdk";
import { GameRoom } from "../src/GameRoom.js";

// Server-authority enforcement on the debug_* shortcuts. The legitimate
// progression path (xp → tickXp → pendingLevelUp + offer → level_up_choice)
// is gated by player.pendingLevelUp in the level_up_choice handler. The
// debug_grant_weapon / debug_grant_xp shortcuts must respect the same gate
// or a client could sidestep the choice mechanic — exactly the Phase 8.4
// regression that prompted this test file (see commit 9fc7705 for the
// parallel client-side gate).
//
// Not covered here: a level_up_choice arriving on the same tick the auto-pick
// deadline expires. The deadline check in GameRoom is defensive against that
// race, but tickLevelUpDeadlines clears pendingLevelUp at the same tick
// boundary, so an integration test sees the existing pendingLevelUp guard
// catch it before the deadline guard does. Lower-level race coverage would
// require unit-testing the handler against a synthetic state machine; left
// for if/when the race is observed in the wild.

const PORT = 2604;

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

describe("server authority: debug shortcuts must respect pendingLevelUp", () => {
  it("debug_grant_weapon is rejected while a level-up choice is pending", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;

    // Force a pending level-up via the legitimate xp path (mirrors
    // levelUpReconnect.test.ts pattern).
    room.send("debug_grant_xp", { type: "debug_grant_xp", amount: 100 });
    await waitFor(() => {
      const me = room.state.players.get(sessionId);
      return !!me?.pendingLevelUp && me.levelUpChoices.length === 3;
    }, 2000);

    const me = room.state.players.get(sessionId)!;
    const weaponsBefore = me.weapons.length;

    // Capture the per-kind level state for every existing weapon so we can
    // detect a sneaky in-place upgrade in addition to a length change.
    const weaponSnapshot = me.weapons.map((w: any) => ({ kind: w.kind, level: w.level }));

    // Attempt to grant a weapon while the offer is pending. Server should
    // ignore the message — neither a new weapon nor an upgrade to an
    // existing one.
    room.send("debug_grant_weapon", { type: "debug_grant_weapon", weaponKind: 1 });

    // Give the server several ticks (~250ms) to process the message and
    // NOT mutate the player.
    await new Promise((r) => setTimeout(r, 250));

    expect(me.pendingLevelUp).toBe(true);
    expect(me.weapons.length).toBe(weaponSnapshot.length);
    for (let i = 0; i < weaponSnapshot.length; i++) {
      expect(me.weapons[i]!.kind).toBe(weaponSnapshot[i]!.kind);
      expect(me.weapons[i]!.level).toBe(weaponSnapshot[i]!.level);
    }

    await room.leave();
  }, 8000);

  it("debug_grant_xp is rejected while a level-up choice is pending", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Bob" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;

    room.send("debug_grant_xp", { type: "debug_grant_xp", amount: 100 });
    await waitFor(() => {
      const me = room.state.players.get(sessionId);
      return !!me?.pendingLevelUp && me.levelUpChoices.length === 3;
    }, 2000);

    const me = room.state.players.get(sessionId)!;
    const xpBefore = me.xp;

    // Attempting to add more xp during a pending offer would otherwise
    // stack a second offer behind the first. Server must reject.
    room.send("debug_grant_xp", { type: "debug_grant_xp", amount: 50 });

    await new Promise((r) => setTimeout(r, 250));

    expect(me.pendingLevelUp).toBe(true);
    expect(me.xp).toBe(xpBefore);

    await room.leave();
  }, 8000);
});
