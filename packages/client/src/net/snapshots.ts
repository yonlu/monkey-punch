export type Snapshot = { t: number; x: number; y: number; z: number };

const HISTORY = 5; // keep a small ring buffer per player

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];

  push(snap: Snapshot): void {
    this.snaps.push(snap);
    if (this.snaps.length > HISTORY) this.snaps.shift();
  }

  /**
   * Return interpolated {x,y,z} for the given render time (in the same time base as snapshots).
   * No extrapolation: clamps to most recent snapshot if renderTime is past it.
   */
  sample(renderTime: number): { x: number; y: number; z: number } | null {
    if (this.snaps.length === 0) return null;
    if (this.snaps.length === 1) {
      const only = this.snaps[0]!;
      return { x: only.x, y: only.y, z: only.z };
    }

    const last = this.snaps[this.snaps.length - 1]!;
    if (renderTime >= last.t) return { x: last.x, y: last.y, z: last.z };

    const first = this.snaps[0]!;
    if (renderTime <= first.t) return { x: first.x, y: first.y, z: first.z };

    for (let i = this.snaps.length - 1; i > 0; i--) {
      const a = this.snaps[i - 1]!;
      const b = this.snaps[i]!;
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t;
        const u = span > 0 ? (renderTime - a.t) / span : 0;
        return {
          x: a.x + (b.x - a.x) * u,
          y: a.y + (b.y - a.y) * u,
          z: a.z + (b.z - a.z) * u,
        };
      }
    }
    return { x: last.x, y: last.y, z: last.z };
  }
}
