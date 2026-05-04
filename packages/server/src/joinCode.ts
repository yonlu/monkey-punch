// Excludes ambiguous glyphs: 0, 1, I, L, O.
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateJoinCode(rng: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(rng() * JOIN_CODE_ALPHABET.length);
    code += JOIN_CODE_ALPHABET.charAt(idx);
  }
  return code;
}
