import { Room, Client } from "colyseus";
import { Player, RoomState, tickPlayers } from "@mp/shared";
import type { InputMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";

const TICK_INTERVAL_MS = 50;            // 20 Hz
const SIM_DT_S = TICK_INTERVAL_MS / 1000; // fixed 0.05s per tick — see AD1
const MAX_PLAYERS = 10;

type JoinOptions = {
  name?: string;
  code?: string;
};

export class GameRoom extends Room<RoomState> {
  override maxClients = MAX_PLAYERS;

  override async onCreate(_options: JoinOptions): Promise<void> {
    const state = new RoomState();
    const code = generateJoinCode();
    state.code = code;
    state.seed = (Math.random() * 0xffffffff) >>> 0;
    state.tick = 0;
    console.log(`[room ${code}] created seed=${state.seed}`);
    this.setState(state);

    this.listing.code = code;
    await this.setMetadata({ code });

    this.onMessage<InputMessage>("input", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const seq = Number(message?.seq);
      if (!Number.isFinite(seq) || seq <= player.lastProcessedInput) {
        // Stale or replayed input — drop silently.
        return;
      }

      const dir = clampDirection(Number(message?.dir?.x), Number(message?.dir?.z));
      player.inputDir.x = dir.x;
      player.inputDir.z = dir.z;
      player.lastProcessedInput = seq;
    });

    this.setSimulationInterval(() => this.tick(), TICK_INTERVAL_MS);
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

  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S);
  }
}
