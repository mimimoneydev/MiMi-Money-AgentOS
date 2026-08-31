import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { mimiApi, type MimiEvent } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, StatusBadge, formatWhen } from "./shared";

/**
 * Event Stream — the Pub/Sub backbone made visible. Live events arrive over
 * SSE straight from the server's bus; history is served from the backend.
 */
export function MimiEvents() {
  useMimiLive((e) => setLive((prev) => [e, ...prev].slice(0, 200)));
  const { data } = useQuery({ queryKey: ["mimi", "events"], queryFn: () => mimiApi.events(200) });
  const [live, setLive] = useState<MimiEvent[]>([]);
  const [topicFilter, setTopicFilter] = useState<string>("all");

  // Seed the live buffer from history on first load.
  useEffect(() => {
    if (data && live.length === 0) setLive(data.events);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const topics = Array.from(new Set([...live].map((e) => e.topic))).sort();
  const shown = topicFilter === "all" ? live : live.filter((e) => e.topic === topicFilter);

  return (
    <div>
      <PageHeader
        title="Event Stream"
        subtitle="Idempotent envelopes with workflow + correlation IDs — duplicates suppressed, retries and DLQ handled by the backbone."
        actions={
          <select
            value={topicFilter}
            onChange={(e) => setTopicFilter(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
          >
            <option value="all">All topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        }
      />
      <Panel className="mb-4">
        <div className="max-h-112 overflow-y-auto font-mono text-xs">
          {shown.map((e) => (
            <div key={e.eventId} className="flex items-baseline gap-2 border-b border-border/60 py-1.5 last:border-none">
              <span className="shrink-0 text-muted-foreground">{new Date(e.occurredAt).toLocaleTimeString()}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-(length:--text-nano) text-muted-foreground">{e.topic}</span>
              <span className="shrink-0 font-semibold text-foreground">{e.type}</span>
              <span className="shrink-0 text-mimi-info">{e.sourceAgent}</span>
              {e.workflowId ? <span className="shrink-0 truncate text-mimi-accent-strong">wf:{short(e.workflowId)}</span> : null}
              <span className="truncate text-muted-foreground" title={JSON.stringify(e.payload)}>{summarize(e.payload)}</span>
              <span className="ml-auto shrink-0 text-(length:--text-nano) text-muted-foreground">att {e.attempt}</span>
            </div>
          ))}
          {shown.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Waiting for events…</p> : null}
        </div>
      </Panel>

      {(data?.deadLetters ?? []).length > 0 ? (
        <Panel title={`Dead-letter queue (${data?.deadLetters.length})`} subtitle="Events that exhausted retries — replayable via /api/mimi/admin/recover">
          <ul className="space-y-2">
            {data?.deadLetters.map((d) => (
              <li key={d.id} className="rounded-md border border-mimi-danger/40 bg-mimi-danger/5 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <StatusBadge status="FAILED" />
                  <span className="font-semibold text-foreground">{d.event.type}</span>
                  <span className="text-muted-foreground">{d.event.topic} · {d.attempts} attempts · {formatWhen(d.failedAt)}</span>
                </div>
                <p className="mt-1 text-mimi-danger">{d.reason}</p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function short(id: string): string {
  return id.length > 14 ? id.slice(0, 11) + "…" : id;
}

function summarize(payload: Record<string, unknown>): string {
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.reason === "string") return payload.reason;
  return Object.entries(payload).slice(0, 4).map(([k, v]) => `${k}=${String(v).slice(0, 48)}`).join(" ");
}
