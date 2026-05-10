import { describe, it, expect } from "vitest";
import { clampDirection } from "../src/input.js";

describe("clampDirection", () => {
  it("returns zero for non-finite components", () => {
    expect(clampDirection(NaN, 0)).toEqual({ x: 0, z: 0 });
    expect(clampDirection(0, NaN)).toEqual({ x: 0, z: 0 });
    expect(clampDirection(Infinity, 0)).toEqual({ x: 0, z: 0 });
    expect(clampDirection(0, -Infinity)).toEqual({ x: 0, z: 0 });
  });

  it("returns zero for zero input", () => {
    expect(clampDirection(0, 0)).toEqual({ x: 0, z: 0 });
  });

  it("preserves sub-unit magnitudes unchanged", () => {
    const r = clampDirection(0.5, 0);
    expect(r.x).toBeCloseTo(0.5);
    expect(r.z).toBe(0);
  });

  it("preserves exactly-unit magnitudes unchanged", () => {
    const r = clampDirection(1, 0);
    expect(r.x).toBe(1);
    expect(r.z).toBe(0);
  });

  it("rescales over-unit magnitudes to length 1, preserving direction", () => {
    const r = clampDirection(3, 4); // length 5
    expect(r.x).toBeCloseTo(0.6);
    expect(r.z).toBeCloseTo(0.8);
    expect(Math.hypot(r.x, r.z)).toBeCloseTo(1);
  });

  it("preserves negative components", () => {
    const r = clampDirection(-3, -4);
    expect(r.x).toBeCloseTo(-0.6);
    expect(r.z).toBeCloseTo(-0.8);
  });
});

