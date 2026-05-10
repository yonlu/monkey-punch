import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import type { Room } from "colyseus.js";
import type { BoomerangThrownEvent, RoomState, Player } from "@mp/shared";
import type { ServerTime } from "../net/serverTime.js";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

// Matches the server's BOOMERANG_RETURN_DESPAWN_RADIUS in shared/rules.ts.
// Out of sync = visual axe vanishes at a different distance than the
// server's hit. Keep them aligned manually (the server is authoritative
// for the actual despawn moment via the absence of further hit events,
// but the client's despawn radius affects the moment the axe disappears
// visually).
const BOOMERANG_RETURN_DESPAWN_RADIUS = 0.6;
const BOOMERANG_MAX_CAPACITY = 16;

// Per-axe state on the client — mirrors the server's Boomerang struct
// for the fields that determine visible position. The client integrates
// at variable dt (per render frame) using the SAME phase logic; the
// server uses fixed 50ms dt. Slight visual divergence possible; the hit
// event despawns the axe authoritatively.
export type ActiveBoomerang = {
  fireId: number;
  ownerId: string;
  outboundDistance: number;
  outboundSpeed: number;
  returnSpeed: number;
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;
  dirZ: number;
  // Mutable simulation state
  phase: "outbound" | "returning";
  x: number;
  z: number;
  outboundUsed: number;
  lastUpdateMs: number;     // serverTime.serverNow() at last frame's integration
  spinAngle: number;        // visual spin, accumulated per frame
};

export type BoomerangSwarmProps = {
  room: Room<RoomState>;
  boomerangs: Map<number, ActiveBoomerang>;
  serverTime: ServerTime;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

const Y_AXIS = new Vector3(0, 1, 0);
const SPIN_RATE = Math.PI * 6; // ~3 full rotations / sec for visible spin

export function BoomerangSwarm({ room, boomerangs, serverTime, predictor, buffers }: BoomerangSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  const position = useMemo(() => new Vector3(), []);
  const spinQuat = useMemo(() => new Quaternion(), []);
  const scaleVec = useMemo(() => new Vector3(0.4, 0.4, 0.4), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const nowMs = serverTime.serverNow();
    let i = 0;

    for (const [fireId, b] of boomerangs) {
      // Resolve owner's render position for the return phase.
      let ownerX = b.originX;
      let ownerZ = b.originZ;
      const owner = room.state.players.get(b.ownerId);
      if (owner) {
        if (owner.sessionId === room.sessionId) {
          ownerX = predictor.renderX;
          ownerZ = predictor.renderZ;
        } else {
          const sample = buffers.get(owner.sessionId)?.sample(performance.now() - hudState.interpDelayMs);
          if (sample) {
            ownerX = sample.x;
            ownerZ = sample.z;
          } else {
            ownerX = (owner as Player).x;
            ownerZ = (owner as Player).z;
          }
        }
      }

      // Per-frame integration. dt in seconds since last frame.
      const dtSec = Math.max(0, (nowMs - b.lastUpdateMs) / 1000);
      b.lastUpdateMs = nowMs;
      b.spinAngle += SPIN_RATE * dtSec;

      if (b.phase === "outbound") {
        const stepLen = b.outboundSpeed * dtSec;
        const remaining = b.outboundDistance - b.outboundUsed;
        if (stepLen >= remaining) {
          // Clamp + phase flip
          b.x += b.dirX * remaining;
          b.z += b.dirZ * remaining;
          b.outboundUsed = b.outboundDistance;
          b.phase = "returning";
        } else {
          b.x += b.dirX * stepLen;
          b.z += b.dirZ * stepLen;
          b.outboundUsed += stepLen;
        }
      } else {
        const tdx = ownerX - b.x;
        const tdz = ownerZ - b.z;
        const td = Math.sqrt(tdx * tdx + tdz * tdz);
        if (td <= BOOMERANG_RETURN_DESPAWN_RADIUS) {
          boomerangs.delete(fireId);
          continue;
        }
        const stepLen = Math.min(b.returnSpeed * dtSec, td);
        b.x += (tdx / td) * stepLen;
        b.z += (tdz / td) * stepLen;
      }

      if (i >= BOOMERANG_MAX_CAPACITY) continue;

      // Render: spinning axe at (b.x, originY + lift, b.z). Spin rotates
      // about Y so the box "spins" horizontally as it flies (boomerang
      // visual identity).
      position.set(b.x, b.originY + 0.6, b.z);
      spinQuat.setFromAxisAngle(Y_AXIS, b.spinAngle);
      matrix.compose(position, spinQuat, scaleVec);
      mesh.setMatrixAt(i, matrix);
      i++;
    }

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, BOOMERANG_MAX_CAPACITY]}
      frustumCulled={false}
    >
      {/* Placeholder boomerang shape — chunky box, scaled smaller via
          per-instance matrix (0.4x). A polish-pass replacement would
          load a custom axe-shaped GLTF. Red emissive so it reads as
          "blood-stained" against the world palette. */}
      <boxGeometry args={[1.2, 0.2, 0.4]} />
      <meshStandardMaterial color="#a02020" emissive="#601010" emissiveIntensity={0.7} />
    </instancedMesh>
  );
}
