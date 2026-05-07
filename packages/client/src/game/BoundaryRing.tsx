import { MAP_RADIUS } from "@mp/shared";

export function BoundaryRing() {
  return (
    <mesh rotation-x={Math.PI / 2}>
      <torusGeometry args={[MAP_RADIUS, 0.05, 8, 128]} />
      <meshStandardMaterial
        color="#5a8aff"
        emissive="#5a8aff"
        emissiveIntensity={0.4}
      />
    </mesh>
  );
}
