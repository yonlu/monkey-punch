import { Room, Client } from "colyseus";
import { Player, RoomState, tickPlayers } from "@mp/shared";
import type { InputMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";

const TICK_INTERVAL_MS = 50; // 20 Hz
const MAX_PLAYERS = 10;

type JoinOptions = {
  name?: string;
  code?: string;
};

export class GameRoom extends Room<RoomState> {
  override maxClients = MAX_PLAYERS;

  override async onCreate(_options: JoinOptions): Promise<void> {
    const state = new RoomState();
    // Join-code collisions are tolerated. ~31^4 ≈ 1M codes; for friends-only
    // sessions the probability of two concurrent rooms sharing a code is
    // negligible. If it ever happens, the second joiner lands in whichever
    // room the matchmaker returns first — both rooms work, just routed to
    // possibly the wrong friend group. Revisit if collision rate becomes a
    // real complaint.
    const code = generateJoinCode();
    state.code = code;
    state.seed = (Math.random() * 0xffffffff) >>> 0;
    state.tick = 0;
    console.log(`[room ${code}] created seed=${state.seed}`);
    this.setState(state);

    // The matchmaker's filterBy(["code"]) matches against the room listing's
    // top-level fields, which Colyseus initializes from the CREATING client's
    // options. Since the creating client doesn't know the code yet (we just
    // generated it), we have to write it onto the listing manually so a
    // second client's join({ code }) can find this room. setMetadata only
    // updates listing.metadata, which the matchmaker's driver query does
    // NOT read — it would not be sufficient on its own.
    this.listing.code = code;
    // Metadata is still useful for getAvailableRooms() and exposing room
    // info to clients via the matchmaker; keep it in sync.
    await this.setMetadata({ code });

    this.onMessage<InputMessage>("input", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const dir = clampDirection(Number(message?.dir?.x), Number(message?.dir?.z));
      player.inputDir.x = dir.x;
      player.inputDir.z = dir.z;
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
