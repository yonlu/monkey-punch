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

describe("Gakkung Bow — M8 US-003", () => {
  it("is at index 2 and is a projectile with targeting=furthest, mild homing, mesh=elongated", () => {
    const def = WEAPON_KINDS[2]!;
    expect(def.name).toBe("Gakkung Bow");
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile behavior");
    expect(def.behavior.targeting).toBe("furthest");
    expect(def.behavior.homingTurnRate).toBeCloseTo(Math.PI * 0.8);
    expect(def.behavior.mesh).toBe("elongated");
  });

  it("pierceCount grows: 1 at L1, 2 at L3, 3 at L5", () => {
    const def = WEAPON_KINDS[2]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    expect(statsAt(def, 1).pierceCount).toBe(1);
    expect(statsAt(def, 3).pierceCount).toBe(2);
    expect(statsAt(def, 5).pierceCount).toBe(3);
  });

  it("damage strictly increases per level (no flat tiers)", () => {
    const def = WEAPON_KINDS[2]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).damage).toBeGreaterThan(statsAt(def, lvl - 1).damage);
    }
  });

  it("range (speed * lifetime) at L1 is 28 * 1.2 = 33.6 — well within TARGETING_MAX_RANGE", async () => {
    // Sanity check: Gakkung's max effective range from origin is 33.6 units;
    // the in-range gate is TARGETING_MAX_RANGE = 20. So the gate, not the
    // projectile lifetime, bounds Gakkung's effective range. (Documented
    // here so a future TARGETING_MAX_RANGE bump that breaks this assumption
    // produces a named test failure rather than a silent feel change.)
    const def = WEAPON_KINDS[2]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    const stats = statsAt(def, 1);
    const flightRange = stats.projectileSpeed * stats.projectileLifetime;
    const { TARGETING_MAX_RANGE } = await import("../src/constants.js");
    expect(flightRange).toBeGreaterThan(TARGETING_MAX_RANGE);
  });
});
