import { Room, Client } from "colyseus";
import {
  Player,
  RoomState,
  tickPlayers,
  tickEnemies,
  tickSpawner,
  spawnDebugBurst,
  SIM_DT_S,
  MAX_ENEMIES,
  mulberry32,
  type Rng,
  type SpawnerState,
} from "@mp/shared";
import type {
  InputMessage,
  PingMessage,
  DebugSpawnMessage,
  DebugClearEnemiesMessage,
} from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";

const TICK_INTERVAL_MS = SIM_DT_S * 1000; // 50 ms — must equal shared SIM_DT_S
const MAX_PLAYERS = 10;
const DEFAULT_RECONNECTION_GRACE_S = 30;
const ALLOW_DEBUG_MESSAGES = true;     // becomes runtime config later
const SNAPSHOT_LOG_INTERVAL_MS = 5_000;

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
  // Assigned in onCreate before setSimulationInterval is called; tick()
  // cannot fire until after that, so the definite-assignment assertion
  // is safe.
  private rng!: Rng;
  // SpawnerState is a plain TypeScript object, not a Schema subclass —
  // class field initializer is safe here. The schema.ts landmine
  // (esbuild emitting Object.defineProperty over @colyseus/schema's
  // prototype setters) only affects Schema subclasses.
  private spawner: SpawnerState = { accumulator: 0, nextEnemyId: 1 };

  private snapshotLogTimer: NodeJS.Timeout | null = null;
  private patchByteCount = 0;
  private patchSampleCount = 0;
  private patchInstrumentationFailed = false;

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

    if (ALLOW_DEBUG_MESSAGES) {
      this.onMessage<DebugSpawnMessage>("debug_spawn", (client, message) => {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;

        const requested = Number(message?.count);
        if (!Number.isFinite(requested) || requested <= 0) return;
        // Defense-in-depth: spawnDebugBurst already clamps to remaining
        // capacity (MAX_ENEMIES - state.enemies.size), but we cap here too
        // so a pathologically large `requested` (e.g. 1e9) doesn't pass
        // through to a function that doesn't expect to allocate Infinity.
        const cap = Math.min(Math.floor(requested), MAX_ENEMIES);

        const kindRaw = Number(message?.kind);
        const kind = Number.isFinite(kindRaw) && kindRaw >= 0
          ? Math.floor(kindRaw)
          : 0;

        spawnDebugBurst(this.state, this.spawner, this.rng, player, cap, kind);
      });

      this.onMessage<DebugClearEnemiesMessage>("debug_clear_enemies", () => {
        this.state.enemies.clear();
      });
    }

    this.installSnapshotLogger();
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

  override onDispose(): void {
    if (this.snapshotLogTimer) clearInterval(this.snapshotLogTimer);
  }

  private tick(): void {
    this.state.tick += 1;
    tickPlayers(this.state, SIM_DT_S);
    tickEnemies(this.state, SIM_DT_S);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);
  }

  private installSnapshotLogger(): void {
    // Per-tick byte counting via broadcastPatch override. The exact internal
    // signature varies between Colyseus versions; the try/catch lets a
    // future upgrade fail loudly rather than silently logging zeros.
    try {
      const self = this as unknown as { broadcastPatch?: () => unknown };
      const original = self.broadcastPatch?.bind(this);
      if (typeof original !== "function") {
        throw new Error("Room#broadcastPatch unavailable on this Colyseus version");
      }
      self.broadcastPatch = () => {
        const result = original();
        const len = (result as { length?: number } | undefined)?.length;
        if (typeof len === "number" && Number.isFinite(len)) {
          this.patchByteCount += len;
          this.patchSampleCount += 1;
        } else if (!this.patchInstrumentationFailed) {
          // First call returned something that isn't a buffer — common on
          // Colyseus 0.16 where broadcastPatch returns boolean (hasChanges)
          // rather than the encoded buffer. Mark failed once so the 5s log
          // shows n/a instead of a misleading 0B/tick, and warn once.
          this.patchInstrumentationFailed = true;
          console.warn(
            `[room ${this.state.code}] patch instrumentation produced no measurable bytes (broadcastPatch returned ${typeof result}) — snapshot log will show full-state only`,
          );
        }
        return result;
      };
    } catch (err) {
      this.patchInstrumentationFailed = true;
      console.warn(
        `[room ${this.state.code}] patch instrumentation unavailable: ${
          err instanceof Error ? err.message : String(err)
        } — snapshot log will show full-state only`,
      );
    }

    this.snapshotLogTimer = setInterval(() => {
      const enemies = this.state.enemies.size;
      const players = this.state.players.size;
      const avgPatch = this.patchSampleCount > 0
        ? Math.round(this.patchByteCount / this.patchSampleCount)
        : 0;

      let fullBytes = -1;
      try {
        // Colyseus 0.16: full state lives in _serializer.getFullState().
        // Older/newer fallback: state.encodeAll() may exist on some versions.
        const serializer = (this as unknown as { _serializer?: { getFullState?: (c: null) => { length?: number } | undefined } })._serializer;
        const buf = serializer?.getFullState?.(null)
          ?? (this.state as unknown as { encodeAll?: () => Uint8Array }).encodeAll?.call(this.state);
        if (buf?.length != null) fullBytes = buf.length;
      } catch (err) {
        console.warn(
          `[room ${this.state.code}] full-state encode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const patchStr = this.patchInstrumentationFailed ? "n/a" : `${avgPatch}B/tick`;
      const fullStr = fullBytes >= 0 ? `${fullBytes}B` : "n/a";
      console.log(
        `[room ${this.state.code}] snapshot avg=${patchStr} full=${fullStr} enemies=${enemies} players=${players}`,
      );

      this.patchByteCount = 0;
      this.patchSampleCount = 0;
    }, SNAPSHOT_LOG_INTERVAL_MS);
  }
}
