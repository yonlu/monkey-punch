// Deterministic environmental prop placement shared between server and
// client. The output of generateProps(seed) must be bit-identical on
// every machine — props are NOT in the schema (CLAUDE.md rule 2
// derivation: regenerated on each client from state.seed). Any
// divergence here = different clients see different worlds.
//
// Algorithm:
//   - regular grid over [-PROP_AREA_HALF_EXTENT, +PROP_AREA_HALF_EXTENT]
//     stepped by SPACING in both X and Z
//   - cells whose grid center is inside SKIP_RADIUS are skipped entirely
//     (and consume zero rng calls — keeps the spawn area clean and the
//     stream stable)
//   - each remaining cell rolls one placement check; PROP_PROBABILITY
//     of cells receive a prop
//   - placed props consume 5 more rng calls in fixed order: jitterX,
//     jitterZ, kind, rotation, scale
//
// The PRNG is alea seeded with `seed.toString() + "_props"` — a distinct
// sub-seed so prop randomness does not alias with the room's mulberry32
// rng (which advances per gameplay tick). Both sides of the wire derive
// their stream from the same string.
//
// Y is sampled from terrainHeight(x, z) AFTER jitter. initTerrain(seed)
// MUST be called before generateProps(seed) — same seed in both — or
// terrainHeight throws.

import Alea from "alea";
import { TERRAIN_SIZE } from "./constants.js";
import { terrainHeight } from "./terrain.js";

export interface Prop {
  kind: number;     // 0 = tree, 1 = rock, 2 = bush
  x: number;
  z: number;
  y: number;        // terrainHeight(x, z) — props sit on the terrain
  rotation: number; // radians, rotation around Y axis, [0, 2π)
  scale: number;    // [0.8, 1.2)
}

// Half-extent of the rectangular area populated with props. Aligned
// with TERRAIN_SIZE so the rendered terrain is fully populated within
// the fog far plane (US-016 sets fog far = MAP_RADIUS * 1.5 ≈ 90; the
// terrain mesh extends to TERRAIN_SIZE / 2 = 100). Players cannot reach
// past MAP_RADIUS, but seeing distant trees through the fog gives the
// world depth instead of a barren ring beyond the playable area.
const PROP_AREA_HALF_EXTENT = TERRAIN_SIZE / 2;

const SPACING = 6;
const SKIP_RADIUS = 12;
const PROP_PROBABILITY = 0.6;

// Per-cell jitter range = 80% of spacing (i.e. ±40% of spacing around
// the cell center). Adjacent cells cannot swap places, so the visible
// grid structure is preserved while individual placements look organic.
const JITTER_RANGE = 0.8 * SPACING;
const JITTER_HALF = JITTER_RANGE / 2;

// Kind distribution thresholds — cumulative on roll ∈ [0, 1):
//   roll < TREE_THRESHOLD       → tree (0)  — 50%
//   roll < ROCK_THRESHOLD       → rock (1)  — 35%
//   else                         → bush (2)  — 15%
const TREE_THRESHOLD = 0.5;
const ROCK_THRESHOLD = 0.85;

const KIND_TREE = 0;
const KIND_ROCK = 1;
const KIND_BUSH = 2;

export function generateProps(seed: number): Prop[] {
  const prng = Alea(seed.toString() + "_props");
  const props: Prop[] = [];

  // Iteration is X-outer / Z-inner. Order is load-bearing for the
  // determinism snapshot — reordering reshuffles the rng stream.
  for (let cx = -PROP_AREA_HALF_EXTENT; cx <= PROP_AREA_HALF_EXTENT; cx += SPACING) {
    for (let cz = -PROP_AREA_HALF_EXTENT; cz <= PROP_AREA_HALF_EXTENT; cz += SPACING) {
      // Skip cells whose grid center sits inside the spawn area. These
      // cells do NOT consume rng — keeping the post-skip stream stable
      // independent of skip-radius tuning.
      if (Math.hypot(cx, cz) < SKIP_RADIUS) continue;

      if (prng() >= PROP_PROBABILITY) continue;

      const jitterX = prng() * JITTER_RANGE - JITTER_HALF;
      const jitterZ = prng() * JITTER_RANGE - JITTER_HALF;
      const x = cx + jitterX;
      const z = cz + jitterZ;

      const kindRoll = prng();
      const kind =
        kindRoll < TREE_THRESHOLD ? KIND_TREE : kindRoll < ROCK_THRESHOLD ? KIND_ROCK : KIND_BUSH;

      const rotation = prng() * Math.PI * 2;
      const scale = 0.8 + prng() * 0.4;

      const y = terrainHeight(x, z);

      props.push({ kind, x, z, y, rotation, scale });
    }
  }

  return props;
}
