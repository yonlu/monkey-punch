import { describe, it, expect } from "vitest";
import { Encoder } from "@colyseus/schema";
import { Enemy, Player, RoomState, Vec2 } from "../src/schema.js";

// These tests exercise the Colyseus encoder against our schema. The encoder
// path is what the server runs when a client connects — a regression here
// prevents anyone from joining a room. Vitest doesn't drive a real WebSocket
// session, but constructing an Encoder over a populated state and calling
// encodeAll() reproduces the same crash mode (the encoder reads the
// MapSchema's $childType, which only gets set when the field setters run).
//
// If you change schema.ts in a way that breaks the prototype setters
// (e.g. by reintroducing class field initializers), these tests fail with
// "Cannot read properties of undefined (reading 'Symbol(Symbol.metadata)')".

describe("schema encoding (regression: prototype setters must run)", () => {
  it("sets $childType on MapSchema fields after construction", () => {
    const state = new RoomState();
    // The internal symbol is stored as the string "~childType" in @colyseus/schema v3.
    expect((state.players as unknown as Record<string, unknown>)["~childType"]).toBe(Player);
  });

  it("encodes a populated RoomState without throwing", () => {
    const state = new RoomState();
    state.code = "ABCD";
    state.seed = 12345;

    const p = new Player();
    p.sessionId = "abc";
    p.name = "Alice";
    p.x = 1;
    p.y = 0;
    p.z = -2;
    p.inputDir.x = 0.5;
    p.inputDir.z = 0.5;
    state.players.set(p.sessionId, p);

    const encoder = new Encoder(state);
    const bytes = encoder.encodeAll();
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("encodes nested Vec2 inside a Player without throwing", () => {
    const state = new RoomState();
    const p = new Player();
    p.sessionId = "abc";
    p.inputDir = new Vec2();
    p.inputDir.x = 1;
    state.players.set(p.sessionId, p);

    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });

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
});

describe("Enemy schema", () => {
  it("sets $childType on RoomState.enemies after construction", () => {
    const state = new RoomState();
    expect(
      (state.enemies as unknown as Record<string, unknown>)["~childType"],
    ).toBe(Enemy);
  });

  it("encodes a populated Enemy without throwing", () => {
    const state = new RoomState();
    state.code = "ABCD";
    state.seed = 12345;

    const enemy = new Enemy();
    enemy.id = 42;
    enemy.kind = 0;
    enemy.x = 7.5;
    enemy.z = -3.25;
    enemy.hp = 1;
    state.enemies.set(String(enemy.id), enemy);

    const encoder = new Encoder(state);
    const bytes = encoder.encodeAll();
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("Enemy field defaults from constructor are zero", () => {
    const e = new Enemy();
    expect(e.id).toBe(0);
    expect(e.kind).toBe(0);
    expect(e.x).toBe(0);
    expect(e.z).toBe(0);
    expect(e.hp).toBe(0);
  });

  it("encodes many enemies in one state without throwing", () => {
    const state = new RoomState();
    for (let i = 1; i <= 100; i++) {
      const e = new Enemy();
      e.id = i;
      e.kind = 0;
      e.x = i * 0.1;
      e.z = -i * 0.1;
      e.hp = 1;
      state.enemies.set(String(i), e);
    }
    const encoder = new Encoder(state);
    expect(() => encoder.encodeAll()).not.toThrow();
  });
});
