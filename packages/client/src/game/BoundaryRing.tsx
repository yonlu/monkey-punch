import { MAP_RADIUS } from "@mp/shared";
import { DoubleSide } from "three";

// PRD US-003: replace the M6 thin ring on the ground with a tall cylinder
// shell at the play-area boundary. A vertical cylindrical wall is visible
// from any vantage — including from inside a valley where a flat ring
// disappears behind terrain. Open on top/bottom so the shell reads as a
// boundary, not a dome.
const CYLINDER_HEIGHT = 40;
const CYLINDER_SEGMENTS = 96;

export function BoundaryRing() {
  return (
    <mesh position={[0, CYLINDER_HEIGHT / 2, 0]}>
      <cylinderGeometry
        args={[MAP_RADIUS, MAP_RADIUS, CYLINDER_HEIGHT, CYLINDER_SEGMENTS, 1, true]}
      />
      <meshStandardMaterial
        color="#5a8aff"
        emissive="#5a8aff"
        emissiveIntensity={0.4}
        side={DoubleSide}
        transparent
        opacity={0.35}
      />
    </mesh>
  );
}
