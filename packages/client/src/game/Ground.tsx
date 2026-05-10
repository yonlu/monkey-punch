import { useMemo } from "react";
import { TERRAIN_SIZE, terrainHeight } from "@mp/shared";
import {
  BufferGeometry,
  type Mesh,
  PlaneGeometry,
  UniformsLib,
  UniformsUtils,
} from "three";

// Module-level handle to the rendered terrain mesh, exposed so other
// systems (currently CameraRig's US-008 occlusion raycast) can target
// ONLY the terrain — not props, players, or enemies. Mirrors the
// camera.ts module-state pattern: a getter avoids prop-drilling a ref
// through the React tree, and the callback ref below sets/clears it on
// mount/unmount so a stale reference cannot survive a Canvas tear-down.
let terrainMeshRef: Mesh | null = null;
export function getTerrainMesh(): Mesh | null {
  return terrainMeshRef;
}

const SEGMENTS = 200;

// Vertex shader: forward the world-space normal so the fragment can decide
// flat-vs-steep purely from terrain orientation, independent of camera.
// US-016 fog support: include Three's fog_pars/fog_vertex chunks. fog_vertex
// reads `mvPosition` to set vFogDepth, so mvPosition must be a real local
// before the include (cannot inline projectionMatrix * modelViewMatrix * pos).
const VERT_SHADER = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Fragment shader: smoothstep over (1 - normal.y) so true-flat (normal.y=1)
// is grass and true-vertical (normal.y=0) is rock, with a soft transition
// across the 0.2..0.5 band of slope values per the PRD. fog_fragment mixes
// gl_FragColor.rgb toward fogColor by the linear-fog factor — distant
// terrain fades into the sky color set on scene.fog.
const FRAG_SHADER = /* glsl */ `
  #include <fog_pars_fragment>
  varying vec3 vWorldNormal;
  void main() {
    vec3 grass = vec3(0.30, 0.55, 0.20);
    vec3 rock  = vec3(0.40, 0.35, 0.30);
    float steep = smoothstep(0.2, 0.5, 1.0 - vWorldNormal.y);
    gl_FragColor = vec4(mix(grass, rock, steep), 1.0);
    #include <fog_fragment>
  }
`;

function buildTerrainGeometry(): BufferGeometry {
  const geo = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, SEGMENTS, SEGMENTS);
  // Rotate flat into the XZ plane so vertex.y maps directly to world Y.
  // Doing this BEFORE displacement means the displacement axis is world Y
  // and computeVertexNormals produces world-space normals (modelMatrix is
  // identity), which is what the slope shader expects.
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function Ground() {
  // Keyed only on the module-level noise function — the calling component
  // (GameView) initializes terrain before this renders, and it never
  // re-inits within the lifetime of a Ground mount, so a single build is
  // enough.
  const geometry = useMemo(buildTerrainGeometry, []);

  // US-016 fog: ShaderMaterial does not auto-merge UniformsLib.fog the
  // way MeshStandardMaterial does. Without this merge, WebGLRenderer's
  // refreshFogUniforms tries to write to fogColor/fogNear/fogFar slots
  // that don't exist on the material, and the fog chunks compile against
  // undefined uniforms — terrain stays unfogged. `fog` prop on the
  // material flips the USE_FOG define so the include chunks become
  // active when scene.fog is set.
  const uniforms = useMemo(() => UniformsUtils.merge([UniformsLib.fog]), []);

  return (
    <mesh
      ref={(m) => { terrainMeshRef = m ?? null; }}
      geometry={geometry}
    >
      <shaderMaterial
        vertexShader={VERT_SHADER}
        fragmentShader={FRAG_SHADER}
        uniforms={uniforms}
        fog
      />
    </mesh>
  );
}
