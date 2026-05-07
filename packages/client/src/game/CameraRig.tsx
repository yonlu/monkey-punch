import { useFrame, useThree } from "@react-three/fiber";
import type { Room } from "colyseus.js";
import { useRef } from "react";
import type { PerspectiveCamera } from "three";
import type { Player, RoomState } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const OFFSET_X = 0;
const OFFSET_Y = 9;
const OFFSET_Z = 11;
const LERP_TAU_S = 0.15;

type Props = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * Lerp-follow camera positioned at OFFSET above-and-behind the local player.
 * Spectator-mode: when local player is downed, target switches to the first
 * non-downed remote player (MapSchema iteration order — per-client local
 * presentation, deterministic-across-clients not required).
 */
export function CameraRig({ room, predictor, buffers }: Props) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const lookAt = useRef({ x: 0, y: 0.5, z: 0 });

  useFrame((_, dt) => {
    const local = room.state.players.get(room.sessionId);
    let tx = predictor.renderX;
    let tz = predictor.renderZ;

    if (local?.downed) {
      let chosen: Player | null = null;
      room.state.players.forEach((p) => {
        if (chosen) return;
        if (p.sessionId === room.sessionId) return;
        if (!p.downed) chosen = p;
      });
      if (chosen) {
        const buf = buffers.get((chosen as Player).sessionId);
        const sample = buf?.sample(performance.now() - hudState.interpDelayMs);
        if (sample) { tx = sample.x; tz = sample.z; }
      }
    }

    const factor = 1 - Math.exp(-dt / LERP_TAU_S);
    camera.position.x += (tx + OFFSET_X - camera.position.x) * factor;
    camera.position.y += (OFFSET_Y - camera.position.y) * factor;
    camera.position.z += (tz + OFFSET_Z - camera.position.z) * factor;

    lookAt.current.x += (tx - lookAt.current.x) * factor;
    lookAt.current.z += (tz - lookAt.current.z) * factor;
    camera.lookAt(lookAt.current.x, lookAt.current.y, lookAt.current.z);
  });

  return null;
}
