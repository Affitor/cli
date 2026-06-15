import { describe, expect, it } from "vitest";
import { blockingGate, tick } from "../src/commands/onboard";
import type { ReadinessResult } from "../src/types";

/**
 * These encode the CANONICAL CMS readiness/verdict contracts:
 *   - `ReadinessResult.gates` is a KEYED OBJECT (not an array); `blocker` names
 *     the FIRST failing gate id; the blocking gate's next_action is read via
 *     `gates[blocker].next_action`. `blockingGate()` MUST resolve via the keyed
 *     object + `blocker` and NEVER call `.find` (which would throw on an object).
 *   - chain verdict values are `TestChainStatus` STRINGS; a step is "passing"
 *     ONLY when it equals 'attributed'. `tick()` MUST render green ✓ only then.
 */

describe("blockingGate — keyed-object gates + top-level blocker (H1)", () => {
  it("resolves the blocker via gates[blocker], NOT via .find (which would throw)", () => {
    const r: ReadinessResult = {
      integration_verified: false,
      gates: {
        profile: { status: "pass" },
        economics: { status: "pass" },
        payout: { status: "pass", mode: "s2s" },
        tracking: { status: "pass" },
        live: {
          status: "fail",
          next_action: "Send a sale through your checkout",
          test_chain: { click: "attributed", lead: "attributed", sale: "pending" },
        },
      },
      blocker: "live",
    };
    const g = blockingGate(r);
    expect(g).toBeDefined();
    expect(g!.id).toBe("live");
    expect(g!.next_action).toBe("Send a sale through your checkout");
  });

  it("does NOT throw when gates is a present object (the H1 crash regression)", () => {
    const r: ReadinessResult = {
      integration_verified: false,
      gates: { payout: { status: "fail", next_action: "Connect Stripe" } },
      blocker: "payout",
    };
    // The old `r.gates?.find(...)` threw `r.gates.find is not a function` here.
    expect(() => blockingGate(r)).not.toThrow();
    expect(blockingGate(r)!.id).toBe("payout");
  });

  it("falls back to the first non-pass gate when blocker is absent", () => {
    const r: ReadinessResult = {
      integration_verified: false,
      gates: {
        profile: { status: "pass" },
        economics: { status: "fail", next_action: "Set a commission rate" },
      },
    };
    const g = blockingGate(r);
    expect(g!.id).toBe("economics");
    expect(g!.next_action).toBe("Set a commission rate");
  });

  it("returns undefined when there is no failing gate and no blocker", () => {
    const r: ReadinessResult = {
      integration_verified: true,
      gates: { profile: { status: "pass" }, payout: { status: "pass" } },
      blocker: null,
    };
    expect(blockingGate(r)).toBeUndefined();
  });

  it("returns undefined when the payload carries no gates at all", () => {
    expect(blockingGate({ integration_verified: false })).toBeUndefined();
  });
});

describe("tick — string TestChainStatus rendering (H2)", () => {
  it("renders green ✓ ONLY for 'attributed'", () => {
    expect(tick("attributed")).toContain("✓");
  });

  it("renders ✗ + the status for unattributed / wrong_partner (NOT a success)", () => {
    expect(tick("unattributed")).toContain("✗");
    expect(tick("unattributed")).toContain("unattributed");
    expect(tick("wrong_partner")).toContain("✗");
    expect(tick("wrong_partner")).toContain("wrong_partner");
    // These must never read as a passing ✓.
    expect(tick("unattributed")).not.toContain("✓");
    expect(tick("wrong_partner")).not.toContain("✓");
  });

  it("renders a pending glyph (⧗) for 'pending' and undefined — never green ✓", () => {
    expect(tick("pending")).toContain("⧗");
    expect(tick("pending")).not.toContain("✓");
    expect(tick(undefined)).toContain("⧗");
    expect(tick(undefined)).not.toContain("✓");
  });
});
