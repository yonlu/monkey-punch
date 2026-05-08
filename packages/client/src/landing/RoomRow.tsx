import { Card } from "@/components/ui/8bit/card";
import { Badge } from "@/components/ui/8bit/badge";
import { Button } from "@/components/ui/8bit/button";
import type { AvailableRoom } from "../net/matchmake.js";

type Props = {
  room: AvailableRoom;
  canJoin: boolean; // false when the user has not entered a name
  busy: boolean; // disables the row while a join is in flight
  onJoin: (code: string) => void;
};

export function RoomRow({ room, canJoin, busy, onJoin }: Props) {
  const isFull = room.clients >= room.maxClients;
  const disabled = isFull || !canJoin || busy;

  return (
    <Card className="flex items-center justify-between p-3 mb-2">
      <div className="flex items-center gap-3">
        <span className="font-bold tracking-widest">
          {room.metadata.code}
        </span>
        <span className="text-sm opacity-80">
          {room.metadata.hostName ?? "—"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm tabular-nums">
          {room.clients} / {room.maxClients}
        </span>
        <Badge variant={isFull ? "destructive" : "default"}>
          {isFull ? "Full" : "Joinable"}
        </Badge>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onJoin(room.metadata.code)}
          aria-disabled={disabled}
          title={
            isFull
              ? "Room is full"
              : !canJoin
                ? "Enter a display name first"
                : undefined
          }
        >
          Join
        </Button>
      </div>
    </Card>
  );
}
