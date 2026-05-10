import { useEffect, useMemo, useRef } from "react";
import { Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { generateProps, type Prop } from "@mp/shared";

// US-015: deterministic environmental props rendered as one InstancedMesh
// per kind. Positions come from generateProps(seed) — the same pure
// function the server is implicitly initialized to (props are NOT in the
// schema; both clients regenerate from state.seed and arrive at
// bit-identical placements per CLAUDE.md rule 2 derivation).
//
// Per-instance transforms are written once on seed-change, not per frame
// (props are static — there is no useFrame here). The per-kind layout
// keeps the swarm at three draw calls regardless of prop count.
//
// ASSET ACQUISITION DEFERRED. The PRD AC asks for Quaternius CC0 GLTF
// meshes for tree/rock/bush, loaded once via GLTFLoader. Quaternius's
// nature packs ship in FBX/OBJ/Blend formats only on their own site —
// no GLB/GLTF — so the asset choice involves a manual download +
// conversion + aesthetic curation step that this loop iteration cannot
// auto-resolve without a human picking specific models. Procedural
// placeholder geometry is used below; swapping in real assets means
// replacing each <coneGeometry> / <dodecahedronGeometry> / <icosahedronGeometry>
// JSX block with a `useGLTF(MODEL_URL)` import + `<primitive object={gltf.scene}>`
// pattern (see PlayerCharacter.tsx for the working reference). The
// per-kind InstancedMesh structure, capacity sizing, and matrix layout
// stay identical — only the rendered geometry changes.
//
// CLAUDE.md landmine #3: no `castShadow` on these instancedMesh nodes.
// Three 0.164 silently drops InstancedMeshes from the main render pass
// when their instances live outside the directional light's default
// shadow camera bounds (~5×5 world units), and props extend to
// PROP_AREA_HALF_EXTENT = 100. Mirrors EnemySwarm/ProjectileSwarm/OrbitSwarm.

const KIND_TREE = 0;
const KIND_ROCK = 1;
const KIND_BUSH = 2;

export type PropSwarmProps = {
  seed: number;
};

export function PropSwarm({ seed }: PropSwarmProps) {
  // generateProps requires initTerrain(seed) to be called first.
  // GameView already does that via a useMemo before children render
  // (terrainHeight is queried per prop for the y field). Keying on
  // `seed` here means a hot-reload that changes the seed rebuilds the
  // matrix tables; in production a room has one fixed seed for its
  // lifetime, so this useMemo runs exactly once.
  const props = useMemo(() => generateProps(seed), [seed]);

  const byKind = useMemo(() => {
    const buckets: Record<number, Prop[]> = { 0: [], 1: [], 2: [] };
    for (const p of props) buckets[p.kind]!.push(p);
    return buckets;
  }, [props]);

  return (
    <>
      <PropKindMesh
        props={byKind[KIND_TREE]!}
        geometry={
          <coneGeometry args={[0.7, 2.4, 7]} />
        }
        material={
          <meshStandardMaterial color="#3a7a2c" roughness={0.9} />
        }
        // Tree origin sits at the foliage centroid (cone center). Lift
        // by half the cone height so the cone's base rests on the
        // terrain at prop.y rather than the centroid.
        yOriginLift={1.2}
      />
      <PropKindMesh
        props={byKind[KIND_ROCK]!}
        geometry={
          <dodecahedronGeometry args={[0.55, 0]} />
        }
        material={
          <meshStandardMaterial color="#6c6660" roughness={0.95} />
        }
        // Rock origin is the geometric center of the dodecahedron.
        // Lifting by ~half the radius parks the rock half-buried for a
        // natural "sitting on the ground" look.
        yOriginLift={0.35}
      />
      <PropKindMesh
        props={byKind[KIND_BUSH]!}
        geometry={
          <icosahedronGeometry args={[0.55, 0]} />
        }
        material={
          <meshStandardMaterial color="#4a8a3a" roughness={0.85} />
        }
        // Bush origin centered; lift by ~half-radius so the leafy ball
        // sits on top of the terrain rather than half-buried.
        yOriginLift={0.5}
      />
    </>
  );
}

type PropKindMeshProps = {
  props: Prop[];
  geometry: React.ReactNode;
  material: React.ReactNode;
  yOriginLift: number;
};

function PropKindMesh({ props, geometry, material, yOriginLift }: PropKindMeshProps) {
  const meshRef = useRef<InstancedMesh>(null);
  // Capacity sized to exactly this kind's count per the PRD AC. With 0
  // props of a kind (small seed, all-skipped near origin, etc.) the mesh
  // is degenerate but valid — InstancedMesh accepts capacity 1 minimum,
  // so the Math.max guards against zero-cell rendering crashes on tiny
  // seeds. count is set to props.length below, so an over-provisioned
  // capacity-1 with 0 active is rendered as nothing.
  const capacity = Math.max(1, props.length);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3();
    for (let i = 0; i < props.length; i++) {
      const p = props[i]!;
      position.set(p.x, p.y + yOriginLift * p.scale, p.z);
      euler.set(0, p.rotation, 0);
      quaternion.setFromEuler(euler);
      scale.set(p.scale, p.scale, p.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = props.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [props, yOriginLift]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, capacity]}
      frustumCulled={false}
    >
      {geometry}
      {material}
    </instancedMesh>
  );
}
