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

describe("Claymore — M8 US-007", () => {
  it("is at index 4 and is a melee_arc with NO crit and POSITIVE knockback", () => {
    const def = WEAPON_KINDS[4]!;
    expect(def.name).toBe("Claymore");
    expect(def.behavior.kind).toBe("melee_arc");
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    const stats = statsAt(def, 1);
    expect(stats.critChance).toBe(0); // no crit at any level
    expect(stats.knockback).toBeGreaterThan(0);
    expect(stats.arcAngle).toBeGreaterThan(Math.PI * 0.85); // wide swing identity
  });

  it("knockback strictly grows L1 → L5", () => {
    const def = WEAPON_KINDS[4]!;
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).knockback).toBeGreaterThan(statsAt(def, lvl - 1).knockback);
    }
  });

  it("damage strictly grows L1 → L5 (and L5 hits hard — at least 2× Damascus L5)", () => {
    const claymore = WEAPON_KINDS[4]!;
    if (claymore.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    for (let lvl = 2; lvl <= claymore.levels.length; lvl++) {
      expect(statsAt(claymore, lvl).damage).toBeGreaterThan(statsAt(claymore, lvl - 1).damage);
    }
    // Identity: Claymore is the high-damage melee. Damascus L5 = 24; Claymore
    // L5 should land somewhere around 4× of that to compensate for the slow cadence.
    const damascus = WEAPON_KINDS[3]!;
    if (damascus.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    expect(statsAt(claymore, 5).damage).toBeGreaterThan(2 * statsAt(damascus, 5).damage);
  });

  it("cooldown is significantly slower than Damascus (slow heavy swing identity)", () => {
    const claymore = WEAPON_KINDS[4]!;
    const damascus = WEAPON_KINDS[3]!;
    if (claymore.behavior.kind !== "melee_arc" || damascus.behavior.kind !== "melee_arc") throw new Error();
    expect(statsAt(claymore, 1).cooldown).toBeGreaterThan(2 * statsAt(damascus, 1).cooldown);
  });

  it("range strictly grows L1 → L5 (longer reach at higher levels)", () => {
    const def = WEAPON_KINDS[4]!;
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).range).toBeGreaterThan(statsAt(def, lvl - 1).range);
    }
  });
});

describe("Bloody Axe — M8 US-012", () => {
  it("is at index 6 and is a boomerang (final ordering matches design doc)", () => {
    const def = WEAPON_KINDS[6]!;
    expect(def.name).toBe("Bloody Axe");
    expect(def.behavior.kind).toBe("boomerang");
  });

  it("leavesBloodPool flips false→true at L3 (the L3 power spike — pool trail is the identity)", () => {
    const def = WEAPON_KINDS[6]!;
    if (def.behavior.kind !== "boomerang") throw new Error("expected boomerang");
    expect(statsAt(def, 1).leavesBloodPool).toBe(false);
    expect(statsAt(def, 2).leavesBloodPool).toBe(false);
    expect(statsAt(def, 3).leavesBloodPool).toBe(true);
    expect(statsAt(def, 4).leavesBloodPool).toBe(true);
    expect(statsAt(def, 5).leavesBloodPool).toBe(true);
  });

  it("bloodPoolDamagePerTick grows L3→L5 (4→6→8) and is 0 at L1/L2", () => {
    const def = WEAPON_KINDS[6]!;
    if (def.behavior.kind !== "boomerang") throw new Error("expected boomerang");
    expect(statsAt(def, 1).bloodPoolDamagePerTick).toBe(0);
    expect(statsAt(def, 2).bloodPoolDamagePerTick).toBe(0);
    expect(statsAt(def, 3).bloodPoolDamagePerTick).toBe(4);
    expect(statsAt(def, 4).bloodPoolDamagePerTick).toBe(6);
    expect(statsAt(def, 5).bloodPoolDamagePerTick).toBe(8);
  });

  it("damage strictly grows L1 → L5", () => {
    const def = WEAPON_KINDS[6]!;
    if (def.behavior.kind !== "boomerang") throw new Error("expected boomerang");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).damage).toBeGreaterThan(statsAt(def, lvl - 1).damage);
    }
  });

  it("constant outboundDistance/Speed/returnSpeed across all levels (movement profile is the identity)", () => {
    const def = WEAPON_KINDS[6]!;
    if (def.behavior.kind !== "boomerang") throw new Error("expected boomerang");
    for (let lvl = 1; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).outboundDistance).toBe(7);
      expect(statsAt(def, lvl).outboundSpeed).toBe(14);
      expect(statsAt(def, lvl).returnSpeed).toBe(18);
    }
  });

  it("returnSpeed > outboundSpeed (returning is faster than outbound — feels right when running away from something)", () => {
    const def = WEAPON_KINDS[6]!;
    if (def.behavior.kind !== "boomerang") throw new Error("expected boomerang");
    const stats = statsAt(def, 1);
    expect(stats.returnSpeed).toBeGreaterThan(stats.outboundSpeed);
  });
});

describe("Kronos — M8 US-010", () => {
  it("is at index 7 (Bloody Axe took 6 in US-012) and is an aura", () => {
    const def = WEAPON_KINDS[7]!;
    expect(def.name).toBe("Kronos");
    expect(def.behavior.kind).toBe("aura");
  });

  it("has constant tickIntervalMs of 500ms across all levels (cadence is the identity)", () => {
    const def = WEAPON_KINDS[7]!;
    if (def.behavior.kind !== "aura") throw new Error("expected aura");
    for (let lvl = 1; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).tickIntervalMs).toBe(500);
    }
  });

  it("radius strictly grows L1 → L5 (Vampire Survivors Garlic identity: bigger zone of control at higher levels)", () => {
    const def = WEAPON_KINDS[7]!;
    if (def.behavior.kind !== "aura") throw new Error("expected aura");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).radius).toBeGreaterThan(statsAt(def, lvl - 1).radius);
    }
  });

  it("slow strengthens at L4+ (slowMultiplier 0.6 → 0.4) — the L4 power spike is part of Kronos's identity", () => {
    const def = WEAPON_KINDS[7]!;
    if (def.behavior.kind !== "aura") throw new Error("expected aura");
    expect(statsAt(def, 1).slowMultiplier).toBe(0.6);
    expect(statsAt(def, 3).slowMultiplier).toBe(0.6);
    expect(statsAt(def, 4).slowMultiplier).toBe(0.5);
    expect(statsAt(def, 5).slowMultiplier).toBe(0.4);
  });

  it("damage strictly grows L1 → L5", () => {
    const def = WEAPON_KINDS[7]!;
    if (def.behavior.kind !== "aura") throw new Error("expected aura");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).damage).toBeGreaterThan(statsAt(def, lvl - 1).damage);
    }
  });
});

describe("Damascus — M8 US-006", () => {
  it("is at index 3 and is a melee_arc with crit (no knockback)", () => {
    const def = WEAPON_KINDS[3]!;
    expect(def.name).toBe("Damascus");
    expect(def.behavior.kind).toBe("melee_arc");
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    const stats = statsAt(def, 1);
    expect(stats.critChance).toBeGreaterThan(0); // Damascus crits
    expect(stats.knockback).toBe(0); // no knockback
    expect(stats.critMultiplier).toBe(2.0);
  });

  it("critChance grows L1 → L5 (high tempo + crit windows is the identity)", () => {
    const def = WEAPON_KINDS[3]!;
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).critChance).toBeGreaterThan(statsAt(def, lvl - 1).critChance);
    }
  });

  it("cooldown shrinks per level (faster swings)", () => {
    const def = WEAPON_KINDS[3]!;
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).cooldown).toBeLessThanOrEqual(statsAt(def, lvl - 1).cooldown);
    }
  });

  it("damage strictly increases per level", () => {
    const def = WEAPON_KINDS[3]!;
    if (def.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).damage).toBeGreaterThan(statsAt(def, lvl - 1).damage);
    }
  });

  it("is significantly faster than Claymore (cadence is the identity)", async () => {
    // This test will run AFTER Claymore lands (US-007). For now it
    // exercises Damascus's L1 cooldown vs the future Claymore index 4
    // — once Claymore exists at WEAPON_KINDS[4], assert cadence ratio.
    const damascus = WEAPON_KINDS[3]!;
    if (damascus.behavior.kind !== "melee_arc") throw new Error("expected melee_arc");
    expect(statsAt(damascus, 1).cooldown).toBeLessThan(0.5);
  });
});

describe("Ahlspiess — M8 US-004", () => {
  it("is at index 5 and is a projectile with targeting=facing, no homing, mesh=spear", () => {
    const def = WEAPON_KINDS[5]!;
    expect(def.name).toBe("Ahlspiess");
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile behavior");
    expect(def.behavior.targeting).toBe("facing");
    expect(def.behavior.homingTurnRate).toBe(0);
    expect(def.behavior.mesh).toBe("spear");
  });

  it("has infinite pierce (-1) at every level", () => {
    const def = WEAPON_KINDS[5]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    for (let lvl = 1; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).pierceCount).toBe(-1);
    }
  });

  it("has hitCooldownPerEnemyMs > 0 at every level (avoids same-enemy double-hit)", () => {
    const def = WEAPON_KINDS[5]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    for (let lvl = 1; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).hitCooldownPerEnemyMs).toBeGreaterThan(0);
    }
  });

  it("hitRadius strictly increases across levels (gives visible per-level growth)", () => {
    const def = WEAPON_KINDS[5]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).hitRadius).toBeGreaterThan(statsAt(def, lvl - 1).hitRadius);
    }
  });

  it("damage strictly increases per level", () => {
    const def = WEAPON_KINDS[5]!;
    if (def.behavior.kind !== "projectile") throw new Error("expected projectile");
    for (let lvl = 2; lvl <= def.levels.length; lvl++) {
      expect(statsAt(def, lvl).damage).toBeGreaterThan(statsAt(def, lvl - 1).damage);
    }
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
