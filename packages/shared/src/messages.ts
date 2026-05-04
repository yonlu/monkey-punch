export type InputMessage = {
  type: "input";
  seq: number;
  dir: { x: number; z: number };
};

export type PingMessage = {
  type: "ping";
  t: number;
};

export type ClientMessage = InputMessage | PingMessage;

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
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
