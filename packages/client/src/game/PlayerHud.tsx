import { useEffect, useRef, useState } from "react";
import type { Room } from "@colyseus/sdk";
import type { Player, PlayerDamagedEvent, RoomState, WeaponState } from "@mp/shared";
import { WEAPON_KINDS, statsAt, isProjectileWeapon } from "@mp/shared";

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

const HP_BAR_STYLE: React.CSSProperties = {
  position: "fixed",
  bottom: 18,
  left: "50%",
  transform: "translateX(-50%)",
  width: 320,
  height: 18,
  background: "rgba(0,0,0,0.55)",
  border: "1px solid #4a5d70",
  borderRadius: 9,
  overflow: "hidden",
  pointerEvents: "none",
  zIndex: 1000,
};

const FLASH_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(255,0,0,0.3)",
  opacity: 0,
  transition: "opacity 200ms ease-out",
  pointerEvents: "none",
  zIndex: 1500,
};

const BAR_LEN = 5;

function cooldownBar(weapon: WeaponState | undefined): string {
  if (!weapon) return "·".repeat(BAR_LEN);
  const def = WEAPON_KINDS[weapon.kind];
  if (!def || !isProjectileWeapon(def)) return "·".repeat(BAR_LEN);
  const stats = statsAt(def, weapon.level);
  const frac = 1 - Math.max(0, Math.min(1, weapon.cooldownRemaining / stats.cooldown));
  const filled = Math.round(frac * BAR_LEN);
  return "▓".repeat(filled) + "░".repeat(BAR_LEN - filled);
}

export type PlayerHudProps = {
  room: Room<RoomState>;
};

export function PlayerHud({ room }: PlayerHudProps) {
  const [, force] = useState(0);
  const raf = useRef<number | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  // rAF re-render driver — keeps player rows + HP bar in sync each frame.
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

  // Damage flash on every player_damaged event for the local player.
  useEffect(() => {
    const off = room.onMessage("player_damaged", (msg: PlayerDamagedEvent) => {
      if (msg.playerId !== room.sessionId) return;
      const el = flashRef.current;
      if (!el) return;
      // Snap to full opacity, then on the next frame request a transition to 0.
      el.style.transition = "none";
      el.style.opacity = "1";
      requestAnimationFrame(() => {
        if (!flashRef.current) return;
        flashRef.current.style.transition = "opacity 200ms ease-out";
        flashRef.current.style.opacity = "0";
      });
    });
    return () => off();
  }, [room]);

  const rows: string[] = [];
  room.state.players.forEach((p: Player) => {
    const namePad = (p.name || "Anon").padEnd(8).slice(0, 8);
    const xpStr = String(p.xp).padStart(4);
    const levelStr = String(p.level).padStart(2);

    const projWeapon = p.weapons.find((w) => {
      const def = WEAPON_KINDS[w.kind];
      return def?.behavior.kind === "projectile";
    });
    const cd = cooldownBar(projWeapon);

    const weaponList: string[] = [];
    p.weapons.forEach((w) => {
      const def = WEAPON_KINDS[w.kind];
      if (!def) return;
      weaponList.push(`${def.name} L${w.level}`);
    });
    const weaponsStr = weaponList.length > 0 ? weaponList.join(", ") : "—";

    rows.push(`${namePad} XP ${xpStr}  Lv ${levelStr}  ${cd}  ${weaponsStr}`);
  });

  const localPlayer = room.state.players.get(room.sessionId);
  const hp = localPlayer?.hp ?? 0;
  const maxHp = localPlayer?.maxHp ?? 100;
  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  return (
    <>
      {rows.length > 0 && <div style={HUD_STYLE}>{rows.join("\n")}</div>}
      {localPlayer && (
        <div style={HP_BAR_STYLE}>
          <div style={{
            height: "100%",
            width: `${hpFrac * 100}%`,
            background: "linear-gradient(90deg, #ff5252 0%, #ff8a52 100%)",
            transition: "width 120ms linear",
          }} />
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            color: "#fff",
            textShadow: "0 1px 2px rgba(0,0,0,0.7)",
          }}>{hp} / {maxHp}</div>
        </div>
      )}
      <div ref={flashRef} style={FLASH_STYLE} />
    </>
  );
}
