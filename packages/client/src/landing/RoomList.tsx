import { Card } from "@/components/ui/8bit/card";
import { Button } from "@/components/ui/8bit/button";
import { useAvailableRooms } from "./useAvailableRooms.js";
import { RoomRow } from "./RoomRow.js";

type Props = {
  canJoin: boolean;
  busy: boolean;
  onJoin: (code: string) => void;
};

export function RoomList({ canJoin, busy, onJoin }: Props) {
  const { rooms, loading, error, refresh } = useAvailableRooms();

  return (
    <div className="w-full max-w-xl">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg">Open rooms</h2>
        <div className="flex items-center gap-2">
          {error ? (
            <span className="text-xs opacity-70">couldn't refresh</span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <Card className="p-3">Loading rooms…</Card>
      ) : rooms.length === 0 ? (
        <Card className="p-3 opacity-80">
          No rooms yet — click Create to start one.
        </Card>
      ) : (
        rooms.map((room) => (
          <RoomRow
            key={room.roomId}
            room={room}
            canJoin={canJoin}
            busy={busy}
            onJoin={onJoin}
          />
        ))
      )}
    </div>
  );
}
