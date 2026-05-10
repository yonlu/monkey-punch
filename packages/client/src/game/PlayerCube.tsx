import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import type { Group } from "three";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { PLAYER_SPEED, PLAYER_GROUND_OFFSET, terrainHeight } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import {
  STEP_INTERVAL_MS,
  SMOOTHING_TAU_S,
  type LocalPredictor,
} from "../net/prediction.js";
import { getLiveInputDir } from "./input.js";
import { PlayerCharacter, type AnimName } from "./PlayerCharacter.js";

const STEP_INTERVAL_S = STEP_INTERVAL_MS / 1000;
const RUN_SPEED_THRESHOLD = 0.5;

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

  const [hp, setHp] = useState<number>(100);
  const [maxHp, setMaxHp] = useState<number>(100);
  const [downed, setDowned] = useState<boolean>(false);
  const [anim, setAnim] = useState<AnimName>("Idle");
  const [facingY, setFacingY] = useState<number>(0);

  // Per-frame velocity tracker for Idle/Run detection.
  const lastPos = useRef<{ x: number; z: number; t: number } | null>(null);

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
    if (!groupRef.current) return;

    const player = room.state.players.get(sessionId);
    const isDowned = !!player?.downed;
    if (isDowned !== downed) setDowned(isDowned);
    if (player) {
      if (player.hp !== hp) setHp(player.hp);
      if (player.maxHp !== maxHp) setMaxHp(player.maxHp);
    }

    let posX: number, posY: number, posZ: number;
    if (predictor) {
      const pos = localPlayerRenderPos(predictor, delta);
      posX = pos.x; posZ = pos.z;
      predictor.renderX = pos.x;
      predictor.renderZ = pos.z;
      // US-004: predicted Y is purely terrain-derived (no jump until US-009).
      // Same function the server uses to snap player.y in tickPlayers, so the
      // local cube sits flush with the rendered terrain mesh.
      posY = terrainHeight(posX, posZ) + PLAYER_GROUND_OFFSET;
    } else {
      const sample = buffer.sample(performance.now() - hudState.interpDelayMs);
      if (!sample) return;
      posX = sample.x; posY = sample.y; posZ = sample.z;
    }

    groupRef.current.position.set(posX, posY, posZ);

    // Anim + body facing: Death overrides everything; otherwise pick Run vs
    // Idle from rendered-position rate of change, and rotate the body to
    // match walk direction. Body facing follows movement (US-006), NOT the
    // camera — pressing W rotates the player into the screen regardless
    // of camera angle because getLiveInputDir() returns world-space dir.
    let nextAnim: AnimName;
    if (isDowned) {
      nextAnim = "Death";
    } else {
      const nowMs = performance.now();
      const last = lastPos.current;
      let speed = 0;
      let dx = 0, dz = 0;
      if (last) {
        const dt = Math.max(0.001, (nowMs - last.t) / 1000);
        dx = posX - last.x;
        dz = posZ - last.z;
        speed = Math.hypot(dx, dz) / dt;
      }
      lastPos.current = { x: posX, z: posZ, t: nowMs };

      // Walk direction. Local: live input dir (noise-free); remote: snapshot
      // delta. Only update facing when actually moving — keep last facing
      // when standing still.
      let walkX = 0, walkZ = 0, walkMag = 0;
      if (predictor) {
        const dir = getLiveInputDir();
        walkX = dir.x; walkZ = dir.z;
        walkMag = Math.hypot(walkX, walkZ);
      } else if (speed > RUN_SPEED_THRESHOLD) {
        walkX = dx; walkZ = dz;
        walkMag = Math.hypot(walkX, walkZ);
      }
      if (walkMag > 0.01) {
        // Quaternius mannequin's default forward is -Z (FBX2glTF export
        // convention), so flip 180° to align with our walk vector.
        const newFacingY = Math.atan2(walkX, walkZ) + Math.PI;
        if (newFacingY !== facingY) setFacingY(newFacingY);
      }

      nextAnim = speed > RUN_SPEED_THRESHOLD ? "Run" : "Idle";
    }
    if (nextAnim !== anim) setAnim(nextAnim);
  });

  const isLocal = !!predictor;
  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  return (
    <group ref={groupRef}>
      <PlayerCharacter anim={anim} facingY={facingY} />
      <Billboard position={[0, 1.95, 0]}>
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
