import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { mimiApi, type MimiWorkflow } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, StatusBadge, formatUsd, formatWhen } from "./shared";

/**
 * Workflow Orchestration — REAL backend state rendered as a graph:
 * Payment Event → Payment Agent → Fraud ∥ Compliance → Risk → Policy Gate
 * (→ Human Review) → Treasury → Reconciliation → Completion → Support ∥ Reporting.
 * Every node color/label comes from persisted workflow step state.
 */
const GRAPH: Array<{ key: string; label: string; agent: string; row: number }> = [
  { key: "validate", label: "Validate & initiate", agent: "Payment Agent", row: 0 },
  { key: "fraud", label: "Fraud analysis", agent: "Fraud Agent", row: 1 },
  { key: "compliance", label: "Compliance screening", agent: "Compliance Agent", row: 2 },
  { key: "risk", label: "Composite risk", agent: "Risk Agent", row: 1 },
  { key: "gate", label: "Policy gate / approval", agent: "Orchestrator", row: 1 },
  { key: "settlement-plan", label: "Settlement plan", agent: "Treasury Agent", row: 1 },
  { key: "reconciliation", label: "Reconciliation", agent: "Reconciliation Agent", row: 1 },
  { key: "completion", label: "Completion", agent: "Orchestrator", row: 1 },
];

export function MimiWorkflows() {
  useMimiLive();
  const { data } = useQuery({ queryKey: ["mimi", "workflows"], queryFn: () => mimiApi.workflows(), refetchInterval: 3_000 });
  return (
    <div>
      <PageHeader title="Workflows" subtitle="Every payment is an orchestrated agent workflow with persisted state transitions." />
      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                <th className="px-2 py-2 font-medium">Workflow</th>
                <th className="px-2 py-2 font-medium">Transaction</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Current</th>
                <th className="px-2 py-2 font-medium">Review</th>
                <th className="px-2 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {(data?.workflows ?? []).map((w) => (
                <tr key={w.id} className="border-b border-border last:border-none hover:bg-muted/40">
                  <td className="px-2 py-2">
                    <Link to={`/mimi/workflows/${w.id}`} className="font-mono text-xs text-mimi-accent-strong hover:underline">
                      {w.id}
                    </Link>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-muted-foreground">{w.transactionId}</td>
                  <td className="px-2 py-2"><StatusBadge status={w.status} /></td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{w.currentStepKeys.join(", ") || "—"}</td>
                  <td className="px-2 py-2 text-xs">
                    {w.humanReviewId ? (
                      <Link to="/mimi/human-reviews" className="text-mimi-warning hover:underline">{w.humanReviewId}</Link>
                    ) : "—"}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{formatWhen(w.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export function MimiWorkflowDetail() {
  useMimiLive();
  const { workflowId = "" } = useParams();
  const { data: wf } = useQuery({
    queryKey: ["mimi", "workflow", workflowId],
    queryFn: () => mimiApi.workflow(workflowId),
    refetchInterval: 1_500,
  });
  if (!wf) return <div className="p-6 text-sm text-muted-foreground">Loading workflow…</div>;
  const stepOf = (key: string) => wf.steps.find((s) => s.key === key);

  return (
    <div>
      <PageHeader
        title={`Workflow ${wf.id}`}
        subtitle={`Transaction ${wf.transactionId} · created ${formatWhen(wf.createdAt)}`}
        actions={<StatusBadge status={wf.status} />}
      />

      <Panel title="Orchestration graph" subtitle="Live backend state — nodes reflect persisted step statuses" className="mb-4">
        <div className="flex items-stretch gap-2 overflow-x-auto pb-2">
          {/* Payment event */}
          <Node label="payment.received" sub="Pub/Sub" status={wf.steps.some((s) => s.status !== "IDLE") ? "COMPLETED" : "QUEUED"} />
          <Arrow />
          {GRAPH.slice(0, 1).map((g) => <Node key={g.key} label={g.label} sub={g.agent} status={stepOf(g.key)?.status ?? "IDLE"} detail={stepOf(g.key)} />)}
          <Arrow />
          {/* parallel band */}
          <div className="grid content-center gap-1.5">
            {GRAPH.slice(1, 3).map((g) => (
              <Node key={g.key} label={g.label} sub={g.agent} status={stepOf(g.key)?.status ?? "IDLE"} compact detail={stepOf(g.key)} />
            ))}
          </div>
          <Arrow />
          {GRAPH.slice(3).map((g) => (
            <span key={g.key} className="contents">
              <Node label={g.label} sub={g.agent} status={stepOf(g.key)?.status ?? "IDLE"} detail={stepOf(g.key)} />
              <Arrow />
            </span>
          ))}
          {/* fan-out finishers */}
          <div className="grid content-center gap-1.5">
            <Node label="Customer support" sub="Support Agent" status={stepOf("support-followup")?.status ?? "IDLE"} compact detail={stepOf("support-followup")} />
            <Node label="Reporting" sub="Reporting Agent" status={stepOf("reporting")?.status ?? "IDLE"} compact detail={stepOf("reporting")} />
          </div>
        </div>

        {wf.status === "WAITING_FOR_HUMAN" ? (
          <div className="mt-2 rounded-md border border-mimi-warning bg-mimi-warning/10 px-4 py-2.5 text-sm text-mimi-warning">
            Policy Engine requires human approval — this workflow is paused on real backend state until an operator decides in{" "}
            <Link to="/mimi/human-reviews" className="font-semibold underline">Human Reviews</Link>.
          </div>
        ) : null}
        {wf.policyDecision ? (
          <div className="mt-2 rounded-md border border-border bg-background px-4 py-2.5 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Policy gate:</span>{" "}
            <StatusBadge status={wf.policyDecision.decision} />{" "}
            {wf.policyDecision.reasons.join(" · ")}
          </div>
        ) : null}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Operational trace" subtitle="Safe audit events only — no hidden chain-of-thought">
          <ol className="space-y-1.5">
            {[...wf.trace].reverse().map((t, i) => (
              <li key={`${t.at}-${i}`} className="flex items-baseline gap-2 text-xs">
                <span className={`size-1.5 shrink-0 rounded-full ${t.level === "error" ? "bg-mimi-danger" : t.level === "warn" ? "bg-mimi-warning" : "bg-mimi-positive"}`} />
                <span className="shrink-0 font-mono text-muted-foreground">{new Date(t.at).toLocaleTimeString()}</span>
                <span className="shrink-0 font-medium text-foreground">{t.actor}</span>
                <span className="text-muted-foreground">{t.message}</span>
              </li>
            ))}
          </ol>
        </Panel>

        <Panel title="ADK runs & artifacts" subtitle="Tool calls executed through the Gateway">
          {(wf.runs ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Runs appear here as agents execute.</p>
          ) : (
            <ul className="space-y-2">
              {wf.runs.map((r) => (
                <li key={r.runId} className="rounded-md border border-border p-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{r.agentId}</span>
                    <span className="text-muted-foreground">· {r.stepKey}</span>
                    <StatusBadge status={r.status} />
                    <span className="ml-auto text-muted-foreground">{r.toolCalls.length} tools · {r.adapterMode}</span>
                  </div>
                  {r.outputText ? <p className="mt-1 line-clamp-2 text-muted-foreground">{r.outputText}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Arrow() {
  return <span aria-hidden className="my-auto shrink-0 text-mimi-grid">→</span>;
}

function Node(props: {
  label: string;
  sub: string;
  status: string;
  compact?: boolean;
  detail?: { outputSummary: string | null; error: string | null; attempt?: number };
}) {
  const active = props.status === "RUNNING" || props.status === "WAITING";
  return (
    <div
      title={props.detail?.outputSummary ?? undefined}
      className={`min-w-32 rounded-lg border px-2.5 py-2 ${
        props.status === "COMPLETED"
          ? "border-mimi-positive bg-mimi-positive/10"
          : active
            ? "animate-pulse border-mimi-accent bg-mimi-accent-soft"
            : props.status === "FAILED"
              ? "border-mimi-danger bg-mimi-danger/10"
              : "border-border bg-card"
      }`}
    >
      <div className={`truncate font-medium text-foreground ${props.compact ? "text-xs" : "text-xs"}`}>{props.label}</div>
      <div className="truncate text-(length:--text-nano) text-muted-foreground">{props.sub}</div>
      <div className="mt-1"><StatusBadge status={props.status} /></div>
    </div>
  );
}

/** Transactions operations table. */
export function MimiTransactions() {
  useMimiLive();
  const [selected, setSelected] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["mimi", "transactions"], queryFn: () => mimiApi.transactions(), refetchInterval: 3_000 });
  const txs = data?.transactions ?? [];
  return (
    <div>
      <PageHeader title="Transactions" subtitle="Sandbox payment ledger across all corridors." />
      <Panel>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
              <th className="px-2 py-2 font-medium">Reference</th>
              <th className="px-2 py-2 font-medium">Customer</th>
              <th className="px-2 py-2 font-medium">Amount</th>
              <th className="px-2 py-2 font-medium">Asset / network</th>
              <th className="px-2 py-2 font-medium">Fraud</th>
              <th className="px-2 py-2 font-medium">Compliance</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSelected(t.workflowId)}
                className="cursor-pointer border-b border-border last:border-none hover:bg-muted/40"
              >
                <td className="px-2 py-2 font-mono text-xs">{t.reference}</td>
                <td className="px-2 py-2 font-mono text-xs text-muted-foreground">{t.customerId}</td>
                <td className="px-2 py-2 font-semibold tabular-nums">{formatUsd(t.amountUsd)}</td>
                <td className="px-2 py-2 text-xs text-muted-foreground">{t.asset} · {t.network}</td>
                <td className="px-2 py-2 tabular-nums">{t.fraudRiskScore?.toFixed(2) ?? "—"}</td>
                <td className="px-2 py-2"><StatusBadge status={t.complianceResult ?? "PENDING"} /></td>
                <td className="px-2 py-2"><StatusBadge status={t.status} /></td>
                <td className="px-2 py-2 text-xs text-muted-foreground">{formatWhen(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {selected ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Open the linked workflow: <Link to={`/mimi/workflows/${selected}`} className="font-mono text-mimi-accent-strong hover:underline">{selected}</Link>
        </p>
      ) : null}
    </div>
  );
}

export type { MimiWorkflow };
