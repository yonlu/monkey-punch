import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { PROJECTILE_MAX_CAPACITY, WEAPON_KINDS, statsAt, isProjectileWeapon } from "@mp/shared";
import type { FireEvent } from "@mp/shared";
import { hudState } from "../net/hudState.js";
import type { ServerTime } from "../net/serverTime.js";

// M7 US-013: projectiles render in 3D. The closed-form per-frame Y is
// `originY + dirY * speed * t`, so the constant render-height from the
// 2D era is gone — Y now comes from the FireEvent payload.
//
// M8 US-003: per-weapon mesh distinction. Two parallel InstancedMeshes —
// one for `mesh: "sphere"` weapons (Bolt) and one for `mesh: "elongated"`
// (Gakkung Bow). Dispatch reads `def.behavior.mesh` (an enum) — no
// name-based branching (CLAUDE.md rule 12).
//
// M8 US-003 known approximation: client renders the projectile along the
// fire-event's straight-line path even for homing weapons. The server
// simulates real homing internally and emits a `hit` event at the curved
// trajectory's actual impact point — the client receives that hit and
// despawns the projectile, so the despawn is correct. The mid-flight
// visual position can drift from the server's actual path. For Gakkung's
// gentle homing (~π·0.8 rad/s) over 1.2s the divergence is mild; revisit
// in a polish pass if playtest shows it.

export type ProjectileSwarmProps = {
  fires: Map<number, FireEvent>;     // GameView-owned map of in-flight fires by fireId
  serverTime: ServerTime;
};

// Reused across frames (stack-of-one alloc).
const Y_AXIS = new Vector3(0, 1, 0);

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
// Visual scale baseline. M8 US-004: per-instance scale = stats.hitRadius /
// HIT_RADIUS_BASELINE. Bolt and Gakkung have constant hitRadius 0.4 so this
// resolves to 1.0 always (no visible per-level change). Ahlspiess hitRadius
// grows 0.5 → 0.8 per level so its spear visibly lengthens at higher levels
// — that's the per-level visual scaling AC. The mapping is uniform across
// X/Y/Z so cylinders thicken AND lengthen together (looks more like "the
// weapon got bigger" than just stretching).
const HIT_RADIUS_BASELINE = 0.4;

export function ProjectileSwarm({ fires, serverTime }: ProjectileSwarmProps) {
  const sphereMeshRef = useRef<InstancedMesh>(null);
  const elongatedMeshRef = useRef<InstancedMesh>(null);
  const spearMeshRef = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  const position = useMemo(() => new Vector3(), []);
  const dirVec = useMemo(() => new Vector3(), []);
  const quaternion = useMemo(() => new Quaternion(), []);
  const scaleVec = useMemo(() => new Vector3(1, 1, 1), []);

  useFrame(() => {
    const sphereMesh = sphereMeshRef.current;
    const elongatedMesh = elongatedMeshRef.current;
    const spearMesh = spearMeshRef.current;
    if (!sphereMesh || !elongatedMesh || !spearMesh) return;

    const renderServerTimeMs = serverTime.serverNow() - hudState.interpDelayMs;
    let sphereI = 0;
    let elongatedI = 0;
    let spearI = 0;

    for (const [fireId, fe] of fires) {
      const elapsedSec = (renderServerTimeMs - fe.serverFireTimeMs) / 1000;
      const def = WEAPON_KINDS[fe.weaponKind];
      if (!def || !isProjectileWeapon(def)) {
        fires.delete(fireId);
        continue;
      }
      // M8 US-002 lifts the M5 weaponLevel deferral: FireEvent now carries
      // the weapon level at fire time, so visual stats can scale per level
      // (Ahlspiess hitRadius growth in US-004 reads this too).
      const stats = statsAt(def, fe.weaponLevel);
      if (elapsedSec >= stats.projectileLifetime + 0.5) {
        // Past lifetime + small grace; the GameView setTimeout cleanup
        // should have fired by now, but if it was missed (tab backgrounded,
        // throttled), drop here as a backstop.
        fires.delete(fireId);
        continue;
      }
      const t = elapsedSec > 0 ? elapsedSec : 0;
      const px = fe.originX + fe.dirX * stats.projectileSpeed * t;
      const py = fe.originY + fe.dirY * stats.projectileSpeed * t;
      const pz = fe.originZ + fe.dirZ * stats.projectileSpeed * t;
      const visualScale = stats.hitRadius / HIT_RADIUS_BASELINE;

      // Dispatch to the right mesh by behavior.mesh. Adding a fourth mesh
      // kind would mean a new InstancedMesh sibling and a new arm here.
      if (def.behavior.mesh === "sphere") {
        if (sphereI >= PROJECTILE_MAX_CAPACITY) continue; // defense
        // Sphere is rotationally invariant — translation + uniform scale
        // is enough; no quaternion needed.
        position.set(px, py, pz);
        scaleVec.set(visualScale, visualScale, visualScale);
        matrix.compose(position, IDENTITY_QUAT, scaleVec);
        sphereMesh.setMatrixAt(sphereI, matrix);
        sphereI++;
      } else if (def.behavior.mesh === "elongated") {
        // Cylinder oriented along the unit dir vector. CylinderGeometry's
        // default axis is Y, so the quaternion rotates (0,1,0) onto dir.
        if (elongatedI >= PROJECTILE_MAX_CAPACITY) continue;
        position.set(px, py, pz);
        dirVec.set(fe.dirX, fe.dirY, fe.dirZ);
        quaternion.setFromUnitVectors(Y_AXIS, dirVec);
        scaleVec.set(visualScale, visualScale, visualScale);
        matrix.compose(position, quaternion, scaleVec);
        elongatedMesh.setMatrixAt(elongatedI, matrix);
        elongatedI++;
      } else {
        // "spear" — same orientation math as elongated, different mesh.
        if (spearI >= PROJECTILE_MAX_CAPACITY) continue;
        position.set(px, py, pz);
        dirVec.set(fe.dirX, fe.dirY, fe.dirZ);
        quaternion.setFromUnitVectors(Y_AXIS, dirVec);
        scaleVec.set(visualScale, visualScale, visualScale);
        matrix.compose(position, quaternion, scaleVec);
        spearMesh.setMatrixAt(spearI, matrix);
        spearI++;
      }
    }

    sphereMesh.count = sphereI;
    sphereMesh.instanceMatrix.needsUpdate = true;
    elongatedMesh.count = elongatedI;
    elongatedMesh.instanceMatrix.needsUpdate = true;
    spearMesh.count = spearI;
    spearMesh.instanceMatrix.needsUpdate = true;
    hudState.projectileCount = sphereI + elongatedI + spearI;
  });

  return (
    // No castShadow on any mesh: same Three 0.164 InstancedMesh +
    // shadow-camera landmine that EnemySwarm dodges. Projectiles are tiny
    // and bright; shadows wouldn't read at distance anyway.
    <>
      <instancedMesh
        ref={sphereMeshRef}
        args={[undefined, undefined, PROJECTILE_MAX_CAPACITY]}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.15, 8, 6]} />
        <meshStandardMaterial color="#ffd24a" emissive="#ffd24a" emissiveIntensity={1.2} />
      </instancedMesh>
      <instancedMesh
        ref={elongatedMeshRef}
        args={[undefined, undefined, PROJECTILE_MAX_CAPACITY]}
        frustumCulled={false}
      >
        {/* M8 US-003: thin elongated arrow body. radTop=radBottom=0.05,
            height=0.6 along Y; per-frame quaternion rotates it onto the
            dir vector. Color is light wood/brown per the Ragnarok bow
            visual identity. */}
        <cylinderGeometry args={[0.05, 0.05, 0.6, 6]} />
        <meshStandardMaterial color="#a86b3c" emissive="#a86b3c" emissiveIntensity={0.5} />
      </instancedMesh>
      <instancedMesh
        ref={spearMeshRef}
        args={[undefined, undefined, PROJECTILE_MAX_CAPACITY]}
        frustumCulled={false}
      >
        {/* M8 US-004: long thin spear body — narrower and longer than
            Gakkung's elongated arrow (0.04 vs 0.05 radius, 1.2 vs 0.6
            length). Gold material for the Ragnarok auger-spear visual
            identity. Per-frame quaternion + per-instance uniform scale
            from stats.hitRadius / 0.4 give Ahlspiess visible level
            growth (L1 scale 1.25 → L5 scale 2.0). */}
        <cylinderGeometry args={[0.04, 0.04, 1.2, 6]} />
        <meshStandardMaterial color="#e8c460" emissive="#e8c460" emissiveIntensity={0.7} />
      </instancedMesh>
    </>
  );
}

// Identity quaternion for the rotationally-invariant sphere mesh — declared
// outside the component to avoid per-frame allocation. compose() reads it
// but does not mutate.
const IDENTITY_QUAT = new Quaternion();
