// Environmental props (trees / rocks / bushes). Currently disabled —
// generateProps returns an empty array for every seed by design. The
// procedural-generation approach was retired alongside the noise-driven
// terrain function; props will return when the Unity-authored terrain
// pipeline lands (sculpt + hand-place in Unity Editor, export to a
// shared file, server loads at startup).
//
// The function signature and Prop type are intentionally preserved so
// the wire message (TerrainDataMessage.props) and the server's
// terrain_data payload continue to compile and ship a (now empty)
// props array. Unity's TerrainStreamer iterates over zero entries and
// builds no prop GameObjects.

export interface Prop {
  kind: number;     // 0 = tree, 1 = rock, 2 = bush
  x: number;
  z: number;
  y: number;        // ground height at the prop's (x, z)
  rotation: number; // radians, rotation around Y axis, [0, 2π)
  scale: number;    // [0.8, 1.2)
}

export function generateProps(_seed: number): Prop[] {
  return [];
}
