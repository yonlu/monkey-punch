import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

// IMPORTANT: schema fields are declared with `declare` (type-only) and assigned
// in the constructor body. Class field INITIALIZERS (`x = 0`) compile differently
// across toolchains: tsc honors `useDefineForClassFields: false` and emits
// `this.x = 0` (which goes through the prototype setters that defineTypes()
// installs), but esbuild — used by tsx and Vite — does NOT honor that flag for
// files loaded across package boundaries via tsconfig paths. esbuild emits
// `Object.defineProperty(this, "x", { value: 0 })`, which creates an own data
// property that shadows the prototype setter. The setter never runs, the
// MapSchema's $childType is never set, and the encoder crashes the first time
// a real client connects with `Cannot read properties of undefined`.
//
// `declare` declarations are erased entirely by both tsc and esbuild — no
// `defineProperty` is emitted — so the constructor-body assignment is the only
// runtime touch of the field, and it correctly invokes the setter.
//
// This must stay this way as long as we use defineTypes() with
// @colyseus/schema. Adding a class field initializer to any Schema subclass
// (e.g. `inputDir = new Vec2()`) will silently break the encoder.

export class Vec2 extends Schema {
  declare x: number;
  declare z: number;
  constructor() {
    super();
    this.x = 0;
    this.z = 0;
  }
}
defineTypes(Vec2, {
  x: "number",
  z: "number",
});

export class Player extends Schema {
  declare sessionId: string;
  declare name: string;
  declare x: number;
  declare y: number;
  declare z: number;
  declare inputDir: Vec2;
  declare lastProcessedInput: number;
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.inputDir = new Vec2();
    this.lastProcessedInput = 0;
  }
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  x: "number",
  y: "number",
  z: "number",
  inputDir: Vec2,
  lastProcessedInput: "uint32",
});

export class Enemy extends Schema {
  // intentionally empty for now; first gameplay PR fills this in.
  // No defineTypes() call — empty schemas have no fields to register.
}

export class RoomState extends Schema {
  declare code: string;
  declare seed: number;
  declare tick: number;
  declare players: MapSchema<Player>;
  declare enemies: MapSchema<Enemy>;
  constructor() {
    super();
    this.code = "";
    this.seed = 0;
    this.tick = 0;
    this.players = new MapSchema<Player>();
    this.enemies = new MapSchema<Enemy>();
  }
}
defineTypes(RoomState, {
  code: "string",
  seed: "uint32",
  tick: "uint32",
  players: { map: Player },
  enemies: { map: Enemy },
});
