import { useMemo } from "react";
import { TERRAIN_SIZE, terrainHeight } from "@mp/shared";
import { BufferGeometry, PlaneGeometry } from "three";

const SEGMENTS = 200;

// Vertex shader: forward the world-space normal so the fragment can decide
// flat-vs-steep purely from terrain orientation, independent of camera.
const VERT_SHADER = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fragment shader: smoothstep over (1 - normal.y) so true-flat (normal.y=1)
// is grass and true-vertical (normal.y=0) is rock, with a soft transition
// across the 0.2..0.5 band of slope values per the PRD.
const FRAG_SHADER = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vec3 grass = vec3(0.30, 0.55, 0.20);
    vec3 rock  = vec3(0.40, 0.35, 0.30);
    float steep = smoothstep(0.2, 0.5, 1.0 - vWorldNormal.y);
    gl_FragColor = vec4(mix(grass, rock, steep), 1.0);
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

  return (
    <mesh geometry={geometry} receiveShadow>
      <shaderMaterial vertexShader={VERT_SHADER} fragmentShader={FRAG_SHADER} />
    </mesh>
  );
}
