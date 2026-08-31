import { describe, expect, it, beforeEach } from "vitest";
import { PolicyEngine } from "./policy-engine.js";
import { InMemoryMemoryBank } from "./memory-bank.js";
import { buildDefaultPolicies } from "./constants.js";
import type { MemoryBank } from "./types.js";

async function seededBank(): Promise<MemoryBank> {
  const bank = new InMemoryMemoryBank();
  for (const rule of buildDefaultPolicies()) {
    await bank.put("policies", structuredClone(rule));
  }
  return bank;
}

describe("PolicyEngine (deterministic)", () => {
  let engine: PolicyEngine;

  beforeEach(async () => {
    engine = new PolicyEngine(await seededBank());
  });

  it("allows the simulated $250 low-risk payment autonomously", async () => {
    const decision = await engine.evaluate({
      actionType: "financial-action",
      amountUsd: 250,
      fraudRiskScore: 0.24,
      complianceResult: "CLEAR",
      asset: "USDC",
      network: "base-sepolia",
      rateWindow: null,
      budgetExceeded: false,
    });
    expect(decision.decision).toBe("ALLOW");
    expect(decision.matchedRules.map((m) => m.ruleId)).toContain("pol-auto-approve-max");
  });

  it("requires human approval for the $48,500 high-risk payment (amount + fraud band)", async () => {
    const decision = await engine.evaluate({
      actionType: "financial-action",
      amountUsd: 48_500,
      fraudRiskScore: 0.9,
      complianceResult: "CLEAR",
      asset: "USDC",
      network: "polygon-amoy",
      rateWindow: null,
      budgetExceeded: false,
    });
    expect(decision.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    const rules = decision.matchedRules.map((m) => m.ruleId);
    expect(rules).toContain("pol-human-above-10k");
    expect(rules).toContain("pol-fraud-high-review");
  });

  it("auto-declines near-certain fraud (≥0.97) even at low amounts", async () => {
    const decision = await engine.evaluate({
      actionType: "financial-action",
      amountUsd: 300,
      fraudRiskScore: 0.98,
      complianceResult: "CLEAR",
      rateWindow: null,
      budgetExceeded: false,
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.matchedRules.map((m) => m.ruleId)).toContain("pol-fraud-critical-decline");
  });

  it("blocks sanctioned counterparties outright", async () => {
    const decision = await engine.evaluate({
      actionType: "financial-action",
      amountUsd: 900,
      fraudRiskScore: 0.1,
      complianceResult: "BLOCKED",
      sanctionedHit: true,
      rateWindow: null,
      budgetExceeded: false,
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.matchedRules.map((m) => m.ruleId)).toContain("pol-sanctions-block");
  });

  it("denies non-sandbox networks (sandbox guard)", async () => {
    const decision = await engine.evaluate({
      actionType: "financial-action",
      amountUsd: 100,
      fraudRiskScore: 0.1,
      complianceResult: "CLEAR",
      asset: "USDC",
      network: "ethereum-mainnet",
      rateWindow: null,
      budgetExceeded: false,
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.matchedRules[0].ruleId).toBe("pol-sandbox-only");
  });

  it("denies when a tool rate window is exceeded", async () => {
    const decision = await engine.evaluate({
      actionType: "tool-invocation",
      rateWindow: { key: "fraud-agent:get_wallet_history", count: 61, limitPerMinute: 60 },
      budgetExceeded: false,
    });
    expect(decision.decision).toBe("DENY");
  });

  it("is deterministic: same inputs → identical decision", async () => {
    const input = {
      actionType: "financial-action" as const,
      amountUsd: 12_345,
      fraudRiskScore: 0.5,
      complianceResult: "CLEAR",
      rateWindow: null,
      budgetExceeded: false,
    };
    const a = await engine.evaluate(input);
    const b = await engine.evaluate(input);
    expect(a.decision).toBe(b.decision);
    expect(a.matchedRules).toEqual(b.matchedRules);
  });

  it("honors disabled rules", async () => {
    await engine.setRuleEnabled("pol-human-above-10k", false);
    const decision = await engine.evaluate({
      actionType: "financial-action",
      amountUsd: 20_000,
      fraudRiskScore: 0.1,
      complianceResult: "CLEAR",
      rateWindow: null,
      budgetExceeded: false,
    });
    // Amount alone no longer triggers review; risk is low → allowed path.
    expect(decision.decision).not.toBe("REQUIRE_HUMAN_APPROVAL");
  });
});
