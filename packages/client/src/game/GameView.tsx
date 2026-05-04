import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type { Enemy, Player, RoomState } from "@mp/shared";
import { Ground } from "./Ground.js";
import { PlayerCube } from "./PlayerCube.js";
import { EnemySwarm } from "./EnemySwarm.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { attachInput } from "./input.js";
import { LocalPredictor } from "../net/prediction.js";
import { hudState } from "../net/hudState.js";
import { DebugHud } from "./DebugHud.js";

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
    const offPong = room.onMessage("pong", (msg: { t: number }) => {
      const rtt = Date.now() - Number(msg.t);
      hudState.pingMs = hudState.pingMs === 0 ? rtt : hudState.pingMs * 0.8 + rtt * 0.2;
    });
    const pingTimer = window.setInterval(() => {
      room.send("ping", { type: "ping", t: Date.now() });
    }, 1000);

    const keyHandler = (e: KeyboardEvent) => {
      if (e.code === "F3") {
        e.preventDefault();
        hudState.visible = !hudState.visible;
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
      window.clearInterval(pingTimer);
      window.removeEventListener("keydown", keyHandler);
      detachInput();
    };
  }, [room, buffers, predictor, enemyBuffers, onUnexpectedLeave]);

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
      </Canvas>
      <DebugHud />
    </div>
  );
}
