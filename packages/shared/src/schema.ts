import { Schema, MapSchema, ArraySchema, defineTypes } from "@colyseus/schema";
import { PLAYER_MAX_HP } from "./constants.js";

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

export class WeaponState extends Schema {
  declare kind: number;
  declare level: number;
  declare cooldownRemaining: number;
  constructor() {
    super();
    this.kind = 0;
    this.level = 0;
    this.cooldownRemaining = 0;
  }
}
defineTypes(WeaponState, {
  kind: "uint8",
  level: "uint8",
  cooldownRemaining: "number",
});

export class Player extends Schema {
  declare sessionId: string;
  declare name: string;
  declare x: number;
  declare y: number;
  declare z: number;
  declare vy: number;
  declare grounded: boolean;
  // M7 US-010: jump forgiveness windows.
  //   lastGroundedAt — server tick at which `grounded` was last true. Read by
  //     `canJump` to decide if a coyote-time jump is still allowed. Always
  //     non-negative (initialized to 0 on construction; updated by tickPlayers
  //     to state.tick on any tick the player is grounded at end of phase 2).
  //   jumpBufferedAt — server tick at which the player pressed jump while NOT
  //     `canJump`. -1 sentinel means "no pending press". When the player
  //     becomes canJump within JUMP_BUFFER seconds of this tick, the buffered
  //     press fires automatically and this field is reset to -1. Encoded as
  //     int32 because of the -1 sentinel.
  declare lastGroundedAt: number;
  declare jumpBufferedAt: number;
  declare inputDir: Vec2;
  declare lastProcessedInput: number;
  declare xp: number;
  declare level: number;
  declare weapons: ArraySchema<WeaponState>;
  declare pendingLevelUp: boolean;
  declare levelUpChoices: ArraySchema<number>;
  declare levelUpDeadlineTick: number;
  declare hp: number;
  declare maxHp: number;
  declare downed: boolean;
  declare facingX: number;
  declare facingZ: number;
  declare kills: number;
  declare xpGained: number;
  declare joinTick: number;
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.vy = 0;
    this.grounded = true;
    this.lastGroundedAt = 0;
    this.jumpBufferedAt = -1;
    this.inputDir = new Vec2();
    this.lastProcessedInput = 0;
    this.xp = 0;
    this.level = 1;
    this.weapons = new ArraySchema<WeaponState>();
    this.pendingLevelUp = false;
    this.levelUpChoices = new ArraySchema<number>();
    this.levelUpDeadlineTick = 0;
    this.hp = PLAYER_MAX_HP;
    this.maxHp = PLAYER_MAX_HP;
    this.downed = false;
    this.facingX = 0;
    this.facingZ = 1;
    this.kills = 0;
    this.xpGained = 0;
    this.joinTick = 0;
  }
}
defineTypes(Player, {
  sessionId: "string",
  name: "string",
  x: "number",
  y: "number",
  z: "number",
  vy: "number",
  grounded: "boolean",
  lastGroundedAt: "uint32",
  jumpBufferedAt: "int32",
  inputDir: Vec2,
  lastProcessedInput: "uint32",
  xp: "uint32",
  level: "uint8",
  weapons: [WeaponState],
  pendingLevelUp: "boolean",
  levelUpChoices: [ "uint8" ],
  levelUpDeadlineTick: "uint32",
  hp: "uint16",
  maxHp: "uint16",
  downed: "boolean",
  facingX: "number",
  facingZ: "number",
  kills: "uint32",
  xpGained: "uint32",
  joinTick: "uint32",
});

export class Enemy extends Schema {
  declare id: number;
  declare kind: number;
  declare x: number;
  // M7 US-012: enemies snap to terrain. Enemies have no vy and do not
  // jump (per PRD § US-010 in tasks/prd-m7-verticality.md): tickEnemies
  // simply assigns `y = terrainHeight(x, z) + ENEMY_GROUND_OFFSET` after
  // X/Z integration.
  declare y: number;
  declare z: number;
  declare hp: number;
  // M8 US-009: status effects (single-effect shape, slow only). Per
  // CLAUDE.md "Status effects scale to two kinds, not three" — a third
  // effect kind requires refactoring to ArraySchema<StatusEffect>.
  //
  //   slowMultiplier — current movement-speed multiplier. 1.0 = full
  //     speed. <1 = slowed (Kronos uses 0.6 → 0.4 across L1–L5).
  //   slowExpiresAt — server tick at which the slow expires. -1 sentinel
  //     means "no slow active." Encoded as int32 because of the -1
  //     sentinel — same pattern Player.jumpBufferedAt uses.
  declare slowMultiplier: number;
  declare slowExpiresAt: number;
  constructor() {
    super();
    this.id = 0;
    this.kind = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.hp = 0;
    this.slowMultiplier = 1;
    this.slowExpiresAt = -1;
  }
}
defineTypes(Enemy, {
  id: "uint32",
  kind: "uint8",
  x: "number",
  y: "number",
  z: "number",
  hp: "uint16",
  slowMultiplier: "number",
  slowExpiresAt: "int32",
});

// M8 US-011: blood pool — ground decal that DoTs enemies. Spawned along
// the outbound path of a Bloody Axe at L3+. Server-only state for the
// per-pool-per-enemy DoT cooldown lives off-schema (BloodPoolHitCooldown
// in server/src/, parallel to OrbitHitCooldown). Per-pool damage and
// tickIntervalMs are baked at spawn so a mid-flight level-up of Bloody
// Axe doesn't retroactively change pool damage — same single-writer-at-
// spawn pattern that Projectile uses for damage/speed/lifetime.
export class BloodPool extends Schema {
  declare id: number;
  declare x: number;
  declare z: number;
  declare expiresAt: number;       // server tick at which the pool despawns
  declare ownerId: string;
  declare weaponKind: number;       // for future per-weapon pool VFX (a different aura-based weapon could use a blue pool)
  declare damagePerTick: number;
  declare tickIntervalMs: number;
  constructor() {
    super();
    this.id = 0;
    this.x = 0;
    this.z = 0;
    this.expiresAt = 0;
    this.ownerId = "";
    this.weaponKind = 0;
    this.damagePerTick = 0;
    this.tickIntervalMs = 300;
  }
}
defineTypes(BloodPool, {
  id: "uint32",
  x: "number",
  z: "number",
  expiresAt: "uint32",
  ownerId: "string",
  weaponKind: "uint8",
  damagePerTick: "uint16",
  tickIntervalMs: "uint16",
});

export class Gem extends Schema {
  declare id: number;
  declare x: number;
  declare z: number;
  declare value: number;
  constructor() {
    super();
    this.id = 0;
    this.x = 0;
    this.z = 0;
    this.value = 0;
  }
}
defineTypes(Gem, {
  id: "uint32",
  x: "number",
  z: "number",
  value: "uint16",
});

export class RoomState extends Schema {
  declare code: string;
  declare seed: number;
  declare tick: number;
  declare players: MapSchema<Player>;
  declare enemies: MapSchema<Enemy>;
  declare gems: MapSchema<Gem>;
  // M8 US-011: blood pools spawned by Bloody Axe at L3+. Synced to
  // clients so all viewers see the same pools at the same positions.
  declare bloodPools: MapSchema<BloodPool>;
  declare runEnded: boolean;
  declare runEndedTick: number;
  constructor() {
    super();
    this.code = "";
    this.seed = 0;
    this.tick = 0;
    this.players = new MapSchema<Player>();
    this.enemies = new MapSchema<Enemy>();
    this.gems = new MapSchema<Gem>();
    this.bloodPools = new MapSchema<BloodPool>();
    this.runEnded = false;
    this.runEndedTick = 0;
  }
}
defineTypes(RoomState, {
  code: "string",
  seed: "uint32",
  tick: "uint32",
  players: { map: Player },
  enemies: { map: Enemy },
  gems: { map: Gem },
  bloodPools: { map: BloodPool },
  runEnded: "boolean",
  runEndedTick: "uint32",
});
