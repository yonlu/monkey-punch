import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Card } from "@/components/ui/8bit/card";
import { Input } from "@/components/ui/8bit/input";
import { Button } from "@/components/ui/8bit/button";
import { createRoom, joinRoom } from "../net/client.js";
import { RoomList } from "./RoomList.js";

type Props = {
  onJoined: (room: Room<RoomState>, name: string) => void;
  initialName?: string;
  initialCode?: string;
  banner?: string;
};

export function Landing({
  onJoined,
  initialName = "",
  initialCode = "",
  banner,
}: Props) {
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
    <div
      className="min-h-screen flex flex-col items-center justify-start gap-4 p-6"
      style={{ fontFamily: "'Press Start 2P', system-ui, sans-serif" }}
    >
      <h1 className="text-2xl mt-6">monkey-punch</h1>

      {banner ? (
        <Card className="px-3 py-2 text-sm opacity-90">{banner}</Card>
      ) : null}

      <Card className="w-full max-w-xl p-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Display name
          <Input
            placeholder="display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
          />
        </label>
        <Button
          disabled={!canCreate}
          onClick={() => handle(() => createRoom(trimmedName))}
        >
          Create room
        </Button>
      </Card>

      <RoomList
        canJoin={!busy && trimmedName.length > 0}
        busy={busy}
        onJoin={(c) => handle(() => joinRoom(c, trimmedName))}
      />

      <Card className="w-full max-w-xl p-4 flex flex-col gap-2">
        <div className="text-sm opacity-80">Or join by code</div>
        <div className="flex gap-2">
          <Input
            placeholder="CODE"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={4}
            className="w-28 text-center"
          />
          <Button
            disabled={!canJoin}
            onClick={() => handle(() => joinRoom(cleanCode, trimmedName))}
          >
            Join
          </Button>
        </div>
      </Card>

      <div className="text-xs opacity-70 min-h-4">{error}</div>

      <div
        className="text-[10px] opacity-60 mt-auto"
        style={{ fontFamily: "system-ui, sans-serif" }}
      >
        Character &amp; animations by{" "}
        <a
          href="https://quaternius.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Quaternius
        </a>{" "}
        (CC-BY 3.0)
      </div>
    </div>
  );
}
