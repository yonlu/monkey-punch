import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

export class Vec2 extends Schema {
  x = 0;
  z = 0;
}
defineTypes(Vec2, {
  x: "number",
  z: "number",
});

export class Player extends Schema {
  sessionId = "";
  name = "";
  x = 0;
  y = 0;
  z = 0;
  inputDir = new Vec2();
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  x: "number",
  y: "number",
  z: "number",
  inputDir: Vec2,
});

export class Enemy extends Schema {
  // intentionally empty for now; first gameplay PR fills this in.
  // No defineTypes() call — empty schemas have no fields to register.
}

export class RoomState extends Schema {
  code = "";
  seed = 0;
  tick = 0;
  players = new MapSchema<Player>();
  enemies = new MapSchema<Enemy>();
}
defineTypes(RoomState, {
  code: "string",
  seed: "uint32",
  tick: "uint32",
  players: { map: Player },
  enemies: { map: Enemy },
});
