import { Room, Client } from "colyseus";
import {
  Player,
  RoomState,
  tickPlayers,
  tickEnemies,
  tickSpawner,
  SIM_DT_S,
  mulberry32,
  type Rng,
  type SpawnerState,
} from "@mp/shared";
import type { InputMessage, PingMessage } from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";

const TICK_INTERVAL_MS = SIM_DT_S * 1000; // 50 ms — must equal shared SIM_DT_S
const MAX_PLAYERS = 10;
const DEFAULT_RECONNECTION_GRACE_S = 30;

// MP_RECONNECTION_GRACE_S overrides the grace window in seconds. Tests set
// it to "1" so reconnect.test.ts runs in ~1.5s instead of ~31s. Anything
// that doesn't parse to a finite, positive number falls back to the
// production default — guards against typos like `MP_RECONNECTION_GRACE_S=foo`
// silently collapsing the window to ~1ms via setTimeout(NaN * 1000).
function parseGraceSeconds(): number {
  const raw = Number(process.env.MP_RECONNECTION_GRACE_S);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECONNECTION_GRACE_S;
}

type JoinOptions = {
  name?: string;
  code?: string;
};

export class GameRoom extends Room<RoomState> {
  override maxClients = MAX_PLAYERS;
  private rng!: Rng;
  private spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };

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
    this.rng = mulberry32(state.seed);

    // The matchmaker's filterBy(["code"]) matches against the room listing's
    // top-level fields, which Colyseus initializes from the CREATING client's
    // options. Since the creating client doesn't know the code yet (we just
    // generated it), we have to write it onto the listing manually so a
    // second client's join({ code }) can find this room. setMetadata only
    // updates listing.metadata, which the matchmaker's driver query does
    // NOT read — it would not be sufficient on its own.
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

    this.onMessage<PingMessage>("ping", (client, message) => {
      const t = Number(message?.t);
      if (!Number.isFinite(t)) return;
      client.send("pong", { type: "pong", t });
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

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Stop drift while the client is gone — the last-known inputDir would
    // otherwise keep being integrated each tick.
    player.inputDir.x = 0;
    player.inputDir.z = 0;

    if (consented) {
      this.state.players.delete(client.sessionId);
      return;
    }

    try {
      const graceS = parseGraceSeconds();
      await this.allowReconnection(client, graceS);
      // Reconnected. Same sessionId, same Player schema. Nothing else to do.
    } catch (err) {
      console.log(
        `[room ${this.state.code}] reconnect grace ended for ${client.sessionId}: ${err === false ? "timeout" : err}`,
      );
      this.state.players.delete(client.sessionId);
    }
  }

  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S);
    tickEnemies(this.state, SIM_DT_S);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
  }
}
