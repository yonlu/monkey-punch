import { Client, Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "ws://localhost:2567";

export const colyseusClient = new Client(SERVER_URL);

export async function createRoom(name: string): Promise<Room<RoomState>> {
  return colyseusClient.create<RoomState>("game", { name });
}

export async function joinRoom(code: string, name: string): Promise<Room<RoomState>> {
  return colyseusClient.join<RoomState>("game", { code, name });
}
