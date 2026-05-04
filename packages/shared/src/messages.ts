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

export type ClientMessage =
  | InputMessage
  | PingMessage
  | DebugSpawnMessage
  | DebugClearEnemiesMessage;

// Server→client one-shot, NOT a ClientMessage variant (rule 3 governs
// client→server only). Documented here so a grep on this file finds the
// shape:
//   pong: { t: number }   // echoed from PingMessage.t
export type PongMessage = {
  type: "pong";
  t: number;
};

export const MessageType = {
  Input: "input",
  Ping: "ping",
  Pong: "pong",
  DebugSpawn: "debug_spawn",
  DebugClearEnemies: "debug_clear_enemies",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
