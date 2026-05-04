import { Schema, MapSchema, type } from "@colyseus/schema";

export class Vec2 extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
}

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type(Vec2) inputDir = new Vec2();
}

export class Enemy extends Schema {
  // intentionally empty for now; first gameplay PR fills this in.
}

export class RoomState extends Schema {
  @type("string") code = "";
  @type("uint32") seed = 0;
  @type("number") tick = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Enemy }) enemies = new MapSchema<Enemy>();
}
