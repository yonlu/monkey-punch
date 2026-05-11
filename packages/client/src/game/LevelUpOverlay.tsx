// packages/client/src/game/LevelUpOverlay.tsx
import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import type { Player, RoomState, LevelUpChoice } from "@mp/shared";
import { SIM_DT_S, WEAPON_KINDS, ITEM_KINDS, LEVEL_UP_CHOICE_ITEM, describeItemEffect } from "@mp/shared";

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

type CardLabel = { line1: string; line2: string };

// M9 US-002 + US-006 iteration: choices are structured {type, index}.
// Weapon vs item dispatch happens here. Items show a human-readable
// effect description (e.g., "+10% weapon damage"); weapons just show
// "NEW" or "L1 → L2" since per-level weapon details vary by behavior
// kind. Full visual distinction (gold border, item icons) lands in US-007.
function describeChoice(localPlayer: Player, choice: LevelUpChoice): CardLabel {
  if (choice.type === LEVEL_UP_CHOICE_ITEM) {
    const def = ITEM_KINDS[choice.index];
    if (!def) return { line1: "?", line2: "?" };
    const existing = localPlayer.items.find((it) => it.kind === choice.index);
    if (!existing) {
      // First pickup — show what L1 grants.
      return { line1: def.name, line2: `NEW → ${describeItemEffect(def, 1)}` };
    }
    const cap = def.values.length;
    if (existing.level >= cap) {
      return { line1: def.name, line2: `L${cap} MAX (${describeItemEffect(def, cap)})` };
    }
    // Upgrade — show current → next.
    return {
      line1: def.name,
      line2: `${describeItemEffect(def, existing.level)} → ${describeItemEffect(def, existing.level + 1)}`,
    };
  }
  const def = WEAPON_KINDS[choice.index];
  if (!def) return { line1: "?", line2: "?" };
  const existing = localPlayer.weapons.find((w) => w.kind === choice.index);
  if (!existing) {
    return { line1: def.name, line2: "NEW" };
  }
  const cap = def.levels.length;
  if (existing.level >= cap) {
    return { line1: def.name, line2: `L${cap} (MAX)` };
  }
  return { line1: def.name, line2: `L${existing.level} → L${existing.level + 1}` };
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
        {cards.map((c, i) => (
          <div key={i} style={CARD_STYLE} onClick={() => send(i)}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{i + 1}. {c.line1}</div>
            <div style={{ opacity: 0.85 }}>{c.line2}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
