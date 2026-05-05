export * from "./constants.js";
export * from "./schema.js";
export * from "./messages.js";
export * from "./rules.js";
export * from "./rng.js";
export * from "./weapons.js";

import { WEAPON_KINDS, isOrbitWeapon } from "./weapons.js";
import { MAX_ORB_COUNT_EVER } from "./constants.js";

// Module-load assertion: every orbit weapon's max-level orbCount must fit
// into the InstancedMesh capacity reserved by MAX_ORB_COUNT_EVER. Failing
// at module load is the right time — the alternative is a silent
// out-of-bounds in the client's per-frame matrix update.
{
  let max = 0;
  for (const def of WEAPON_KINDS) {
    if (isOrbitWeapon(def)) {
      for (const lvl of def.levels) {
        if (lvl.orbCount > max) max = lvl.orbCount;
      }
    }
  }
  if (max > MAX_ORB_COUNT_EVER) {
    throw new Error(
      `MAX_ORB_COUNT_EVER=${MAX_ORB_COUNT_EVER} but WEAPON_KINDS contains an orbit weapon with orbCount=${max}; ` +
        `bump MAX_ORB_COUNT_EVER in shared/constants.ts.`,
    );
  }
}
