import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Mesh, Group } from "three";
import type { Room } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import { PLAYER_SPEED } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import {
  STEP_INTERVAL_MS,
  SMOOTHING_TAU_S,
  type LocalPredictor,
} from "../net/prediction.js";
import { getLiveInputDir, getLiveFacing } from "./input.js";
import { useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

const STEP_INTERVAL_S = STEP_INTERVAL_MS / 1000;
const RENDER_Y = 0.5;
const DOWN_COLOR = "#6a6a6a";

function colorFor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function localPlayerRenderPos(predictor: LocalPredictor, delta: number): { x: number; z: number } {
  const decay = Math.exp(-delta / SMOOTHING_TAU_S);
  predictor.renderOffset.x *= decay;
  predictor.renderOffset.z *= decay;
  const tSinceStep = Math.min((performance.now() - predictor.lastStepTime) / 1000, STEP_INTERVAL_S);
  const liveDir = getLiveInputDir();
  if (!Number.isNaN(predictor.lastLiveDirX)) {
    const jumpX = (liveDir.x - predictor.lastLiveDirX) * PLAYER_SPEED * tSinceStep;
    const jumpZ = (liveDir.z - predictor.lastLiveDirZ) * PLAYER_SPEED * tSinceStep;
    predictor.renderOffset.x -= jumpX;
    predictor.renderOffset.z -= jumpZ;
  }
  predictor.lastLiveDirX = liveDir.x;
  predictor.lastLiveDirZ = liveDir.z;
  return {
    x: predictor.predictedX + liveDir.x * PLAYER_SPEED * tSinceStep + predictor.renderOffset.x,
    z: predictor.predictedZ + liveDir.z * PLAYER_SPEED * tSinceStep + predictor.renderOffset.z,
  };
}

export type PlayerCubeProps = {
  room: Room<RoomState>;
  sessionId: string;
  name: string;
  buffer: SnapshotBuffer;
  predictor?: LocalPredictor;
};

export function PlayerCube({ room, sessionId, name, buffer, predictor }: PlayerCubeProps) {
  const groupRef = useRef<Group>(null);
  const cubeRef = useRef<Mesh>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const baseColor = useMemo(() => colorFor(sessionId), [sessionId]);

  const [hp, setHp] = useState<number>(100);
  const [maxHp, setMaxHp] = useState<number>(100);
  const [downed, setDowned] = useState<boolean>(false);

  useEffect(() => {
    const player = room.state.players.get(sessionId);
    if (!player) return;
    setHp(player.hp);
    setMaxHp(player.maxHp);
    setDowned(player.downed);
    // The change listener already wired by GameView covers per-player updates;
    // we read fresh values from `room.state.players` in useFrame below to stay
    // in sync without coupling another listener here.
  }, [room, sessionId]);

  useFrame((_, delta) => {
    if (!groupRef.current || !cubeRef.current) return;

    const player = room.state.players.get(sessionId);
    const isDowned = !!player?.downed;
    if (isDowned !== downed) setDowned(isDowned);
    if (player) {
      if (player.hp !== hp) setHp(player.hp);
      if (player.maxHp !== maxHp) setMaxHp(player.maxHp);
    }

    let posX: number, posZ: number;
    if (predictor) {
      const pos = localPlayerRenderPos(predictor, delta);
      posX = pos.x; posZ = pos.z;
      predictor.renderX = pos.x;
      predictor.renderZ = pos.z;
    } else {
      const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
      if (!sample) return;
      posX = sample.x; posZ = sample.z;
    }

    groupRef.current.position.set(posX, RENDER_Y, posZ);

    let facingX = 0, facingZ = 1;
    if (predictor) {
      const f = getLiveFacing(camera, posX, posZ);
      facingX = f.x; facingZ = f.z;
    } else if (player) {
      facingX = player.facingX; facingZ = player.facingZ;
    }

    cubeRef.current.rotation.y = Math.atan2(facingX, facingZ);
    cubeRef.current.rotation.x = isDowned ? Math.PI / 2 : 0;
  });

  // Color update on downed change — accessing material via cubeRef. The
  // initial color is set on mount via the JSX prop; subsequent changes use
  // material.color.set in this effect.
  useEffect(() => {
    const m = cubeRef.current?.material as unknown as { color: { set: (c: string) => void } } | undefined;
    if (m) m.color.set(downed ? DOWN_COLOR : baseColor);
  }, [downed, baseColor]);

  const isLocal = !!predictor;
  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  return (
    <group ref={groupRef}>
      <mesh ref={cubeRef} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={baseColor} />
        {/* Nose — child mesh in cube's local space, sticking out along +Z */}
        <mesh position={[0, 0, 0.7]}>
          <boxGeometry args={[0.2, 0.2, 0.6]} />
          <meshStandardMaterial color="#ffffff" />
        </mesh>
      </mesh>
      <Billboard position={[0, 1.4, 0]}>
        <Text
          fontSize={0.35}
          color={isLocal ? "#ffd34a" : "#ffffff"}
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {name}
        </Text>
        <group position={[0, -0.3, 0]}>
          <mesh>
            <planeGeometry args={[1.2, 0.12]} />
            <meshBasicMaterial color="#222" transparent opacity={0.6} />
          </mesh>
          <mesh position={[(hpFrac - 1) * 0.6, 0, 0.001]}>
            <planeGeometry args={[Math.max(0.001, 1.2 * hpFrac), 0.12]} />
            <meshBasicMaterial color={downed ? "#666" : "#5cd35c"} />
          </mesh>
        </group>
      </Billboard>
    </group>
  );
}
