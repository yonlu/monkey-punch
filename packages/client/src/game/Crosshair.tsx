import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import type { Mesh, PerspectiveCamera } from "three";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { getLiveCrosshairPoint } from "./input.js";

type Props = { room: Room<RoomState> };

/**
 * In-world ground reticle at the mouse-raycast point on y=0. Hidden when
 * the local player is downed (their facing isn't being processed by the
 * server, so the visible reticle would be misleading). Reads downed
 * directly from `room.state.players` each frame — this avoids the
 * ref-vs-state hazard where a parent's mutable ref wouldn't trigger a
 * re-render.
 */
export function Crosshair({ room }: Props) {
  const ref = useRef<Mesh>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;

  useFrame(() => {
    if (!ref.current) return;
    const localPlayer = room.state.players.get(room.sessionId);
    if (localPlayer?.downed) {
      ref.current.visible = false;
      return;
    }
    const pt = getLiveCrosshairPoint(camera);
    if (!pt) {
      ref.current.visible = false;
      return;
    }
    ref.current.visible = true;
    ref.current.position.set(pt.x, 0.01, pt.z);
  });

  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.4, 0.5, 32]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
    </mesh>
  );
}
