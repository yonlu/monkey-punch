import { useMemo, useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import type { Room } from "colyseus.js";
import type { Player, RoomState } from "@mp/shared";
import {
  MAX_ORB_COUNT_EVER,
  TICK_RATE,
  WEAPON_KINDS,
  isOrbitWeapon,
  statsAt,
} from "@mp/shared";
import type { LocalPredictor } from "../net/prediction.js";
import type { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

// Must agree with the server's MAX_PLAYERS in packages/server/src/GameRoom.ts.
// The client doesn't import server constants, so this is a deliberate copy.
const MAX_PLAYERS = 10;
const ORB_RENDER_Y = 0.7;
const ORB_CAPACITY = MAX_PLAYERS * MAX_ORB_COUNT_EVER;

export type OrbitSwarmProps = {
  room: Room<RoomState>;
  predictor: LocalPredictor;
  buffers: Map<string, SnapshotBuffer>;
};

/**
 * Per spec §AD2: orbit positions are computed deterministically from
 * (state.tick, player render-pos, weapon level). Both clients reading the
 * same synced tick produce the same orb angles. Player render-pos is the
 * predictor for the local player and the interpolated buffer sample for
 * remote players — matches PlayerCube so orbs visually stick to the
 * player at all times.
 *
 * Single InstancedMesh with capacity MAX_PLAYERS * MAX_ORB_COUNT_EVER. No
 * per-orb attribute updates other than translation matrix.
 */
export function OrbitSwarm({ room, predictor, buffers }: OrbitSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);

  useEffect(() => {
    if (meshRef.current) meshRef.current.count = 0;
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const tick = room.state.tick;
    const tickTime = tick / TICK_RATE;
    let i = 0;

    room.state.players.forEach((player: Player) => {
      // Player render position: predictor for local, interpolated remote.
      let rx: number;
      let rz: number;
      if (player.sessionId === room.sessionId) {
        rx = predictor.predictedX;
        rz = predictor.predictedZ;
      } else {
        const sample = buffers.get(player.sessionId)?.sample(performance.now() - hudState.interpDelayMs);
        if (!sample) {
          rx = player.x;
          rz = player.z;
        } else {
          rx = sample.x;
          rz = sample.z;
        }
      }

      player.weapons.forEach((weapon) => {
        const def = WEAPON_KINDS[weapon.kind];
        if (!def || !isOrbitWeapon(def)) return;
        const stats = statsAt(def, weapon.level);

        for (let k = 0; k < stats.orbCount; k++) {
          if (i >= ORB_CAPACITY) return;
          const angle = tickTime * stats.orbAngularSpeed + k * (2 * Math.PI / stats.orbCount);
          matrix.makeTranslation(
            rx + Math.cos(angle) * stats.orbRadius,
            ORB_RENDER_Y,
            rz + Math.sin(angle) * stats.orbRadius,
          );
          mesh.setMatrixAt(i, matrix);
          i++;
        }
      });
    });

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    // No castShadow — same Three 0.164 InstancedMesh + shadow-camera
    // landmine that EnemySwarm/ProjectileSwarm dodge.
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, ORB_CAPACITY]}
      frustumCulled={false}
    >
      <sphereGeometry args={[0.25, 10, 8]} />
      <meshStandardMaterial color="#7af0ff" emissive="#7af0ff" emissiveIntensity={1.0} />
    </instancedMesh>
  );
}
