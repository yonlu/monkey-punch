import { MAP_RADIUS } from "@mp/shared";

const GROUND_SIZE = MAP_RADIUS * 2.2;

export function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
      <meshStandardMaterial color="#2c3e50" />
    </mesh>
  );
}
