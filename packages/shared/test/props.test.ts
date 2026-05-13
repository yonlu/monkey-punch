import { describe, it, expect } from "vitest";
import { generateProps } from "../src/props.js";

describe("generateProps — disabled (returns empty array)", () => {
  it("returns an empty array for arbitrary seeds", () => {
    for (const seed of [0, 1, 42, 99999, 1_000_000]) {
      expect(generateProps(seed)).toEqual([]);
    }
  });

  it("is referentially stable (same shape every call)", () => {
    expect(generateProps(42)).toEqual(generateProps(42));
    expect(generateProps(7)).toEqual(generateProps(7));
  });
});
