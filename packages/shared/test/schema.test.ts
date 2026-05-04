import { describe, it, expect } from "vitest";
import { Encoder } from "@colyseus/schema";
import { Player, RoomState, Vec2 } from "../src/schema.js";

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
