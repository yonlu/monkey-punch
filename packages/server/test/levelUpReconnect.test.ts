import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "colyseus";
import { Client } from "colyseus.js";
import { GameRoom } from "../src/GameRoom.js";

const PORT = 2603;

// Override grace BEFORE GameRoom imports parseGraceSeconds. The existing
// reconnect.test.ts also sets this at module top; same pattern here.
process.env.MP_RECONNECTION_GRACE_S = "5";

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

describe("integration: level-up state survives reconnection", () => {
  it("pendingLevelUp + choices + deadlineTick are preserved across reconnect", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);

    const sessionId = room.sessionId;
    const token = room.reconnectionToken;

    // Push XP over the L1 threshold (xpForLevel(1)=6) so tickXp fires the
    // next simulation tick.
    room.send("debug_grant_xp", { type: "debug_grant_xp", amount: 100 });

    await waitFor(() => {
      const me = room.state.players.get(sessionId);
      return !!me?.pendingLevelUp && me.levelUpChoices.length === 3;
    }, 2000);

    const me = room.state.players.get(sessionId)!;
    const beforeDeadline = me.levelUpDeadlineTick;
    // M9 US-002: levelUpChoices is now ArraySchema<LevelUpChoice> (was
    // ArraySchema<number>). Capture the {type, index} VALUES — schema
    // objects get new references on reconnect, so reference equality
    // (.toBe) won't hold; we compare the structural payload instead.
    const beforeChoices = [
      { type: me.levelUpChoices[0]!.type, index: me.levelUpChoices[0]!.index },
      { type: me.levelUpChoices[1]!.type, index: me.levelUpChoices[1]!.index },
      { type: me.levelUpChoices[2]!.type, index: me.levelUpChoices[2]!.index },
    ];
    expect(beforeDeadline).toBeGreaterThan(0);

    // Force a non-graceful disconnect.
    (room as any).connection.transport.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect within the (overridden 5s) grace window.
    const resumed = await client.reconnect<any>(token);
    await waitFor(() => resumed.state.code !== "" && resumed.state.code != null, 1500);

    expect(resumed.sessionId).toBe(sessionId);
    const meAfter = resumed.state.players.get(sessionId)!;
    expect(meAfter.pendingLevelUp).toBe(true);
    expect(meAfter.levelUpChoices.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(meAfter.levelUpChoices[i]!.type).toBe(beforeChoices[i]!.type);
      expect(meAfter.levelUpChoices[i]!.index).toBe(beforeChoices[i]!.index);
    }
    // deadlineTick is in tick-space; it persists exactly.
    expect(meAfter.levelUpDeadlineTick).toBe(beforeDeadline);

    // The choice still works post-reconnect.
    resumed.send("level_up_choice", { type: "level_up_choice", choiceIndex: 0 });
    await waitFor(() => {
      const m = resumed.state.players.get(sessionId);
      return !!m && !m.pendingLevelUp && m.weapons.length >= 1;
    }, 1500);

    await resumed.leave();
  }, 12000);
});
