export type InputMessage = {
  type: "input";
  seq: number;                            // monotonic per client (required)
  dir: { x: number; z: number };          // world-space movement direction (client transforms WASD via camera yaw)
  jump: boolean;                          // M7 US-009: true on the input tick the player pressed space (key-down edge, single-tick true)
};

export type PingMessage = {
  type: "ping";
  t: number;
};

export type DebugSpawnMessage = {
  type: "debug_spawn";
  count: number;
  kind?: number;
};

export type DebugClearEnemiesMessage = {
  type: "debug_clear_enemies";
};

export type DebugGrantWeaponMessage = {
  type: "debug_grant_weapon";
  weaponKind: number;
};

export type DebugGrantXpMessage = {
  type: "debug_grant_xp";
  amount: number;
};

export type DebugDamageSelfMessage = {
  type: "debug_damage_self";
  amount: number;            // server clamps to current hp
};

export type LevelUpChoiceMessage = {
  type: "level_up_choice";
  choiceIndex: number; // 0/1/2
};

export type ClientMessage =
  | InputMessage
  | PingMessage
  | DebugSpawnMessage
  | DebugClearEnemiesMessage
  | DebugGrantWeaponMessage
  | DebugGrantXpMessage
  | DebugDamageSelfMessage
  | LevelUpChoiceMessage;

// Server→client one-shot, NOT a ClientMessage variant (rule 3 governs
// client→server only). Documented here so a grep on this file finds the
// shape:
//   pong: { t: number, serverNow: number }
//     t          — echoed from PingMessage.t (drives RTT calculation)
//     serverNow  — server Date.now() at echo (drives serverTimeOffsetMs on
//                  the client; basis for AD1 cross-client projectile sim)
export type PongMessage = {
  type: "pong";
  t: number;
  serverNow: number;
};

// Server→client combat events. Broadcast via room.broadcast(type, payload).
// Not ClientMessage variants. Adding a new event means adding a row in
// MessageType (below) and a type here. The fire-and-hit event protocol is
// the foundation for every future weapon / pickup type — see CLAUDE.md
// rule 12 (added in M4).

// M7 US-013: 3D fire payload. originY is player.y at fire and dirY is the
// Y component of the unit-length 3D direction vector (computed in
// tickWeapons from `enemy.{y} - player.{y}` over the 3D distance). The
// closed-form client sim integrates motion in 3D as
//   pos(t) = (originX + dirX*speed*t, originY + dirY*speed*t, originZ + dirZ*speed*t)
// — straight-line in 3D, no arc and no projectile-gravity (per US-013 AC).
export type FireEvent = {
  type: "fire";
  fireId: number;
  weaponKind: number;
  // M8 US-002: 1-indexed weapon level at fire time. Lifts the M5
  // restriction (weapons.ts comment) that Bolt's visual stats are flat
  // because the client had no level info. Per-level visual scaling now
  // possible (Ahlspiess hitRadius growth in US-004); existing weapons
  // (Bolt) deliberately keep flat visuals.
  weaponLevel: number;
  // M8 US-002: enemy id locked at fire time (-1 = no lock; e.g. facing-mode
  // weapons such as Ahlspiess, or no enemies in range). Powers
  // deterministic homing on the client for Gakkung Bow (US-003) — both
  // server and client home toward the same locked target each tick. Per
  // open-question A3: no re-acquire if the locked target dies; projectile
  // continues on its current heading.
  lockedTargetId: number;
  ownerId: string;
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;             // pre-normalized (3D unit vector)
  dirY: number;             // pre-normalized (3D unit vector)
  dirZ: number;             // pre-normalized (3D unit vector)
  serverTick: number;       // for debugging / correlation
  serverFireTimeMs: number; // server Date.now() at fire (drives client closed-form sim)
};

// M7 US-013: hit events carry the impact position so floating damage
// numbers spawn at the right altitude (the server is the authority on
// where the enemy was when its hp ticked down — clients only have an
// interpolated x/z buffer).
export type HitEvent = {
  type: "hit";
  fireId: number;
  enemyId: number;
  damage: number;
  x: number;
  y: number;
  z: number;
  serverTick: number;
};

export type EnemyDiedEvent = {
  type: "enemy_died";
  enemyId: number;
  x: number;
  z: number;
};

export type GemCollectedEvent = {
  type: "gem_collected";
  gemId: number;
  playerId: string;
  value: number;
};

export type LevelUpOfferedEvent = {
  type: "level_up_offered";
  playerId: string;
  newLevel: number;
  choices: number[];     // length 3, weapon-kind ints (with replacement)
  deadlineTick: number;  // RoomState.tick at which auto-pick fires
};

export type LevelUpResolvedEvent = {
  type: "level_up_resolved";
  playerId: string;
  weaponKind: number;
  newWeaponLevel: number;
  autoPicked: boolean;
};

export type PlayerDamagedEvent = {
  type: "player_damaged";
  playerId: string;
  damage: number;
  x: number;                // player position at hit, for floating-number placement
  y: number;                // M7 US-013: include altitude so the floating number spawns at the player's real Y
  z: number;
  serverTick: number;
};

export type PlayerDownedEvent = {
  type: "player_downed";
  playerId: string;
  serverTick: number;
};

export type RunEndedEvent = {
  type: "run_ended";
  serverTick: number;
};

// M8 US-005: melee_arc swing — emitted once per swing for client VFX (a
// brief slash flash). Damage events for the swing's hits go through the
// existing HitEvent path (one per enemy hit) with fireId=0 (the existing
// "non-projectile" sentinel that orbit hits already use, see rules.ts
// orbit arm). isCrit summarizes whether ANY hit in this swing crit'd —
// drives a brighter/yellower flash on the client. Per-hit crit detail
// rides on the future HitEvent.tag field (US-013).
export type MeleeSwipeEvent = {
  type: "melee_swipe";
  ownerId: string;
  weaponKind: number;
  weaponLevel: number;
  originX: number;
  originY: number;
  originZ: number;
  facingX: number;            // unit-length XZ-plane facing at swing time
  facingZ: number;
  arcAngle: number;
  range: number;
  isCrit: boolean;
  serverTick: number;
  serverSwingTimeMs: number;  // server Date.now() at swing — drives client VFX timing
};

export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
  DebugSpawn: "debug_spawn",
  DebugClearEnemies: "debug_clear_enemies",
  DebugGrantWeapon: "debug_grant_weapon",
  DebugGrantXp: "debug_grant_xp",
  DebugDamageSelf: "debug_damage_self",
  Fire: "fire",
  Hit: "hit",
  EnemyDied: "enemy_died",
  GemCollected: "gem_collected",
  LevelUpChoice: "level_up_choice",
  LevelUpOffered: "level_up_offered",
  LevelUpResolved: "level_up_resolved",
  PlayerDamaged: "player_damaged",
  PlayerDowned: "player_downed",
  RunEnded: "run_ended",
  MeleeSwipe: "melee_swipe",  // M8 US-005
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
