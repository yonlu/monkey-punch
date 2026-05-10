import { useFrame, useThree } from "@react-three/fiber";
import type { Room } from "colyseus.js";
import { useRef } from "react";
import type { PerspectiveCamera } from "three";
import type { Player, RoomState } from "@mp/shared";
import { PLAYER_GROUND_OFFSET, terrainHeight } from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";
import {
  CAMERA_DISTANCE,
  CAMERA_FOLLOW_LERP,
  CAMERA_LOOK_HEIGHT,
  getPitch,
  getYaw,
} from "../camera.js";

type Props = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * Mouse-orbit camera (US-005). Yaw/pitch live in `camera.ts` and are
 * driven by mouse movement only while pointer lock is engaged. Each
 * frame the camera position is rebuilt from the orbit math:
 *
 *   offset = ( DIST*sin(yaw)*cos(pitch),
 *              DIST*sin(pitch) + LOOK_HEIGHT,
 *              DIST*cos(yaw)*cos(pitch) )
 *
 * applied around the local player, then blended toward the new desired
 * position with a frame-rate-independent factor `1 - exp(-RATE*dt)`.
 *
 * Spectator mode (local player downed) targets the first non-downed
 * remote player by MapSchema iteration order — per-client local
 * presentation, so determinism across clients isn't required.
 */
export function CameraRig({ room, predictor, buffers }: Props) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const lookAt = useRef({ x: 0, y: CAMERA_LOOK_HEIGHT, z: 0 });

  useFrame((_, dt) => {
    const local = room.state.players.get(room.sessionId);

    // Target = local player by default. Y is derived from the same
    // shared terrainHeight the server uses, so the orbit center sits on
    // the rendered terrain even before US-011 extends prediction to Y.
    let tx = predictor.renderX;
    let tz = predictor.renderZ;
    let ty = terrainHeight(tx, tz) + PLAYER_GROUND_OFFSET;

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
        if (sample) { tx = sample.x; ty = sample.y; tz = sample.z; }
      }
    }

    const yaw = getYaw();
    const pitch = getPitch();
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);

    const desiredX = tx + CAMERA_DISTANCE * sinY * cosP;
    const desiredY = ty + CAMERA_DISTANCE * sinP + CAMERA_LOOK_HEIGHT;
    const desiredZ = tz + CAMERA_DISTANCE * cosY * cosP;

    const factor = 1 - Math.exp(-CAMERA_FOLLOW_LERP * dt);
    camera.position.x += (desiredX - camera.position.x) * factor;
    camera.position.y += (desiredY - camera.position.y) * factor;
    camera.position.z += (desiredZ - camera.position.z) * factor;

    const focusY = ty + CAMERA_LOOK_HEIGHT;
    lookAt.current.x += (tx - lookAt.current.x) * factor;
    lookAt.current.y += (focusY - lookAt.current.y) * factor;
    lookAt.current.z += (tz - lookAt.current.z) * factor;
    camera.lookAt(lookAt.current.x, lookAt.current.y, lookAt.current.z);
  });

  return null;
}
