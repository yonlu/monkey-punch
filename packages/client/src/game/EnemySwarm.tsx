import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import { MAX_ENEMIES } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

// Visual lift from the enemy's authoritative y (terrain surface) to the
// cone's centroid. The cone geometry below is height 1.2 with its origin
// at its centroid, so half the height places the cone's base flush with
// the ground. ENEMY_GROUND_OFFSET (in shared/constants.ts) stays at 0
// for now per CLAUDE.md PRD Q2 — this lift is a render-only concern,
// not a gameplay constant.
const ENEMY_RENDER_LIFT = 0.6;

export type EnemySwarmProps = {
  enemyIds: Set<number>;
  buffers: Map<number, SnapshotBuffer>;
};

/**
 * Renders all enemies in a single InstancedMesh of capacity MAX_ENEMIES.
 * Per AD4: a swap-and-pop slot allocator keeps the active range packed at
 * [0, activeCount). Per AD7: each enemy interpolates from its own
 * SnapshotBuffer (mirror of the player pattern).
 */
export function EnemySwarm({ enemyIds, buffers }: EnemySwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const slotForId = useRef(new Map<number, number>());
  const idAtSlot = useRef<number[]>([]);
  const activeCountRef = useRef(0);
  const matrix = useMemo(() => new Matrix4(), []);
  const { gl } = useThree();

  // Sync the slot table with enemyIds whenever the Set identity changes.
  // GameView's onEnemyAdd/onEnemyRemove always create a new Set instance,
  // so this effect fires on any membership change.
  useEffect(() => {
    // Add: any id in enemyIds that isn't slotted gets the next slot.
    enemyIds.forEach((id) => {
      if (slotForId.current.has(id)) return;
      const slot = activeCountRef.current++;
      slotForId.current.set(id, slot);
      idAtSlot.current[slot] = id;
    });
    // Remove: any slotted id no longer in enemyIds — swap-and-pop.
    for (const [id, slot] of slotForId.current) {
      if (enemyIds.has(id)) continue;
      const lastSlot = --activeCountRef.current;
      const lastId = idAtSlot.current[lastSlot]!;
      if (slot !== lastSlot) {
        idAtSlot.current[slot] = lastId;
        slotForId.current.set(lastId, slot);
      }
      slotForId.current.delete(id);
      idAtSlot.current.length = activeCountRef.current;
    }
  }, [enemyIds]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const renderTime = performance.now() - hudState.interpDelayMs;
    const count = activeCountRef.current;
    for (let i = 0; i < count; i++) {
      const id = idAtSlot.current[i]!;
      const buf = buffers.get(id);
      if (!buf) continue;
      const sample = buf.sample(renderTime);
      if (!sample) continue;
      matrix.makeTranslation(sample.x, sample.y + ENEMY_RENDER_LIFT, sample.z);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    hudState.enemyDrawCalls = gl.info.render.calls;
  });

  return (
    // No castShadow: with the directionalLight's default shadow camera
    // (~5x5 world units) and enemies scattered to ENEMY_SPAWN_RADIUS=30,
    // every instance is outside the shadow frustum every frame. In Three.js
    // 0.164 with @react-three/fiber 8.18, this combination causes the
    // entire InstancedMesh to be silently dropped from the main render
    // pass. Disabling castShadow keeps enemies visible. Future work:
    // expand the shadow camera bounds and add castShadow back, or use a
    // custom depth material for enemy shadows.
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_ENEMIES]}
      frustumCulled={false}
    >
      <coneGeometry args={[0.5, 1.2, 6]} />
      <meshStandardMaterial color="#c44" />
    </instancedMesh>
  );
}
