import { describe, it, expect } from "vitest";
import { ServerTime } from "./serverTime.js";

describe("ServerTime", () => {
  it("first observe sets offsetMs exactly (no smoothing on the first sample)", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    // Pretend the server is 12_000 ms ahead of us with 0 RTT.
    st.observe(realNow + 12_000, 0);
    expect(st.offsetMs).toBeCloseTo(12_000, -2); // tolerance: tens of ms
  });

  it("subsequent observes mix at α=0.2 (exponential smoothing)", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    st.observe(realNow + 100, 0);                 // offsetMs ≈ 100
    const before = st.offsetMs;
    // Now an outlier: server claims it's +1100ms ahead at half-RTT 0.
    st.observe(Date.now() + 1100, 0);
    // Smoothed: 100 * 0.8 + 1100 * 0.2 = 80 + 220 = 300.
    expect(st.offsetMs).toBeCloseTo(300, -2);
    expect(st.offsetMs).toBeLessThan(before + 1000); // didn't snap to outlier
  });

  it("serverNow returns Date.now() + offsetMs", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    st.observe(realNow + 5_000, 0);
    expect(st.serverNow() - Date.now()).toBeCloseTo(5_000, -2);
  });

  it("includes halfRttMs in the sample (server time at receipt = serverNow + halfRtt)", () => {
    const st = new ServerTime();
    const realNow = Date.now();
    // Server's serverNow was 1000ms ago, but the message took 200ms one-way.
    // halfRtt=200 → effective server time at receipt = (now - 1000) + 200 = now - 800.
    // sample = (now - 800) - now = -800.
    st.observe(realNow - 1000, 200);
    expect(st.offsetMs).toBeCloseTo(-800, -2);
  });
});
