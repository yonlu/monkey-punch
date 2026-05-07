import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type {
  Enemy,
  EnemyDiedEvent,
  FireEvent,
  GemCollectedEvent,
  HitEvent,
  Player,
  PongMessage,
  RoomState,
} from "@mp/shared";
import { WEAPON_KINDS, statsAt, isProjectileWeapon } from "@mp/shared";
import { Ground } from "./Ground.js";
import { PlayerCube } from "./PlayerCube.js";
import { EnemySwarm } from "./EnemySwarm.js";
import { OrbitSwarm } from "./OrbitSwarm.js";
import { ProjectileSwarm } from "./ProjectileSwarm.js";
import { GemSwarm } from "./GemSwarm.js";
import { PlayerHud } from "./PlayerHud.js";
import { LevelUpOverlay } from "./LevelUpOverlay.js";
import { LevelUpFlashVfx } from "./LevelUpFlashVfx.js";
import { useCombatVfxRef } from "./CombatVfx.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { ServerTime } from "../net/serverTime.js";
import { attachInput } from "./input.js";
import { LocalPredictor } from "../net/prediction.js";
import { hudState } from "../net/hudState.js";
import { DebugHud } from "./DebugHud.js";

// Extra time (past the rendered hit moment) that a projectile keeps
// rendering after the server reports a hit. Lets the projectile visibly
// pass through the enemy rather than vanishing at the contact edge.
// At Bolt's 18 u/s, 100 ms ≈ 1.8 units of overshoot, roughly the sum of
// enemy + projectile diameters.
const PROJECTILE_HIT_LINGER_MS = 100;

type PlayerEntry = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
};

export function GameView({
  room,
  onUnexpectedLeave,
}: {
  room: Room<RoomState>;
  onUnexpectedLeave: () => void;
}) {
  const [players, setPlayers] = useState<Map<string, PlayerEntry>>(new Map());
  const [code, setCode] = useState<string>(room.state.code ?? "");

  const enemyBuffers = useMemo(() => new Map<number, SnapshotBuffer>(), []);
  const [enemyIds, setEnemyIds] = useState<Set<number>>(new Set());

  const buffers = useMemo(() => new Map<string, SnapshotBuffer>(), []);
  const predictor = useMemo(() => new LocalPredictor(), []);
  const serverTime = useMemo(() => new ServerTime(), []);
  const fires = useMemo(() => new Map<number, FireEvent>(), []);
  const { api: vfx, component: vfxJsx } = useCombatVfxRef();

  useEffect(() => {
    const detachInput = attachInput(room, predictor);

    const $ = getStateCallbacks(room);

    const updateCode = () => setCode(room.state.code ?? "");
    const offCode = $(room.state).listen("code", updateCode);
    updateCode();

    let snapshotsThisSec = 0;
    let lastSecMs = performance.now();
    const offTick = $(room.state).listen("tick", (value) => {
      hudState.serverTick = Number(value);
      snapshotsThisSec += 1;
      const now = performance.now();
      if (now - lastSecMs >= 1000) {
        hudState.snapshotsPerSec = snapshotsThisSec * (1000 / (now - lastSecMs));
        snapshotsThisSec = 0;
        lastSecMs = now;
      }
    });

    const perPlayerDisposers = new Map<string, () => void>();

    const onAdd = (player: Player, sessionId: string) => {
      let buf = buffers.get(sessionId);
      if (!buf) {
        buf = new SnapshotBuffer();
        buffers.set(sessionId, buf);
      }
      buf.push({ t: performance.now(), x: player.x, z: player.z });

      const existing = perPlayerDisposers.get(sessionId);
      if (existing) existing();

      const offChange = $(player).onChange(() => {
        if (sessionId === room.sessionId) {
          predictor.reconcile(player.x, player.z, player.lastProcessedInput);
          hudState.reconErr = predictor.lastReconErr;
          hudState.xp = player.xp;
          const w = player.weapons[0];
          if (w) {
            const def = WEAPON_KINDS[w.kind];
            if (def && isProjectileWeapon(def)) {
              const stats = statsAt(def, w.level);
              hudState.cooldownFrac = 1 - Math.max(0, Math.min(1, w.cooldownRemaining / stats.cooldown));
            } else {
              hudState.cooldownFrac = 1;
            }
          }
        } else {
          buf!.push({ t: performance.now(), x: player.x, z: player.z });
        }
      });
      perPlayerDisposers.set(sessionId, offChange);

      setPlayers((prev) => {
        const next = new Map(prev);
        next.set(sessionId, { sessionId, name: player.name, buffer: buf! });
        return next;
      });
      hudState.playerCount = buffers.size;
    };

    const onRemove = (_player: Player, sessionId: string) => {
      const off = perPlayerDisposers.get(sessionId);
      if (off) {
        off();
        perPlayerDisposers.delete(sessionId);
      }
      buffers.delete(sessionId);
      setPlayers((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      hudState.playerCount = buffers.size;
    };

    const offAdd = $(room.state).players.onAdd(onAdd);
    const offRemove = $(room.state).players.onRemove(onRemove);

    room.state.players.forEach((p, id) => onAdd(p, id));

    const perEnemyDisposers = new Map<number, () => void>();

    const onEnemyAdd = (enemy: Enemy, key: string) => {
      const id = Number(key);
      let buf = enemyBuffers.get(id);
      if (!buf) {
        buf = new SnapshotBuffer();
        enemyBuffers.set(id, buf);
      }
      buf.push({ t: performance.now(), x: enemy.x, z: enemy.z });

      const existing = perEnemyDisposers.get(id);
      if (existing) existing();

      const offChange = $(enemy).onChange(() => {
        buf!.push({ t: performance.now(), x: enemy.x, z: enemy.z });
      });
      perEnemyDisposers.set(id, offChange);

      setEnemyIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      hudState.enemyCount = enemyBuffers.size;
    };

    const onEnemyRemove = (_enemy: Enemy, key: string) => {
      const id = Number(key);
      const off = perEnemyDisposers.get(id);
      if (off) {
        off();
        perEnemyDisposers.delete(id);
      }
      enemyBuffers.delete(id);
      setEnemyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      hudState.enemyCount = enemyBuffers.size;
    };

    const offEnemyAdd = $(room.state).enemies.onAdd(onEnemyAdd);
    const offEnemyRemove = $(room.state).enemies.onRemove(onEnemyRemove);

    room.state.enemies.forEach((e, key) => onEnemyAdd(e, key));

    const leaveHandler = (closeCode: number) => {
      if (closeCode !== 1000) onUnexpectedLeave();
    };
    room.onLeave(leaveHandler);

    // Ping/pong RTT for the HUD.
    const offPong = room.onMessage("pong", (msg: PongMessage) => {
      const t = Number(msg?.t);
      const rtt = Date.now() - t;
      if (Number.isFinite(rtt)) {
        hudState.pingMs = hudState.pingMs === 0 ? rtt : hudState.pingMs * 0.8 + rtt * 0.2;
      }
      const sn = Number(msg?.serverNow);
      if (Number.isFinite(sn) && Number.isFinite(rtt)) {
        serverTime.observe(sn, rtt / 2);
        hudState.serverTimeOffsetMs = serverTime.offsetMs;
      }
    });
    // Fire-and-hit event protocol — see CLAUDE.md rule 12.
    const fireTimers = new Map<number, ReturnType<typeof setTimeout>>();

    const offFire = room.onMessage("fire", (msg: FireEvent) => {
      fires.set(msg.fireId, msg);
      // Schedule cleanup at lifetime + a small grace; ProjectileSwarm has
      // a backstop, but the per-fire timer is the primary driver and fires
      // the moment the projectile expires — so the visible count drops in
      // lockstep with reality.
      //
      // Adding `interpDelayMs` to the timeout aligns the cleanup with
      // rendered time: the projectile is rendered at serverNow() -
      // interpDelayMs, so the rendered projectile reaches `lifetime` at
      // real time T_fire + lifetime + interpDelayMs.
      const def = WEAPON_KINDS[msg.weaponKind];
      const lifetimeMs =
        def && isProjectileWeapon(def)
          ? statsAt(def, 1).projectileLifetime * 1000
          : 800;
      const timer = setTimeout(() => {
        fires.delete(msg.fireId);
        fireTimers.delete(msg.fireId);
      }, lifetimeMs + 50 + hudState.interpDelayMs);
      fireTimers.set(msg.fireId, timer);
    });

    const offHit = room.onMessage("hit", (msg: HitEvent) => {
      // fireId === 0 is the sentinel for orbit hits (no projectile to
      // despawn). Skip the projectile-cleanup path entirely.
      if (msg.fireId !== 0) {
        // Defer the visual despawn so the projectile (a) disappears at or
        // after the moment the *rendered* enemy is hit (since the client
        // renders at serverNow() - interpDelayMs, the hit message arrives
        // ~interpDelayMs ahead of the rendered hit), and (b) "lives a
        // little more" past the hit moment so it visibly passes through
        // the enemy rather than vanishing right at the contact edge.
        //
        // Total deferral = interpDelayMs (re-align with render time) +
        // PROJECTILE_HIT_LINGER_MS (overshoot past the hit point). At
        // Bolt's speed of 18 u/s, 100ms of overshoot ≈ 1.8 units, which
        // is roughly enemyDiameter (1.0) + projectileDiameter (0.8), so
        // the projectile clears the enemy before it disappears.
        const fireId = msg.fireId;
        const lifetimeTimer = fireTimers.get(fireId);
        if (lifetimeTimer) clearTimeout(lifetimeTimer);
        fireTimers.delete(fireId);
        const hitTimer = setTimeout(() => {
          fires.delete(fireId);
        }, hudState.interpDelayMs + PROJECTILE_HIT_LINGER_MS);
        // Track the deferred-delete timer in the same map so unmount
        // cleanup cancels it.
        fireTimers.set(fireId, hitTimer);
      }
      // Hit flash at the rendered enemy position — same time-base as the
      // projectile (interpDelayMs behind realtime), so the flash lands where
      // the projectile despawns.
      const buf = enemyBuffers.get(msg.enemyId);
      const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
      if (sample) vfx.pushHit(sample.x, sample.z);
    });

    const offDied = room.onMessage("enemy_died", (msg: EnemyDiedEvent) => {
      vfx.pushDeath(msg.x, msg.z);
    });

    const offCollected = room.onMessage("gem_collected", (msg: GemCollectedEvent) => {
      // Pickup pulse at the collecting player's rendered position. For the
      // local player, use the predictor's predicted position; for remote
      // players, use the interpolated buffer.
      if (msg.playerId === room.sessionId) {
        vfx.pushPickup(predictor.predictedX, predictor.predictedZ);
      } else {
        const sample = buffers.get(msg.playerId)?.sample(performance.now() - hudState.interpDelayMs);
        if (sample) vfx.pushPickup(sample.x, sample.z);
      }
    });

    const pingTimer = window.setInterval(() => {
      room.send("ping", { type: "ping", t: Date.now() });
    }, 1000);

    const keyHandler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "F3") {
        e.preventDefault();
        hudState.visible = !hudState.visible;
        return;
      }
      if (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3") {
        const localPlayer = room.state.players.get(room.sessionId);
        if (localPlayer?.pendingLevelUp && localPlayer.levelUpChoices.length > 0) {
          e.preventDefault();
          const idx = e.code === "Digit1" ? 0 : e.code === "Digit2" ? 1 : 2;
          if (idx < localPlayer.levelUpChoices.length) {
            room.send("level_up_choice", { type: "level_up_choice", choiceIndex: idx });
          }
        }
        return;
      }
      if (!hudState.visible) return;

      if (e.code === "BracketRight" && !e.shiftKey) {
        e.preventDefault();
        room.send("debug_spawn", { type: "debug_spawn", count: 10 });
      } else if (e.code === "BracketRight" && e.shiftKey) {
        e.preventDefault();
        room.send("debug_spawn", { type: "debug_spawn", count: 100 });
      } else if (e.code === "Backslash") {
        e.preventDefault();
        room.send("debug_clear_enemies", { type: "debug_clear_enemies" });
      } else if (e.code === "KeyG" && e.shiftKey) {
        e.preventDefault();
        // Orbit is index 1 in WEAPON_KINDS. Granting at L1, or upgrading +1.
        room.send("debug_grant_weapon", { type: "debug_grant_weapon", weaponKind: 1 });
      } else if (e.code === "KeyX" && e.shiftKey) {
        e.preventDefault();
        // Push 100 XP into the player so the next tickXp triggers a level-up.
        // Server caps amount at 10_000 per call.
        room.send("debug_grant_xp", { type: "debug_grant_xp", amount: 100 });
      }
    };
    window.addEventListener("keydown", keyHandler);

    return () => {
      offCode();
      offTick();
      offAdd();
      offRemove();
      room.onLeave.remove(leaveHandler);
      perPlayerDisposers.forEach((off) => off());
      perPlayerDisposers.clear();
      buffers.clear();
      offEnemyAdd();
      offEnemyRemove();
      perEnemyDisposers.forEach((off) => off());
      perEnemyDisposers.clear();
      enemyBuffers.clear();
      offPong();
      offFire();
      offHit();
      offDied();
      offCollected();
      fireTimers.forEach((t) => clearTimeout(t));
      fireTimers.clear();
      fires.clear();
      window.clearInterval(pingTimer);
      window.removeEventListener("keydown", keyHandler);
      detachInput();
    };
  }, [room, buffers, predictor, enemyBuffers, serverTime, fires, vfx, onUnexpectedLeave]);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <div className="banner">room: <strong>{code}</strong> · share this code with friends</div>
      <Canvas
        shadows
        camera={{ position: [0, 12, 12], fov: 55 }}
        style={{ width: "100%", height: "100%" }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 5]} intensity={1.0} castShadow />
        <Ground />
        {Array.from(players.values()).map((p) => (
          <PlayerCube
            key={p.sessionId}
            sessionId={p.sessionId}
            name={p.name}
            buffer={p.buffer}
            predictor={p.sessionId === room.sessionId ? predictor : undefined}
          />
        ))}
        <EnemySwarm enemyIds={enemyIds} buffers={enemyBuffers} />
        <OrbitSwarm room={room} predictor={predictor} buffers={buffers} serverTime={serverTime} />
        <LevelUpFlashVfx room={room} predictor={predictor} buffers={buffers} />
        <ProjectileSwarm fires={fires} serverTime={serverTime} />
        <GemSwarm room={room} />
        {vfxJsx}
      </Canvas>
      <PlayerHud room={room} />
      <LevelUpOverlay room={room} />
      <DebugHud />
    </div>
  );
}
