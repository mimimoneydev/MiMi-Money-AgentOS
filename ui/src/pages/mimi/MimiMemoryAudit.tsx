import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { mimiApi } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, formatWhen } from "./shared";

/** Memory Bank inspector — browse the Firestore-shaped collections. */
export function MimiMemoryBank() {
  useMimiLive();
  const [selected, setSelected] = useState<string>("workflows");
  const { data: collections } = useQuery({ queryKey: ["mimi", "collections"], queryFn: () => mimiApi.collections() });
  const { data: docs } = useQuery({
    queryKey: ["mimi", "collection", selected],
    queryFn: () => mimiApi.collectionDocs(selected, 30),
  });

  return (
    <div>
      <PageHeader
        title="Memory Bank"
        subtitle={`Persistent agent/customer/transaction/workflow/audit state${collections?.stats.projectId ? ` · ${collections.stats.mode} · ${collections.stats.projectId}` : ` · ${collections?.stats.mode ?? ""}`}. Private model chain-of-thought is never stored.`}
      />
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="lg:w-64 shrink-0">
          <Panel title="Collections">
          <ul className="space-y-1">
            {(collections?.collections ?? []).map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => setSelected(c.name)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                    selected === c.name ? "border border-mimi-accent bg-mimi-accent-soft font-medium text-foreground" : "border border-transparent text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <span className="font-mono">{c.name}</span>
                  {c.documents != null ? <span className="text-xs tabular-nums">{c.documents}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        </div>

        <div className="min-w-0 flex-1">
        <Panel title={selected} subtitle={`${docs?.documents.length ?? 0} most recent documents`}>
          <div className="max-h-128 space-y-2 overflow-y-auto">
            {(docs?.documents ?? []).map((d, i) => (
              <details key={(d.id as string) ?? i} className="rounded-md border border-border">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-mimi-accent-strong">{String(d.id ?? d.eventId ?? d.runId)}</span>
                  {typeof d.type === "string" ? <span className="text-xs text-muted-foreground">{d.type}</span> : null}
                  {typeof d.status === "string" ? <span className="ml-auto text-xs text-muted-foreground">{d.status}</span> : null}
                  {typeof d.createdAt === "string" || typeof d.at === "string" ? (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatWhen((d.createdAt as string) ?? (d.at as string))}</span>
                  ) : null}
                </summary>
                <pre className="overflow-x-auto border-t border-border bg-background px-3 py-2 font-mono text-(length:--text-nano) leading-relaxed text-muted-foreground">
{JSON.stringify(d, null, 2)}
                </pre>
              </details>
            ))}
            {(docs?.documents ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Empty collection.</p> : null}
          </div>
        </Panel>
        </div>
      </div>
    </div>
  );
}

/** Audit Center — every gateway decision and sensitive action. */
export function MimiAudit() {
  useMimiLive();
  const { data } = useQuery({ queryKey: ["mimi", "audit"], queryFn: () => mimiApi.audit(200), refetchInterval: 4_000 });
  return (
    <div>
      <PageHeader title="Audit" subtitle="Immutable trail: identity → decision → tool execution → outcome, for every privileged action." />
      <Panel>
        <div className="max-h-144 overflow-y-auto">
          <table className="w-full min-w-160 text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                <th className="px-2 py-2 font-medium">When</th>
                <th className="px-2 py-2 font-medium">Actor</th>
                <th className="px-2 py-2 font-medium">Action</th>
                <th className="px-2 py-2 font-medium">Outcome</th>
                <th className="px-2 py-2 font-medium">Subject</th>
                <th className="px-2 py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {(data?.audit ?? []).map((a) => (
                <tr key={a.id} className="border-b border-border last:border-none hover:bg-muted/40">
                  <td className="px-2 py-2 font-mono text-(length:--text-nano) text-muted-foreground">{new Date(a.at).toLocaleTimeString()}</td>
                  <td className="px-2 py-2 text-xs font-medium">{a.actor}</td>
                  <td className="px-2 py-2 font-mono text-xs">{a.action}</td>
                  <td className="px-2 py-2">
                    <span
                      className={`font-mono text-(length:--text-nano) font-semibold uppercase ${
                        a.outcome === "EXECUTED" || a.outcome === "ALLOWED"
                          ? "text-mimi-positive"
                          : a.outcome === "DENIED" || a.outcome === "ERROR"
                            ? "text-mimi-danger"
                            : a.outcome === "APPROVAL_REQUIRED"
                              ? "text-mimi-warning"
                              : "text-muted-foreground"
                      }`}
                    >
                      {a.outcome.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-(length:--text-nano) text-muted-foreground">{a.subjectType}{a.subjectId ? `/${a.subjectId}` : ""}</td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{a.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
