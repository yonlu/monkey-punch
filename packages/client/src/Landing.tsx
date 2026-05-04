import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { createRoom, joinRoom } from "./net/client.js";

type Props = {
  onJoined: (room: Room<RoomState>, name: string) => void;
  initialName?: string;
  initialCode?: string;
  banner?: string;
};

export function Landing({ onJoined, initialName = "", initialCode = "", banner }: Props) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const trimmedName = name.trim();
  const cleanCode = code.trim().toUpperCase();
  const canCreate = !busy && trimmedName.length > 0;
  const canJoin = canCreate && cleanCode.length === 4;

  const handle = async (action: () => Promise<Room<RoomState>>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const room = await action();
      onJoined(room, trimmedName);
    } catch (err) {
      setError((err as Error).message ?? "failed to join");
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <h1>monkey-punch</h1>
      {banner ? <div className="banner-msg">{banner}</div> : null}
      <input
        placeholder="display name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={24}
      />
      <button
        disabled={!canCreate}
        onClick={() => handle(() => createRoom(trimmedName))}
      >
        create room
      </button>
      <div className="row">
        <input
          placeholder="CODE"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={4}
          style={{ width: "6rem", textAlign: "center" }}
        />
        <button
          disabled={!canJoin}
          onClick={() => handle(() => joinRoom(cleanCode, trimmedName))}
        >
          join
        </button>
      </div>
      <div className="error">{error}</div>
    </div>
  );
}
