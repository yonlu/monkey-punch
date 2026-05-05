const ALPHA = 0.2;

/**
 * Smoothed estimate of the offset between this client's wall clock and the
 * server's. Updated by every pong. The basis for AD1 cross-client
 * projectile determinism: every projectile's render position is computed
 * from `serverNow() - interpDelayMs - serverFireTimeMs`, so two clients
 * with stable, similar offsets compute the same world position for the
 * same fireId at the same wall-clock moment.
 *
 * `offsetMs` is initialized exactly from the first sample (no smoothing),
 * then exponentially smoothed at ALPHA=0.2 per subsequent observation.
 * 1Hz pong driver → ~5s effective time constant, fast enough to track
 * clock drift, slow enough to ignore single-sample jitter.
 */
export class ServerTime {
  offsetMs = 0;
  private initialized = false;

  observe(serverNow: number, halfRttMs: number): void {
    const sample = serverNow + halfRttMs - Date.now();
    if (!this.initialized) {
      this.offsetMs = sample;
      this.initialized = true;
      return;
    }
    this.offsetMs = this.offsetMs * (1 - ALPHA) + sample * ALPHA;
  }

  serverNow(): number {
    return Date.now() + this.offsetMs;
  }
}
