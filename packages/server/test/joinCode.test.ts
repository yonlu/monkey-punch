import { describe, it, expect } from "vitest";
import { mulberry32 } from "@mp/shared";
import { generateJoinCode, JOIN_CODE_ALPHABET } from "../src/joinCode.js";

const ALPHABET_RE = new RegExp(`^[${JOIN_CODE_ALPHABET}]+$`);

describe("generateJoinCode", () => {
  it("returns a 4-character string", () => {
    expect(generateJoinCode()).toHaveLength(4);
  });

  it("uses only the unambiguous alphabet (no 0/O/1/I/L)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(ALPHABET_RE);
    }
  });

  it("is deterministic when the same RNG is supplied", () => {
    const seed = 12345;
    const codeA = generateJoinCode(mulberry32(seed));
    const codeB = generateJoinCode(mulberry32(seed));
    expect(codeA).toBe(codeB);
  });

  it("produces varied output across calls (smoke test)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(generateJoinCode());
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});
