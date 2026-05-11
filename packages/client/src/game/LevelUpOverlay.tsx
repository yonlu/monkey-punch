// packages/client/src/game/LevelUpOverlay.tsx
import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import type { Player, RoomState, LevelUpChoice, ItemEffect } from "@mp/shared";
import { SIM_DT_S, WEAPON_KINDS, ITEM_KINDS, LEVEL_UP_CHOICE_ITEM, describeItemEffect } from "@mp/shared";

// M9 US-007: per-effect emoji icons for item cards. Lookup table keyed
// by ItemEffect enum value — adding a new effect kind requires one new
// entry here. Dispatches on enum, never on item name (rule 12).
const ITEM_ICONS: Record<ItemEffect, string> = {
  damage_mult: "🔥",   // Ifrit's Talisman flame
  cooldown_mult: "⚡",
  max_hp_mult: "❤️",
  speed_mult: "🥾",
  magnet_mult: "🔍",
  xp_mult: "🐰",
};

// Card style override for items — gold border + warm tint distinguishes
// items from the cooler blue weapons. Composed on top of CARD_STYLE
// at render time.
const ITEM_CARD_STYLE_OVERRIDE: React.CSSProperties = {
  background: "rgba(40,30,15,0.85)",
  border: "1px solid rgba(230,190,90,0.7)",
  boxShadow: "0 0 10px rgba(230,190,90,0.25)",
};

const CARD_TAG_STYLE: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1,
  opacity: 0.7,
  marginBottom: 2,
};

const OVERLAY_STYLE: React.CSSProperties = {
  position: "fixed",
  bottom: 88, // sits above the PlayerHud row
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "center",
  zIndex: 1100,
  pointerEvents: "auto",
};

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(20,24,30,0.85)",
  border: "1px solid rgba(120,200,255,0.4)",
  borderRadius: 6,
  padding: "10px 14px",
  color: "#fff",
  font: "13px/1.4 ui-monospace, Menlo, monospace",
  minWidth: 160,
  textAlign: "center",
  cursor: "pointer",
  userSelect: "none",
};

const COUNTDOWN_STYLE: React.CSSProperties = {
  background: "rgba(0,0,0,0.6)",
  color: "#fff",
  font: "11px ui-monospace, Menlo, monospace",
  padding: "2px 8px",
  borderRadius: 3,
};

type CardLabel = {
  line1: string;
  line2: string;
  // M9 US-007: card classification for visual treatment. `isItem` drives
  // the gold-border style override; `icon` prepended to line1 per
  // effect (items only — weapons get no icon at this milestone).
  isItem: boolean;
  icon: string;
};

// M9 US-002 + US-006 iteration + US-007 polish: choices are structured
// {type, index}. Weapon vs item dispatch happens here. Items show
// effect icon + human-readable description; weapons stay on the
// minimal "L1 → L2" treatment (per-level weapon details vary by
// behavior — full weapon descriptions are a future polish-pass concern).
function describeChoice(localPlayer: Player, choice: LevelUpChoice): CardLabel {
  if (choice.type === LEVEL_UP_CHOICE_ITEM) {
    const def = ITEM_KINDS[choice.index];
    if (!def) return { line1: "?", line2: "?", isItem: true, icon: "" };
    const icon = ITEM_ICONS[def.effect] ?? "";
    const existing = localPlayer.items.find((it) => it.kind === choice.index);
    if (!existing) {
      return {
        line1: def.name,
        line2: `NEW → ${describeItemEffect(def, 1)}`,
        isItem: true,
        icon,
      };
    }
    const cap = def.values.length;
    if (existing.level >= cap) {
      return {
        line1: def.name,
        line2: `L${cap} MAX (${describeItemEffect(def, cap)})`,
        isItem: true,
        icon,
      };
    }
    return {
      line1: def.name,
      line2: `${describeItemEffect(def, existing.level)} → ${describeItemEffect(def, existing.level + 1)}`,
      isItem: true,
      icon,
    };
  }
  const def = WEAPON_KINDS[choice.index];
  if (!def) return { line1: "?", line2: "?", isItem: false, icon: "" };
  const existing = localPlayer.weapons.find((w) => w.kind === choice.index);
  if (!existing) {
    return { line1: def.name, line2: "NEW", isItem: false, icon: "" };
  }
  const cap = def.levels.length;
  if (existing.level >= cap) {
    return { line1: def.name, line2: `L${cap} (MAX)`, isItem: false, icon: "" };
  }
  return {
    line1: def.name,
    line2: `L${existing.level} → L${existing.level + 1}`,
    isItem: false,
    icon: "",
  };
}

export type LevelUpOverlayProps = {
  room: Room<RoomState>;
};

/**
 * Per spec §AD6 + §AD10. Reads pendingLevelUp/levelUpChoices/
 * levelUpDeadlineTick directly from schema each rAF (same pattern as
 * PlayerHud). Source of truth for visibility is the schema; the
 * reconnection path (verification step 10) falls out for free because
 * Colyseus re-syncs full state on resume.
 */
export function LevelUpOverlay({ room }: LevelUpOverlayProps) {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);

  // rAF re-render driver. Same pattern as PlayerHud.
  useEffect(() => {
    const tick = () => {
      force((n) => (n + 1) & 0x7fffffff);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, []);

  const localPlayer = room.state.players.get(room.sessionId);
  if (
    !localPlayer ||
    localPlayer.downed ||
    !localPlayer.pendingLevelUp ||
    localPlayer.levelUpChoices.length === 0
  ) {
    return null;
  }

  const remainingTicks = Math.max(0, localPlayer.levelUpDeadlineTick - room.state.tick);
  const remainingS = (remainingTicks * SIM_DT_S).toFixed(1);

  const send = (idx: number) => {
    if (idx < 0 || idx >= localPlayer.levelUpChoices.length) return;
    room.send("level_up_choice", { type: "level_up_choice", choiceIndex: idx });
  };

  const cards: CardLabel[] = [];
  for (let i = 0; i < localPlayer.levelUpChoices.length; i++) {
    cards.push(describeChoice(localPlayer, localPlayer.levelUpChoices[i]!));
  }

  return (
    <div style={OVERLAY_STYLE}>
      <div style={COUNTDOWN_STYLE}>level up — auto-pick in {remainingS}s</div>
      <div style={ROW_STYLE}>
        {cards.map((c, i) => {
          // M9 US-007: compose item-specific style override on top of the
          // base CARD_STYLE. Items get gold border + warm tint + emoji
          // prefix on the name; weapons stay on the cool blue baseline.
          const style: React.CSSProperties = c.isItem
            ? { ...CARD_STYLE, ...ITEM_CARD_STYLE_OVERRIDE }
            : CARD_STYLE;
          const tag = c.isItem ? "ITEM" : "WEAPON";
          const tagColor = c.isItem ? "rgba(230,190,90,0.95)" : "rgba(120,200,255,0.7)";
          return (
            <div key={i} style={style} onClick={() => send(i)}>
              <div style={{ ...CARD_TAG_STYLE, color: tagColor }}>{tag}</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {i + 1}. {c.icon ? `${c.icon} ` : ""}{c.line1}
              </div>
              <div style={{ opacity: 0.85 }}>{c.line2}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
