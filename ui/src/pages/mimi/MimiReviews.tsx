import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mimiApi } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, StatusBadge, formatUsd, formatWhen } from "./shared";

/** Human Review queue — the human-in-the-loop control surface. */
export function MimiHumanReviews() {
  useMimiLive();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const { data } = useQuery({ queryKey: ["mimi", "reviews"], queryFn: () => mimiApi.reviews(), refetchInterval: 3_000 });

  const decide = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) =>
      approve ? mimiApi.approveReview(id, note || undefined) : mimiApi.rejectReview(id, note || undefined),
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["mimi"] });
    },
  });

  const pending = (data?.reviews ?? []).filter((r) => r.status === "PENDING");
  const decided = (data?.reviews ?? []).filter((r) => r.status !== "PENDING");

  return (
    <div>
      <PageHeader
        title="Human Reviews"
        subtitle="Policy-mandated operator decisions. Approving resumes the real workflow through the Pub/Sub backbone."
      />

      <Panel title={`Awaiting decision (${pending.length})`} className="mb-4">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending reviews — the workforce is running autonomously within policy.</p>
        ) : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.id} className="rounded-lg border border-mimi-warning/50 bg-mimi-warning/5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">{formatUsd(r.amountUsd)} {r.asset}</span>
                  <StatusBadge status={r.status} />
                  <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
                  <span className="text-xs text-muted-foreground">· customer {r.customerId} · fraud risk <b className="text-mimi-danger">{r.fraudRiskScore.toFixed(2)}</b> · compliance {r.complianceResult}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{formatWhen(r.createdAt)}</span>
                </div>
                <p className="mt-1.5 text-sm text-foreground">{r.reason}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {r.policyRuleIds.map((id) => (
                    <span key={id} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">{id}</span>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Decision note (optional)"
                    className="min-w-48 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: r.id, approve: true })}
                    className="rounded-md border border-mimi-positive bg-mimi-positive/15 px-3 py-1.5 text-sm font-semibold text-mimi-positive hover:bg-mimi-positive/25 disabled:opacity-50"
                  >
                    Approve & resume workflow
                  </button>
                  <button
                    type="button"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: r.id, approve: false })}
                    className="rounded-md border border-mimi-danger bg-mimi-danger/15 px-3 py-1.5 text-sm font-semibold text-mimi-danger hover:bg-mimi-danger/25 disabled:opacity-50"
                  >
                    Reject payment
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Decision history">
          <ul className="space-y-2">
            {decided.slice(0, 12).map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span>
                  <span className="font-medium tabular-nums">{formatUsd(r.amountUsd)}</span>{" "}
                  <span className="text-xs text-muted-foreground">{r.id} · {formatWhen(r.decidedAt)}</span>
                </span>
                <StatusBadge status={r.status} />
              </li>
            ))}
            {decided.length === 0 ? <li className="text-sm text-muted-foreground">No decisions yet.</li> : null}
          </ul>
        </Panel>

        <Panel title="Open cases" subtitle="Fraud / compliance / escalation cases opened by agents">
          <ul className="space-y-2">
            {(data?.cases ?? []).slice(0, 10).map((c) => (
              <li key={c.id} className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className={`size-1.5 rounded-full ${c.severity === "high" ? "bg-mimi-danger" : c.severity === "medium" ? "bg-mimi-warning" : "bg-mimi-info"}`} />
                  <span className="text-sm font-medium text-foreground">{c.title}</span>
                  <StatusBadge status={c.status} className="ml-auto" />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.summary}</p>
                <div className="mt-1 text-(length:--text-nano) text-muted-foreground">{c.kind} case · opened by {c.openedByAgent} · {formatWhen(c.createdAt)}</div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/** Policy Center — deterministic rules with live toggles. */
export function MimiPolicies() {
  useMimiLive();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["mimi", "policies"], queryFn: () => mimiApi.policies() });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => mimiApi.updatePolicy(id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mimi"] }),
  });

  return (
    <div>
      <PageHeader
        title="Policies"
        subtitle="Deterministic financial guardrails — LLM output never executes privileged actions without passing these rules."
      />
      <div className="space-y-2">
        {(data?.policies ?? []).map((rule) => (
          <div key={rule.id} className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
            <label className="mt-0.5 inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => toggle.mutate({ id: rule.id, enabled: e.target.checked })}
                className="peer sr-only"
              />
              <span className="relative h-5 w-9 rounded-full bg-muted transition-colors peer-checked:bg-mimi-positive after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:after:translate-x-4" />
            </label>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">{rule.name}</span>
                <StatusBadge status={rule.effect} />
                <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">{rule.category}</span>
                <span className="text-(length:--text-nano) text-muted-foreground">priority {rule.priority} · {rule.id}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{rule.description}</p>
              {Object.keys(rule.params).length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(rule.params).map(([k, v]) => (
                    <span key={k} className="rounded bg-background px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
                      {k}: {Array.isArray(v) ? v.join(" | ") : String(v)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
