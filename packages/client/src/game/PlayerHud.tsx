import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import type { Player, RoomState, WeaponState } from "@mp/shared";
import { WEAPON_KINDS } from "@mp/shared";

const HUD_STYLE: React.CSSProperties = {
  position: "fixed",
  bottom: 8,
  left: 8,
  padding: "6px 10px",
  background: "rgba(0,0,0,0.6)",
  color: "#fff",
  font: "12px/1.4 ui-monospace, Menlo, monospace",
  pointerEvents: "none",
  whiteSpace: "pre",
  zIndex: 1000,
};

const BAR_LEN = 5;

function cooldownBar(weapon: WeaponState | undefined): string {
  if (!weapon) return "·".repeat(BAR_LEN);
  const kind = WEAPON_KINDS[weapon.kind];
  if (!kind) return "·".repeat(BAR_LEN);
  const frac = 1 - Math.max(0, Math.min(1, weapon.cooldownRemaining / kind.cooldown));
  const filled = Math.round(frac * BAR_LEN);
  return "▓".repeat(filled) + "░".repeat(BAR_LEN - filled);
}

export type PlayerHudProps = {
  room: Room<RoomState>;
};

/**
 * Always-on bottom-left HUD: one row per player with name, xp, level,
 * cooldown bar, and weapon name. rAF-throttled re-render via a force
 * counter — same pattern as DebugHud. Reads room.state.players directly
 * each frame (the players are mutated on every server tick), so we don't
 * need to subscribe to add/remove/onChange — the rAF loop is the
 * subscription.
 */
export function PlayerHud({ room }: PlayerHudProps) {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);

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

  const rows: string[] = [];
  room.state.players.forEach((p: Player) => {
    const w = p.weapons[0];
    const kindName = w !== undefined && WEAPON_KINDS[w.kind] != null
      ? WEAPON_KINDS[w.kind]!.name
      : "—";
    const namePad = (p.name || "Anon").padEnd(8).slice(0, 8);
    const xpStr = String(p.xp).padStart(4);
    const levelStr = String(p.level).padStart(2);
    rows.push(`${namePad} XP ${xpStr}  Lv ${levelStr}  ${cooldownBar(w)}  ${kindName}`);
  });

  if (rows.length === 0) return null;
  return <div style={HUD_STYLE}>{rows.join("\n")}</div>;
}
