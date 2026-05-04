import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import { MAX_ENEMIES } from "@mp/shared";
import { SnapshotBuffer } from "../net/snapshots.js";
import { hudState } from "../net/hudState.js";

const ENEMY_RENDER_Y = 0.6;

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
      matrix.makeTranslation(sample.x, ENEMY_RENDER_Y, sample.z);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    hudState.enemyDrawCalls = gl.info.render.calls;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_ENEMIES]} castShadow>
      <coneGeometry args={[0.5, 1.2, 6]} />
      <meshStandardMaterial color="#c44" />
    </instancedMesh>
  );
}
