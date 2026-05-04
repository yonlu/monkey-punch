import { describe, it, expect } from "vitest";
import { RoomState, Player } from "../src/schema.js";
import { tickPlayers, PLAYER_SPEED } from "../src/rules.js";

function addPlayer(state: RoomState, id: string, dirX: number, dirZ: number): Player {
  const p = new Player();
  p.sessionId = id;
  p.inputDir.x = dirX;
  p.inputDir.z = dirZ;
  state.players.set(id, p);
  return p;
}

describe("tickPlayers", () => {
  it("moves a player by inputDir * PLAYER_SPEED * dt on each axis", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);

    tickPlayers(state, 0.5);

    expect(p.x).toBeCloseTo(PLAYER_SPEED * 0.5);
    expect(p.z).toBe(0);
  });

  it("zero inputDir produces no movement", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 0, 0);

    tickPlayers(state, 1.0);

    expect(p.x).toBe(0);
    expect(p.z).toBe(0);
  });

  it("moves multiple players independently", () => {
    const state = new RoomState();
    const a = addPlayer(state, "a", 1, 0);
    const b = addPlayer(state, "b", 0, -1);

    tickPlayers(state, 0.1);

    expect(a.x).toBeCloseTo(PLAYER_SPEED * 0.1);
    expect(a.z).toBe(0);
    expect(b.x).toBe(0);
    expect(b.z).toBeCloseTo(-PLAYER_SPEED * 0.1);
  });

  it("integration over multiple ticks accumulates", () => {
    const state = new RoomState();
    const p = addPlayer(state, "a", 1, 0);

    for (let i = 0; i < 10; i++) {
      tickPlayers(state, 0.05);
    }

    expect(p.x).toBeCloseTo(PLAYER_SPEED * 0.5);
  });
});
