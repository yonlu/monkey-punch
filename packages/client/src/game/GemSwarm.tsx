import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import type { Room } from "colyseus.js";
import { getStateCallbacks } from "colyseus.js";
import type { Gem, RoomState } from "@mp/shared";
import { PROJECTILE_MAX_CAPACITY } from "@mp/shared";

const GEM_RENDER_Y = 0.4;
const GEM_CAPACITY = PROJECTILE_MAX_CAPACITY; // ample headroom; gems despawn on pickup

export type GemSwarmProps = {
  room: Room<RoomState>;
};

/**
 * Renders state.gems in a single InstancedMesh. Lifecycle is driven by
 * Colyseus state callbacks (gems ARE schema entities). Swap-and-pop slot
 * allocator keeps the active range packed. No SnapshotBuffer — gems
 * don't move, so per-frame matrix update reads the current gem position
 * directly; a one-frame lag of a freshly-added gem is invisible.
 */
export function GemSwarm({ room }: GemSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const slotForId = useRef(new Map<number, number>());
  const idAtSlot = useRef<number[]>([]);
  const activeCountRef = useRef(0);
  const matrix = useMemo(() => new Matrix4(), []);

  useEffect(() => {
    const $ = getStateCallbacks(room);

    const onAdd = (_gem: Gem, key: string) => {
      const id = Number(key);
      if (slotForId.current.has(id)) return;
      const slot = activeCountRef.current++;
      slotForId.current.set(id, slot);
      idAtSlot.current[slot] = id;
    };
    const onRemove = (_gem: Gem, key: string) => {
      const id = Number(key);
      const slot = slotForId.current.get(id);
      if (slot === undefined) return;
      const lastSlot = --activeCountRef.current;
      const lastId = idAtSlot.current[lastSlot]!;
      if (slot !== lastSlot) {
        idAtSlot.current[slot] = lastId;
        slotForId.current.set(lastId, slot);
      }
      slotForId.current.delete(id);
      idAtSlot.current.length = activeCountRef.current;
    };

    const offAdd = $(room.state).gems.onAdd(onAdd);
    const offRemove = $(room.state).gems.onRemove(onRemove);
    room.state.gems.forEach((g, k) => onAdd(g, k));

    return () => {
      offAdd();
      offRemove();
      slotForId.current.clear();
      idAtSlot.current.length = 0;
      activeCountRef.current = 0;
    };
  }, [room]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const count = activeCountRef.current;
    for (let i = 0; i < count; i++) {
      const id = idAtSlot.current[i]!;
      const gem = room.state.gems.get(String(id));
      if (!gem) continue;
      matrix.makeTranslation(gem.x, GEM_RENDER_Y, gem.z);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, GEM_CAPACITY]}
      frustumCulled={false}
    >
      <octahedronGeometry args={[0.3, 0]} />
      <meshStandardMaterial color="#5be6ff" emissive="#5be6ff" emissiveIntensity={0.7} />
    </instancedMesh>
  );
}
