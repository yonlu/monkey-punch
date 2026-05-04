export type InputMessage = {
  type: "input";
  dir: { x: number; z: number };
};

export type ClientMessage = InputMessage;

export const MessageType = {
  Input: "input",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];
