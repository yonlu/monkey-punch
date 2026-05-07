export type InputMessage = {
  type: "input";
  seq: number;                            // monotonic per client (required)
  dir: { x: number; z: number };
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

export type FireEvent = {
  type: "fire";
  fireId: number;
  weaponKind: number;
  ownerId: string;
  originX: number;
  originZ: number;
  dirX: number;             // pre-normalized
  dirZ: number;             // pre-normalized
  serverTick: number;       // for debugging / correlation
  serverFireTimeMs: number; // server Date.now() at fire (drives client closed-form sim)
};

export type HitEvent = {
  type: "hit";
  fireId: number;
  enemyId: number;
  damage: number;
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

export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
  DebugSpawn: "debug_spawn",
  DebugClearEnemies: "debug_clear_enemies",
  DebugGrantWeapon: "debug_grant_weapon",
  DebugGrantXp: "debug_grant_xp",
  Fire: "fire",
  Hit: "hit",
  EnemyDied: "enemy_died",
  GemCollected: "gem_collected",
  LevelUpChoice: "level_up_choice",
  LevelUpOffered: "level_up_offered",
  LevelUpResolved: "level_up_resolved",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
