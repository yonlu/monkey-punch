import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import { Ground } from "./Ground.js";
import { PlayerCube } from "./PlayerCube.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { attachInput } from "./input.js";

type PlayerEntry = {
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
};

export function GameView({ room }: { room: Room<RoomState> }) {
  const [players, setPlayers] = useState<Map<string, PlayerEntry>>(new Map());
  const [code, setCode] = useState<string>(room.state.code ?? "");

  // The buffer map is mutable across re-renders; we just trigger renders when entries change.
  const buffers = useMemo(() => new Map<string, SnapshotBuffer>(), []);

  useEffect(() => {
    const detachInput = attachInput(room);

    // colyseus.js 0.16 / @colyseus/schema 3.x: listeners live on a callback proxy
    // returned by getStateCallbacks(room), not on the schema instance itself.
    const $ = getStateCallbacks(room);

    const updateCode = () => setCode(room.state.code ?? "");
    $(room.state).listen("code", updateCode);
    updateCode();

    const onAdd = (player: Player, sessionId: string) => {
      let buf = buffers.get(sessionId);
      if (!buf) {
        buf = new SnapshotBuffer();
        buffers.set(sessionId, buf);
      }
      buf.push({ t: performance.now(), x: player.x, z: player.z });

      $(player).onChange(() => {
        buf!.push({ t: performance.now(), x: player.x, z: player.z });
      });

      setPlayers((prev) => {
        const next = new Map(prev);
        next.set(sessionId, { sessionId, name: player.name, buffer: buf! });
        return next;
      });
    };

    const onRemove = (_player: Player, sessionId: string) => {
      buffers.delete(sessionId);
      setPlayers((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    };

    $(room.state).players.onAdd(onAdd);
    $(room.state).players.onRemove(onRemove);

    // Seed any players already present at the moment we attach.
    room.state.players.forEach((p, id) => onAdd(p, id));

    return () => {
      detachInput();
    };
  }, [room, buffers]);

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
          <PlayerCube key={p.sessionId} sessionId={p.sessionId} name={p.name} buffer={p.buffer} />
        ))}
      </Canvas>
    </div>
  );
}
