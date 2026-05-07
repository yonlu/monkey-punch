import { describe, it, expect } from "vitest";
import { xpForLevel } from "../src/constants.js";

describe("xpForLevel", () => {
  it("is strictly increasing on [1, 50]", () => {
    let prev = -Infinity;
    for (let lvl = 1; lvl <= 50; lvl++) {
      const need = xpForLevel(lvl);
      expect(need).toBeGreaterThan(prev);
      prev = need;
    }
  });

  it("matches the canonical formula", () => {
    expect(xpForLevel(1)).toBe(6);   // 5 + 1
    expect(xpForLevel(2)).toBe(14);  // 10 + 4
    expect(xpForLevel(3)).toBe(24);  // 15 + 9
    expect(xpForLevel(5)).toBe(50);  // 25 + 25
  });
});
