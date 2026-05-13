namespace MonkeyPunch.UI {
  // Display names mirroring packages/shared/src/weapons.ts WEAPON_KINDS
  // and items.ts ITEM_KINDS. Kind == index in both tables. Names only;
  // full stat tables are out of scope for the Phase 7 MVP (level-up
  // overlay shows "Magic Missile +1" rather than the per-level numeric
  // effects). When the predictor or HUD needs per-level numbers, add a
  // separate table here — DO NOT extend with behavior.
  //
  // Drift between this list and the TS source is silent. Bump cadence
  // is low (M5..M9 added 8 weapons + 6 items), but worth scripting a
  // typecheck if it becomes a problem.
  public static class Names {
    public static readonly string[] Weapons = new string[] {
      "Bolt",               // 0
      "Orbit",              // 1
      "Gakkung Bow",        // 2
      "Damascus",           // 3
      "Claymore",           // 4
      "Ahlspiess",          // 5
      "Bloody Axe",         // 6
      "Kronos",             // 7
    };

    public static readonly string[] Items = new string[] {
      "Ifrit's Talisman",   // 0  damage_mult
      "Wind of Verdure",    // 1  cooldown_mult
      "Apple of Idun",      // 2  max_hp_mult
      "Sleipnir",           // 3  speed_mult
      "Magnifier",          // 4  magnet_mult
      "Bunny Top Hat",      // 5  xp_mult
    };

    public static string WeaponName(int kind) =>
      kind >= 0 && kind < Weapons.Length ? Weapons[kind] : $"Weapon#{kind}";

    public static string ItemName(int kind) =>
      kind >= 0 && kind < Items.Length ? Items[kind] : $"Item#{kind}";

    // Item effect → glyph map. Mirrors web client's ITEM_ICONS in
    // packages/client/src/game/LevelUpOverlay.tsx. Dispatches on enum
    // (not item name) — rule 12 clean.
    public static string ItemGlyph(int kind) {
      switch (kind) {
        case 0: return "🔥";  // Ifrit's Talisman   (damage_mult)
        case 1: return "⚡";  // Wind of Verdure    (cooldown_mult)
        case 2: return "❤";   // Apple of Idun      (max_hp_mult)
        case 3: return "🥾";  // Sleipnir           (speed_mult)
        case 4: return "🔍";  // Magnifier          (magnet_mult)
        case 5: return "🐰";  // Bunny Top Hat      (xp_mult)
        default: return "?";
      }
    }

    public static string WeaponGlyph(int kind) {
      switch (kind) {
        case 0: return "⚡";  // Bolt
        case 1: return "🏹";  // Gakkung Bow
        case 2: return "🔱";  // Ahlspiess
        case 3: return "🌀";  // Orbit
        case 4: return "⚔";   // Damascus
        case 5: return "🛡";  // Claymore
        case 6: return "✨";  // Kronos
        case 7: return "🪓";  // Bloody Axe
        default: return "?";
      }
    }
  }
}
