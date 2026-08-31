import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryMemoryBank } from "./memory-bank.js";
import { MimiEventBus } from "./event-bus.js";
import { PolicyEngine } from "./policy-engine.js";
import { MiMiAgentGateway } from "./gateway.js";
import { createMimiTools } from "./tools.js";
import { seedMemoryBank } from "./seed.js";
import type { MemoryBank } from "./types.js";

describe("MiMi Agent Gateway", () => {
  let bank: MemoryBank;
  let gateway: MiMiAgentGateway;

  beforeEach(async () => {
    bank = new InMemoryMemoryBank();
    const bus = new MimiEventBus({ mode: "in-memory", sink: async (e) => void await bank.put("agent_events", { ...e, id: e.eventId }) });
    const policy = new PolicyEngine(bank);
    gateway = new MiMiAgentGateway({ memoryBank: bank, bus, policyEngine: policy, tools: createMimiTools(bank), rateLimitPerMinute: 3 });
    await seedMemoryBank(bank, { runtimeMode: "local-simulation" });
  });

  it("executes a read tool for an authorized agent and writes audit + events", async () => {
    const result = await gateway.invoke({
      agentId: "fraud-agent",
      toolName: "get_transaction",
      args: { transactionId: "txn_hist_001" },
      skipFinancialGate: true,
    });
    expect(result.status).toBe("executed");
    const tx = result.result as { id: string };
    expect(tx.id).toBe("txn_hist_001");
    const audit = await bank.list<{ outcome: string; actor: string }>("audit");
    expect(audit.some((a) => a.actor === "fraud-agent" && a.outcome === "EXECUTED")).toBe(true);
  });

  it("denies tools outside the agent's RBAC grants (never executes)", async () => {
    // support-agent has no reconcile_transaction permission.
    const result = await gateway.invoke({
      agentId: "support-agent",
      toolName: "reconcile_transaction",
      args: { transactionId: "txn_hist_001" },
      skipFinancialGate: true,
    });
    expect(result.status).toBe("denied");
    expect(result.error).toContain("RBAC");
    expect(result.decision?.decision ?? "DENY").toBeTruthy();
  });

  it("denies unknown identities outright (no anonymous capability)", async () => {
    const result = await gateway.invoke({
      agentId: "ghost-agent" as never,
      toolName: "get_transaction",
      args: { transactionId: "txn_hist_001" },
      skipFinancialGate: true,
    });
    expect(result.status).toBe("denied");
    expect(result.error).toContain("unknown agent identity");
  });

  it("enforces per-agent-per-tool rate limits", async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await gateway.invoke({
        agentId: "fraud-agent",
        toolName: "get_customer",
        args: { customerId: "cus_amara" },
        skipFinancialGate: true,
      });
      expect(r.status).toBe("executed");
    }
    const fourth = await gateway.invoke({
      agentId: "fraud-agent",
      toolName: "get_customer",
      args: { customerId: "cus_amara" },
      skipFinancialGate: true,
    });
    expect(fourth.status).toBe("denied");
  });

  it("blocks agents whose budget hard-stop is reached", async () => {
    const agent = await bank.get<{ id: string; budget: { spentUsd: number; monthlyLimitUsd: number }; status: string }>("agents", "fraud-agent")!;
    agent!.budget.spentUsd = agent!.budget.monthlyLimitUsd + 1;
    await bank.put("agents", agent!);
    const result = await gateway.invoke({
      agentId: "fraud-agent",
      toolName: "get_transaction",
      args: { transactionId: "txn_hist_001" },
      skipFinancialGate: true,
    });
    expect(result.status).toBe("denied");
    expect(result.error).toContain("budget hard-stop");
    const updated = await bank.get<{ status: string }>("agents", "fraud-agent");
    expect(updated!.status).toBe("PAUSED");
  });

  it("wallet scoring lands the demo fixtures in the right policy bands", async () => {
    const { scoreWalletBehaviour } = await import("./tools.js");
    const low = await bank.get<any>("wallets", "cus_amara");
    const high = await bank.get<any>("wallets", "cus_chidi");
    const lowScore = scoreWalletBehaviour(low, 250);
    const highScore = scoreWalletBehaviour(high, 48_500);
    expect(lowScore.score).toBeLessThan(0.4);
    expect(highScore.score).toBeGreaterThanOrEqual(0.85);
    expect(highScore.score).toBeLessThan(0.97); // review, not auto-decline
  });
});
