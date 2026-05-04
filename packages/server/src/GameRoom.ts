import { Room, Client } from "colyseus";
import { Player, RoomState, tickPlayers } from "@mp/shared";
import type { InputMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";

const TICK_INTERVAL_MS = 50; // 20 Hz
const MAX_PLAYERS = 10;

type JoinOptions = {
  name?: string;
  code?: string;
};

export class GameRoom extends Room<RoomState> {
  override maxClients = MAX_PLAYERS;

  override onCreate(_options: JoinOptions): void {
    const state = new RoomState();
    const code = generateJoinCode();
    state.code = code;
    state.seed = (Math.random() * 0xffffffff) >>> 0;
    state.tick = 0;
    this.setState(state);

    // setMetadata is what filterBy(["code"]) actually filters against; state.code is for
    // the client UI to display. Both writes are required.
    this.setMetadata({ code });

    this.onMessage<InputMessage>("input", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const dx = Number(message?.dir?.x);
      const dz = Number(message?.dir?.z);
      if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
      const len = Math.hypot(dx, dz);
      const scale = len > 1 ? 1 / len : 1;
      player.inputDir.x = dx * scale;
      player.inputDir.z = dz * scale;
    });

    this.setSimulationInterval((dt) => this.tick(dt), TICK_INTERVAL_MS);
  }

  override onJoin(client: Client, options: JoinOptions): void {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = (options?.name ?? "Anon").slice(0, 24);
    player.x = 0;
    player.y = 0;
    player.z = 0;
    this.state.players.set(client.sessionId, player);
  }

  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
  }

  private tick(dtMs: number): void {
    this.state.tick += 1;
    tickPlayers(this.state, dtMs / 1000);
  }
}
