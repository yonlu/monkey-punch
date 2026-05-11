import { Client, Room } from "@colyseus/sdk";
import type { RoomState } from "@mp/shared";

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "ws://localhost:2567";

export const colyseusClient = new Client(SERVER_URL);

export async function waitForCode(room: Room<RoomState>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!room.state.code) {
    if (Date.now() - start > timeoutMs) {
      await room.leave().catch(() => {});
      throw new Error("server did not sync room code within timeout");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function createRoom(name: string): Promise<Room<RoomState>> {
  const room = await colyseusClient.create<RoomState>("game", { name });
  await waitForCode(room);
  return room;
}

export async function joinRoom(code: string, name: string): Promise<Room<RoomState>> {
  const room = await colyseusClient.join<RoomState>("game", { code, name });
  await waitForCode(room);
  return room;
}
