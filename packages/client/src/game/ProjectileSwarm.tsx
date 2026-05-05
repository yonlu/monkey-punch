import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4 } from "three";
import { PROJECTILE_MAX_CAPACITY, WEAPON_KINDS } from "@mp/shared";
import type { FireEvent } from "@mp/shared";
import { hudState } from "../net/hudState.js";
import type { ServerTime } from "../net/serverTime.js";

const PROJECTILE_RENDER_Y = 0.6;

export type ProjectileSwarmProps = {
  fires: Map<number, FireEvent>;     // GameView-owned map of in-flight fires by fireId
  serverTime: ServerTime;
};

/**
 * Per AD1/AD2: projectiles are not sync'd; each is a closed-form function
 * of its FireEvent payload sampled at `serverNow() - interpDelayMs`. Two
 * clients with stable, similar serverTimeOffsetMs compute the same world
 * position for the same fireId at the same wall-clock moment.
 *
 * No slot allocator: the Map iterates in insertion order, projectile
 * turnover is high (~20+/s at peak), and per-instance attributes are
 * uniform — re-walking the matrix table each frame is the same cost as
 * a slotted update. This component also self-prunes by deleting any
 * fireId whose elapsed >= projectileLifetime + 0.5s as a defensive
 * backstop; the primary lifetime cleanup driver is GameView (Task 19).
 *
 * Mid-iteration Map.delete on the current key is well-defined in JS.
 *
 * Speed and lifetime come from WEAPON_KINDS[fe.weaponKind] — adding M5's
 * second weapon needs no new sync, just a row in the table.
 */
export function ProjectileSwarm({ fires, serverTime }: ProjectileSwarmProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const renderServerTimeMs = serverTime.serverNow() - hudState.interpDelayMs;
    let i = 0;

    for (const [fireId, fe] of fires) {
      const elapsedSec = (renderServerTimeMs - fe.serverFireTimeMs) / 1000;
      const kind = WEAPON_KINDS[fe.weaponKind];
      if (!kind) {
        // Unknown kind from a future server: drop quietly.
        fires.delete(fireId);
        continue;
      }
      if (elapsedSec >= kind.projectileLifetime + 0.5) {
        // Past lifetime + small grace; the GameView setTimeout cleanup
        // should have fired by now, but if it was missed (tab backgrounded,
        // throttled), drop here as a backstop.
        fires.delete(fireId);
        continue;
      }
      if (i >= PROJECTILE_MAX_CAPACITY) break; // defense
      const t = elapsedSec > 0 ? elapsedSec : 0;
      matrix.makeTranslation(
        fe.originX + fe.dirX * kind.projectileSpeed * t,
        PROJECTILE_RENDER_Y,
        fe.originZ + fe.dirZ * kind.projectileSpeed * t,
      );
      mesh.setMatrixAt(i, matrix);
      i++;
    }

    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    hudState.projectileCount = i;
  });

  return (
    // No castShadow: same Three 0.164 InstancedMesh + shadow-camera
    // landmine that EnemySwarm dodges. Projectiles are tiny and bright;
    // shadows wouldn't read at distance anyway.
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, PROJECTILE_MAX_CAPACITY]}
      frustumCulled={false}
    >
      <sphereGeometry args={[0.15, 8, 6]} />
      <meshStandardMaterial color="#ffd24a" emissive="#ffd24a" emissiveIntensity={1.2} />
    </instancedMesh>
  );
}
