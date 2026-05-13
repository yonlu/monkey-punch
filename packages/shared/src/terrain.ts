// Terrain heights for monkey-punch. Currently flat (Y=0 everywhere) by
// design — the noise-driven authoring approach was retired in favor of a
// future Unity-authored pipeline (sculpt in Unity Editor, export to a
// shared file, server loads at startup). Until that lands, terrainHeight
// returns 0 unconditionally. rules.ts ground-snap still works (players
// and enemies sit at their respective GROUND_OFFSET); the server still
// builds and ships a heightmap to clients via terrain_data — it's just
// all zeros.

export function initTerrain(_seed: number): void {
  // No-op. Kept because ~15 call sites (server room lifecycle, tests,
  // deprecated TS client) still call it; deleting it is a refactor
  // beyond the current scope. The function will get a real body back
  // when the Unity-authored pipeline lands (loading the exported file).
}

export function terrainHeight(_x: number, _z: number): number {
  return 0;
}
