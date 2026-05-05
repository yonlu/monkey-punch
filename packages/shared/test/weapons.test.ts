import { describe, it, expect } from "vitest";
import { WEAPON_KINDS, statsAt } from "../src/weapons.js";

describe("WEAPON_KINDS", () => {
  it("every kind has at least one level", () => {
    for (const def of WEAPON_KINDS) {
      expect(def.levels.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("Bolt is at index 0 and is a projectile", () => {
    expect(WEAPON_KINDS[0]!.name).toBe("Bolt");
    expect(WEAPON_KINDS[0]!.behavior.kind).toBe("projectile");
  });
});

describe("statsAt", () => {
  it("returns level 1 stats for level=1", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 1)).toBe(def.levels[0]);
  });

  it("clamps to level 1 for level<=0", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 0)).toBe(def.levels[0]);
    expect(statsAt(def, -3)).toBe(def.levels[0]);
  });

  it("clamps to max level for level beyond defined", () => {
    const def = WEAPON_KINDS[0]!;
    const max = def.levels.length;
    expect(statsAt(def, max + 5)).toBe(def.levels[max - 1]);
  });

  it("floors fractional levels and treats NaN as level 1", () => {
    const def = WEAPON_KINDS[0]!;
    expect(statsAt(def, 1.7)).toBe(def.levels[0]);
    expect(statsAt(def, 2.99)).toBe(def.levels[1]);
    expect(statsAt(def, NaN)).toBe(def.levels[0]);
  });
});

describe("Orbit weapon", () => {
  it("is at index 1 and is an orbit", () => {
    expect(WEAPON_KINDS[1]!.name).toBe("Orbit");
    expect(WEAPON_KINDS[1]!.behavior.kind).toBe("orbit");
  });

  it("max-level orbCount fits in MAX_ORB_COUNT_EVER (asserted at module load)", async () => {
    // The assertion in shared/index.ts runs at import time. If we got here,
    // it passed. This test exists so a future bump that exceeds the bound
    // produces a named test failure rather than only a vague import error.
    const orbit = WEAPON_KINDS[1]!;
    if (orbit.behavior.kind !== "orbit") throw new Error("WEAPON_KINDS[1] not orbit");
    const max = Math.max(...orbit.levels.map((l) => l.orbCount));
    const { MAX_ORB_COUNT_EVER } = await import("../src/constants.js");
    expect(max).toBeLessThanOrEqual(MAX_ORB_COUNT_EVER);
  });
});
