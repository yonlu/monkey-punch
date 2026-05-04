import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Landing } from "./Landing.js";
import { GameView } from "./game/GameView.js";

export function App() {
  const [room, setRoom] = useState<Room<RoomState> | null>(null);

  if (!room) return <Landing onJoined={setRoom} />;
  return <GameView room={room} />;
}
