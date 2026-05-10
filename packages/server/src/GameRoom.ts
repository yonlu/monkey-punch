import { Room, Client } from "colyseus";
import {
  Player,
  WeaponState,
  RoomState,
  tickPlayers,
  tickEnemies,
  tickContactDamage,
  tickRunEndCheck,
  tickWeapons,
  tickProjectiles,
  tickGems,
  tickXp,
  tickLevelUpDeadlines,
  tickSpawner,
  resolveLevelUp,
  spawnDebugBurst,
  PROJECTILE_MAX_CAPACITY,
  ENEMY_CONTACT_COOLDOWN_S,
  SIM_DT_S,
  MAX_ENEMIES,
  WEAPON_KINDS,
  PLAYER_MAX_HP,
  PLAYER_NAME_MAX_LEN,
  initTerrain,
  mulberry32,
  type Rng,
  type SpawnerState,
  type Projectile,
  type WeaponContext,
  type ProjectileContext,
  type Emit,
  type CombatEvent,
} from "@mp/shared";
import type {
  InputMessage,
  PingMessage,
  LevelUpChoiceMessage,
  DebugSpawnMessage,
  DebugClearEnemiesMessage,
  DebugGrantWeaponMessage,
  DebugGrantXpMessage,
  DebugDamageSelfMessage,
} from "@mp/shared";
import { generateJoinCode } from "./joinCode.js";
import { clampDirection } from "./input.js";
import {
  createOrbitHitCooldownStore,
  maxOrbitHitCooldownMs,
  type OrbitHitCooldownStore,
} from "./orbitHitCooldown.js";
import {
  createContactCooldownStore,
  type ContactCooldownStore,
} from "./contactCooldown.js";

const TICK_INTERVAL_MS = SIM_DT_S * 1000; // 50 ms — must equal shared SIM_DT_S
const MAX_PLAYERS = 10;
const DEFAULT_RECONNECTION_GRACE_S = 30;
const ALLOW_DEBUG_MESSAGES = true;     // becomes runtime config later
const SNAPSHOT_LOG_INTERVAL_MS = 5_000;
// 100 ticks = 5s at 20Hz. Sweep is a safety net; tryHit/evictEnemy/
// evictPlayer cover the common cases, so this is conservative.
const ORBIT_COOLDOWN_SWEEP_INTERVAL_TICKS = 100;

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
  // M7 US-009: per-tick jump intents. Input handler adds the sessionId of
  // any player whose latest input had jump=true; tickPlayers reads it; the
  // tick() loop clears it after tickPlayers returns. Server-only; not
  // synced. A Set rather than a Map because jump is edge-triggered: at
  // most one intent per player per tick window matters.
  private pendingJumps: Set<string> = new Set();
  private activeProjectiles: Projectile[] = [];
  private nextFireId = 1;
  private nextGemId = 1;
  // Pre-built once in onCreate; closures capture `this` once.
  private weaponCtx!: WeaponContext;
  private projectileCtx!: ProjectileContext;
  private projectileCapacityWarned = false;
  private orbitHitCooldown!: OrbitHitCooldownStore;
  private contactCooldown!: ContactCooldownStore;
  private maxOrbitHitCooldownMs!: number;
  private cooldownSweepCounter = 0;
  // Hoisted so onMessage handlers (e.g. level_up_choice) can share the
  // same emit lambda used by tick(). Assigned in onCreate.
  private emit!: Emit;

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
    this.emit = (e: CombatEvent) => this.broadcast(e.type, e);
    this.rng = mulberry32(state.seed);
    // M7 US-002: terrain noise must be initialized before the first tick
    // calls terrainHeight in tickPlayers. Process-global state in
    // shared/terrain.ts — last room to boot wins, which is fine because
    // all live rooms in this process share one Node module instance and
    // the seed is the same per-room. If we ever host multiple seeds in
    // the same process we'll need per-room noise instances.
    initTerrain(state.seed);
    this.orbitHitCooldown = createOrbitHitCooldownStore();
    this.contactCooldown = createContactCooldownStore();
    this.maxOrbitHitCooldownMs = maxOrbitHitCooldownMs(WEAPON_KINDS);

    this.weaponCtx = {
      nextFireId: () => this.nextFireId++,
      serverNowMs: () => Date.now(),
      pushProjectile: (p) => {
        if (this.activeProjectiles.length >= PROJECTILE_MAX_CAPACITY) {
          if (!this.projectileCapacityWarned) {
            this.projectileCapacityWarned = true;
            console.warn(
              `[room ${this.state.code}] activeProjectiles reached PROJECTILE_MAX_CAPACITY=${PROJECTILE_MAX_CAPACITY} — dropping new projectile`,
            );
          }
          return;
        }
        this.activeProjectiles.push(p);
      },
      nextGemId: () => this.nextGemId++,
      orbitHitCooldown: this.orbitHitCooldown,
    };
    this.projectileCtx = {
      nextGemId: () => this.nextGemId++,
      orbitHitCooldown: this.orbitHitCooldown,
    };

    // The matchmaker's filterBy(["code"]) matches against the room listing's
    // top-level fields, which Colyseus initializes from the CREATING client's
    // options. Since the creating client doesn't know the code yet (we just
    // generated it), we have to write it onto the listing manually so a
    // second client's join({ code }) can find this room. setMetadata only
    // updates listing.metadata, which the matchmaker's driver query does
    // NOT read — it would not be sufficient on its own.
    this.listing.code = code;
    await this.setMetadata({ code, hostName: null });

    this.onMessage<InputMessage>("input", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (player.downed) return;                   // drop silently; do NOT bump lastProcessedInput
      if (this.state.runEnded) return;             // run-end frozen state

      const seq = Number(message?.seq);
      if (!Number.isFinite(seq) || seq <= player.lastProcessedInput) return;

      const dir = clampDirection(Number(message?.dir?.x), Number(message?.dir?.z));
      player.inputDir.x = dir.x;
      player.inputDir.z = dir.z;
      // M7 US-006: facingX/Z is now derived in tickPlayers from inputDir.
      // The handler stays thin per CLAUDE.md rule 4.
      // M7 US-009: jump intent is recorded as a per-tick edge-trigger set
      // entry. tickPlayers decides outcome (grounded check, vy kick).
      // Coerce to boolean — old clients that omit the field land at false.
      if (message?.jump === true) this.pendingJumps.add(client.sessionId);
      player.lastProcessedInput = seq;
    });

    this.onMessage<PingMessage>("ping", (client, message) => {
      const t = Number(message?.t);
      if (!Number.isFinite(t)) return;
      client.send("pong", { type: "pong", t, serverNow: Date.now() });
    });

    this.onMessage<LevelUpChoiceMessage>("level_up_choice", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.pendingLevelUp) return;
      const idx = Number(message?.choiceIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= player.levelUpChoices.length) return;
      const weaponKind = player.levelUpChoices[idx]!;
      resolveLevelUp(player, weaponKind, this.emit, /* autoPicked */ false);
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

      this.onMessage<DebugGrantWeaponMessage>("debug_grant_weapon", (client, message) => {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;
        const kindRaw = Number(message?.weaponKind);
        if (!Number.isFinite(kindRaw) || kindRaw < 0 || kindRaw >= WEAPON_KINDS.length) return;
        const kind = Math.floor(kindRaw);

        const existing = player.weapons.find((w) => w.kind === kind);
        if (existing) {
          const def = WEAPON_KINDS[kind]!;
          existing.level = Math.min(existing.level + 1, def.levels.length);
          return;
        }

        const fresh = new WeaponState();
        fresh.kind = kind;
        fresh.level = 1;
        fresh.cooldownRemaining = 0;
        player.weapons.push(fresh);
      });

      this.onMessage<DebugGrantXpMessage>("debug_grant_xp", (client, message) => {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;
        const raw = Number(message?.amount);
        if (!Number.isFinite(raw) || raw <= 0) return;
        // Cap at 10000 per call to prevent runaway XP from a typo.
        player.xp += Math.min(Math.floor(raw), 10_000);
      });

      this.onMessage<DebugDamageSelfMessage>("debug_damage_self", (client, message) => {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;
        if (player.downed) return;
        const amount = Math.max(1, Math.min(Math.floor(Number(message?.amount) || 0), player.hp));
        player.hp -= amount;
        this.emit({
          type: "player_damaged",
          playerId: client.sessionId,
          damage: amount,
          x: player.x,
          z: player.z,
          serverTick: this.state.tick,
        });
        if (player.hp <= 0 && !player.downed) {
          player.downed = true;
          player.inputDir.x = 0;
          player.inputDir.z = 0;
          this.emit({
            type: "player_downed",
            playerId: client.sessionId,
            serverTick: this.state.tick,
          });
        }
      });
    }

    this.installSnapshotLogger();
    this.setSimulationInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  override async onJoin(client: Client, options: JoinOptions): Promise<void> {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.name =
      ((options?.name ?? "").trim().slice(0, PLAYER_NAME_MAX_LEN) || "Player");
    player.x = 0;
    player.y = 0;
    player.z = 0;
    player.hp = PLAYER_MAX_HP;
    player.maxHp = PLAYER_MAX_HP;
    player.downed = false;
    player.facingX = 0;
    player.facingZ = 1;
    player.kills = 0;
    player.xpGained = 0;
    player.joinTick = this.state.tick;

    const bolt = new WeaponState();
    bolt.kind = 0;
    bolt.level = 1;
    bolt.cooldownRemaining = 0; // AD10: first shot is immediate
    player.weapons.push(bolt);

    this.state.players.set(client.sessionId, player);

    // Listing metadata exposes the host name so the matchmaker's room list
    // shows "hosted by <name>" without exposing schema state. First joiner
    // becomes host (onCreate runs before any onJoin — see AD4 in the spec).
    if ((this.metadata as { hostName?: string | null } | undefined)?.hostName == null) {
      await this.setMetadata({ code: this.state.code, hostName: player.name });
    }
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
      this.orbitHitCooldown.evictPlayer(client.sessionId);
      this.contactCooldown.evictPlayer(client.sessionId);
      this.pendingJumps.delete(client.sessionId);
      await this.rotateHostIfNeeded(player.name);
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
      this.orbitHitCooldown.evictPlayer(client.sessionId);
      this.contactCooldown.evictPlayer(client.sessionId);
      this.pendingJumps.delete(client.sessionId);
      await this.rotateHostIfNeeded(player.name);
    }
  }

  override onDispose(): void {
    if (this.snapshotLogTimer) clearInterval(this.snapshotLogTimer);
  }

  // If the leaving player was the host, promote the next remaining player
  // (deterministic by MapSchema iteration order — insertion order in
  // Colyseus 0.16). If the room is now empty, hostName becomes null.
  // Cosmetic: the matchmaker listing reflects this; nothing in gameplay
  // depends on it. Safe to call even when the leaver was not the host —
  // it no-ops in that case.
  private async rotateHostIfNeeded(leaverName: string): Promise<void> {
    const md = this.metadata as { code?: string; hostName?: string | null } | undefined;
    if (!md || md.hostName !== leaverName) return;
    const next = this.state.players.values().next();
    const nextName: string | null = next.done ? null : (next.value as { name: string }).name;
    await this.setMetadata({ code: this.state.code, hostName: nextName });
  }

  private tick(): void {
    this.state.tick += 1;
    // M6: tickContactDamage after tickEnemies sees fresh positions; tickRunEndCheck
    // immediately after so weapons/projectiles/spawner all observe the post-end
    // state via their `state.runEnded` early-out.
    tickPlayers(this.state, SIM_DT_S, this.pendingJumps);
    // Drain edge-triggered jump intents — outcome decided above; next tick
    // window starts empty. (US-010 will move buffered intent into a
    // schema-tracked window so this drain stays correct.)
    this.pendingJumps.clear();
    tickEnemies(this.state, SIM_DT_S);
    tickContactDamage(this.state, this.contactCooldown, SIM_DT_S, Date.now(), this.emit);
    tickRunEndCheck(this.state, this.emit);
    tickWeapons(this.state, SIM_DT_S, this.weaponCtx, this.emit);
    tickProjectiles(this.state, this.activeProjectiles, SIM_DT_S, this.projectileCtx, this.emit);
    tickGems(this.state, this.emit);
    tickXp(this.state, this.rng, this.emit);
    tickLevelUpDeadlines(this.state, this.emit);
    tickSpawner(this.state, this.spawner, SIM_DT_S, this.rng);

    this.cooldownSweepCounter += 1;
    if (this.cooldownSweepCounter >= ORBIT_COOLDOWN_SWEEP_INTERVAL_TICKS) {
      this.cooldownSweepCounter = 0;
      const now = Date.now();
      this.orbitHitCooldown.sweep(now, this.maxOrbitHitCooldownMs);
      this.contactCooldown.sweep(now, ENEMY_CONTACT_COOLDOWN_S * 1000);
    }
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
