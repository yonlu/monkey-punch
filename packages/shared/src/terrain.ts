// Deterministic heightmapped terrain shared between server simulation and
// client prediction. Bit-identical output for the same (seed, x, z) is
// load-bearing — any divergence between server and client desyncs the
// jump landing position. The snapshot test in test/terrain.test.ts is the
// early-warning system; do not weaken it.
//
// initTerrain(seed) builds a 2D simplex permutation table from an alea PRNG
// seeded with `seed.toString()`. terrainHeight(x, z) is a pure function of
// (perm-table, x, z) once initialized — repeated calls with the same args
// return the exact same float.

import Alea from "alea";
import { createNoise2D, type NoiseFunction2D } from "simplex-noise";

const SCALE_1 = 0.02;
const AMP_1 = 4;
const SCALE_2 = 0.08;
const AMP_2 = 1.2;
const SCALE_3 = 0.20;
const AMP_3 = 0.3;

// Within this radius of (0, 0), height is ramped down to 0 so spawning
// players don't materialize inside a hill. The ramp uses h * t * t with
// t = distFromOrigin / SPAWN_FLAT_RADIUS clamped to [0, 1] — at the
// origin t = 0 → height = 0; at the boundary t = 1 → height passes
// through unchanged.
const SPAWN_FLAT_RADIUS = 8;

let noise2D: NoiseFunction2D | null = null;

export function initTerrain(seed: number): void {
  const prng = Alea(seed.toString());
  noise2D = createNoise2D(prng);
}

export function terrainHeight(x: number, z: number): number {
  if (noise2D === null) {
    throw new Error(
      "terrainHeight called before initTerrain — call initTerrain(state.seed) on room create / room join.",
    );
  }
  const h =
    noise2D(x * SCALE_1, z * SCALE_1) * AMP_1 +
    noise2D(x * SCALE_2, z * SCALE_2) * AMP_2 +
    noise2D(x * SCALE_3, z * SCALE_3) * AMP_3;

  const dist = Math.hypot(x, z);
  if (dist >= SPAWN_FLAT_RADIUS) return h;
  const t = dist / SPAWN_FLAT_RADIUS;
  return h * t * t;
}
