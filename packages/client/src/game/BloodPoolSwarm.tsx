import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import type { Room } from "colyseus.js";
import type { RoomState, BloodPool } from "@mp/shared";
import { terrainHeight } from "@mp/shared";

// Capacity bound: at peak (Bloody Axe L5 with leavesBloodPool=true,
// 1.5s lifetime, ~5 pools per throw, 2-3 active throws stacked) ≈ 15.
// Cushion to 64 for safety.
const BLOOD_POOL_MAX_CAPACITY = 64;

// Visual lift above terrain — pool decals sit slightly above the ground
// to avoid z-fighting with the slope shader.
const BLOOD_POOL_GROUND_LIFT = 0.04;

// Visual radius factor — match the server's BLOOD_POOL_RADIUS in
// shared/rules.ts (1.2). Out of sync = visual + hit area mismatch.
const BLOOD_POOL_VISUAL_RADIUS = 1.2;

export type BloodPoolSwarmProps = {
  room: Room<RoomState>;
};

const TILT_QUAT = new Quaternion();
TILT_QUAT.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

export function BloodPoolSwarm({ room }: BloodPoolSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  const position = useMemo(() => new Vector3(), []);
  const scaleVec = useMemo(() => new Vector3(BLOOD_POOL_VISUAL_RADIUS, BLOOD_POOL_VISUAL_RADIUS, BLOOD_POOL_VISUAL_RADIUS), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    let i = 0;

    room.state.bloodPools.forEach((pool: BloodPool) => {
      if (i >= BLOOD_POOL_MAX_CAPACITY) return;
      // Sample terrain Y at the pool's XZ — pools are ground decals;
      // they ride the terrain (M7 terrain shader is bumpy, so the pool
      // tracks the surface rather than floating).
      const groundY = terrainHeight(pool.x, pool.z) + BLOOD_POOL_GROUND_LIFT;
      position.set(pool.x, groundY, pool.z);
      matrix.compose(position, TILT_QUAT, scaleVec);
      mesh.setMatrixAt(i, matrix);
      i++;
    });

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, BLOOD_POOL_MAX_CAPACITY]}
      frustumCulled={false}
    >
      {/* Translucent red disc — flat against the ground (tilted -90°
          about X by the per-instance matrix so the CircleGeometry's
          default XY plane lays flat in XZ). Per-instance scale matches
          the server's BLOOD_POOL_RADIUS so the visual reads as the
          actual hit area. */}
      <circleGeometry args={[1.0, 24]} />
      <meshBasicMaterial
        color="#a01818"
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </instancedMesh>
  );
}
