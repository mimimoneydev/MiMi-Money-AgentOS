import type {
  MemoryBank,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyRule,
} from "./types.js";

/**
 * Deterministic MiMi Policy Engine.
 *
 * LLM output NEVER executes privileged financial actions directly. Every
 * sensitive action is evaluated here against an ordered, seeded rule set
 * (thresholds, fraud bands, sanctions, RBAC, rate limits, budgets, sandbox
 * guard). Same inputs → same decision, every time, fully auditable.
 *
 * Rule precedence: lower `priority` number wins; DENY beats
 * REQUIRE_HUMAN_APPROVAL beats ALLOW at equal priority.
 */
export class PolicyEngine {
  constructor(private readonly memoryBank: MemoryBank) {}

  async evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision> {
    const rules = (await this.memoryBank.list<PolicyRule & { id: string }>("policies", {
      orderBy: "priority",
      direction: "asc",
    })).filter((r) => r.enabled !== false);

    const matched: PolicyDecision["matchedRules"] = [];
    let decision: "ALLOW" | "DENY" | "REQUIRE_HUMAN_APPROVAL" = "ALLOW";
    const reasons: string[] = [];
    let bestRank = Number.POSITIVE_INFINITY;

    const rankOf = (effect: string, fallbackPriority: number): number => {
      // DENY is structurally strongest at equal priority.
      const effectBias = effect === "DENY" ? 0 : effect === "REQUIRE_HUMAN_APPROVAL" ? 0.5 : 1;
      return fallbackPriority + effectBias;
    };

    const apply = (
      rule: Pick<PolicyRule, "id" | "name" | "effect"> & { priority?: number },
      reason: string,
    ) => {
      matched.push({ ruleId: rule.id, name: rule.name, reason });
      reasons.push(`${rule.name}: ${reason}`);
      const rank = rankOf(rule.effect, rule.priority ?? 50);
      if (rank < bestRank) {
        bestRank = rank;
        decision = rule.effect;
      }
    };

    for (const rule of rules) {
      switch (rule.category) {
        case "sandbox-guard": {
          if (!input.actionType && !input.toolName) break;
          const assetOk =
            !input.asset || ((rule.params.allowedAssets as string[]) ?? []).includes(input.asset);
          const networkOk =
            !input.network ||
            ((rule.params.allowedNetworks as string[]) ?? []).includes(input.network);
          if (!assetOk) {
            apply(rule, `asset ${input.asset} is not on the sandbox allowlist`);
          } else if (!networkOk) {
            apply(rule, `network ${input.network} is not on the sandbox allowlist`);
          }
          break;
        }
        case "transaction-threshold": {
          if (typeof input.amountUsd !== "number") break;
          if (rule.effect === "REQUIRE_HUMAN_APPROVAL") {
            const min = Number(rule.params.minAmountUsd ?? Infinity);
            if (input.amountUsd >= min) {
              apply(
                rule,
                `$${fmt(input.amountUsd)} ≥ human-approval threshold $${fmt(min)}`,
              );
            }
          } else if (rule.effect === "ALLOW") {
            const maxAmount = Number(rule.params.maxAmountUsd ?? 0);
            const maxRisk = Number(rule.params.maxCompositeRisk ?? 1);
            if (
              input.amountUsd < maxAmount &&
              (input.fraudRiskScore ?? 0) < maxRisk &&
              input.complianceResult !== "FLAGGED"
            ) {
              apply(
                rule,
                `$${fmt(input.amountUsd)} < $${fmt(maxAmount)} and composite risk ${(input.fraudRiskScore ?? 0).toFixed(2)} < ${maxRisk}`,
              );
            }
          }
          break;
        }
        case "fraud-risk": {
          if (typeof input.fraudRiskScore !== "number") break;
          if (rule.effect === "DENY") {
            const min = Number(rule.params.minFraudRisk ?? 2);
            if (input.fraudRiskScore >= min) {
              apply(rule, `fraud risk ${input.fraudRiskScore.toFixed(2)} ≥ ${min}`);
            }
          } else if (rule.effect === "REQUIRE_HUMAN_APPROVAL") {
            const min = Number(rule.params.minFraudRisk ?? 2);
            if (input.fraudRiskScore >= min) {
              apply(rule, `fraud risk ${input.fraudRiskScore.toFixed(2)} ≥ ${min} → mandatory human review`);
            }
          }
          break;
        }
        case "compliance": {
          if (input.sanctionedHit === true) {
            apply(rule, "sanctions / hard AML hit");
          }
          break;
        }
        case "rate-limit": {
          if (input.rateWindow && input.rateWindow.count > input.rateWindow.limitPerMinute) {
            apply(
              rule,
              `${input.rateWindow.key}: ${input.rateWindow.count}/min exceeds limit ${input.rateWindow.limitPerMinute}/min`,
            );
          }
          break;
        }
        case "budget": {
          if (input.budgetExceeded) {
            apply(rule, `agent budget hard-stop reached`);
          }
          break;
        }
        default:
          break;
      }
    }

    return {
      decision,
      matchedRules: matched,
      reasons: reasons.length > 0 ? reasons : ["no policy constraints triggered"],
      evaluatedAt: new Date().toISOString(),
      engine: "deterministic-v1",
    };
  }

  async listRules(): Promise<Array<PolicyRule & { id: string }>> {
    return this.memoryBank.list("policies", { orderBy: "priority", direction: "asc" });
  }

  async setRuleEnabled(ruleId: string, enabled: boolean): Promise<PolicyRule | null> {
    return this.memoryBank.update<PolicyRule>("policies", ruleId, {
      enabled,
      updatedAt: new Date().toISOString(),
    });
  }

  async updateRuleParams(ruleId: string, params: Record<string, unknown>): Promise<PolicyRule | null> {
    const current = await this.memoryBank.get<PolicyRule>("policies", ruleId);
    if (!current) return null;
    return this.memoryBank.update<PolicyRule>("policies", ruleId, {
      params: { ...current.params, ...params },
      updatedAt: new Date().toISOString(),
    });
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
