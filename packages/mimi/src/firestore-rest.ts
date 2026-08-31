import type {
  MemoryBank,
  MemoryBankCollection,
  MemoryBankStats,
} from "./types.js";
import { MEMORY_BANK_COLLECTIONS } from "./types.js";

/**
 * Google Firestore Memory Bank backend over the REST API.
 *
 * Targets FIRESTORE_EMULATOR_HOST when set (local dev / CI), otherwise
 * production Firestore with Application Default Credentials resolved from
 * the Cloud Run metadata server. Zero SDK dependencies.
 */

export interface FirestoreMemoryBankOptions {
  projectId?: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
}

export function resolveFirestoreProjectId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.FIRESTORE_PROJECT_ID?.trim()
    || env.GOOGLE_CLOUD_PROJECT?.trim()
    || env.GCP_PROJECT_ID?.trim()
    || null;
}

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields: Record<string, FirestoreValue> } };

function toFirestoreValue(v: unknown): FirestoreValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) fields[k] = toFirestoreValue(val);
  return { mapValue: { fields } };
}

function fromFirestoreValue(v: FirestoreValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFirestoreValue);
  return Object.fromEntries(
    Object.entries(v.mapValue.fields).map(([k, fv]) => [k, fromFirestoreValue(fv)]),
  );
}

export class FirestoreMemoryBank implements MemoryBank {
  readonly mode: "firestore-emulator" | "firestore";
  private readonly projectId: string;
  private readonly databaseId: string;
  private readonly ffetch: typeof fetch;

  constructor(opts: FirestoreMemoryBankOptions = {}) {
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST?.trim();
    this.mode = emulatorHost ? "firestore-emulator" : "firestore";
    this.projectId = opts.projectId ?? resolveFirestoreProjectId() ?? "mimi-local";
    this.databaseId = opts.databaseId ?? "(default)";
    this.ffetch = opts.fetchImpl ?? fetch;
  }

  private docUrl(collection: string, id: string): string {
    const base = process.env.FIRESTORE_EMULATOR_HOST?.trim()
      ? `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1`
      : "https://firestore.googleapis.com/v1";
    return `${base}/projects/${this.projectId}/databases/${encodeURIComponent(this.databaseId)}/documents/${collection}/${id}`;
  }

  async put<T extends { id: string }>(collection: MemoryBankCollection, doc: T): Promise<T> {
    const existing = await this.get<T>(collection, doc.id);
    const body = {
      fields: Object.fromEntries(
        Object.entries({
          ...doc,
          createdAt: ((existing as unknown as { createdAt?: string })?.createdAt) ?? ((doc as unknown as { createdAt?: string }).createdAt) ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).map(([k, v]) => [k, toFirestoreValue(v)]),
      ),
    };
    const res = await this.ffetch(this.docUrl(collection, doc.id), {
      method: "PATCH",
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 409) throw new Error(`firestore put failed: ${res.status}`);
    return { ...doc, createdAt: ((existing as unknown as { createdAt?: string })?.createdAt) ?? ((doc as unknown as { createdAt?: string }).createdAt) } as T;
  }

  async get<T>(collection: MemoryBankCollection, id: string): Promise<T | null> {
    const res = await this.ffetch(this.docUrl(collection, id), {
      headers: await this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`firestore get failed: ${res.status}`);
    const body = (await res.json()) as { fields?: Record<string, FirestoreValue> };
    if (!body.fields) return null;
    return decodeDoc(body.fields, id) as T;
  }

  async update<T extends { id: string }>(
    collection: MemoryBankCollection,
    id: string,
    patch: Partial<T>,
  ): Promise<T | null> {
    const current = await this.get<T>(collection, id);
    if (!current) return null;
    return this.put(collection, { ...(current as T), ...patch, id });
  }

  async delete(collection: MemoryBankCollection, id: string): Promise<boolean> {
    const res = await this.ffetch(this.docUrl(collection, id), {
      method: "DELETE",
      headers: await this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok || res.status === 404;
  }

  async list<T>(
    collection: MemoryBankCollection,
    opts: { orderBy?: string; direction?: "asc" | "desc"; limit?: number } = {},
  ): Promise<T[]> {
    const base = process.env.FIRESTORE_EMULATOR_HOST?.trim()
      ? `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1`
      : "https://firestore.googleapis.com/v1";
    const url = new URL(`${base}/projects/${this.projectId}/databases/${encodeURIComponent(this.databaseId)}/documents/${collection}`);
    url.searchParams.set("pageSize", String(Math.min(opts.limit ?? 200, 300)));
    const field = opts.orderBy ?? "createdAt";
    // runQuery would be more expressive; list + client sort keeps the surface tiny.
    const res = await this.ffetch(url.toString(), {
      headers: await this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`firestore list failed: ${res.status}`);
    const body = (await res.json()) as Array<{ fields?: Record<string, FirestoreValue>; name?: string }>;
    const rows = (body ?? [])
      .filter((d) => d.fields)
      .map((d) => decodeDoc(d.fields!, d.name?.split("/").pop() ?? ""))
      .sort((a: any, b: any) => {
        const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
        return opts.direction === "asc" ? cmp : -cmp;
      }) as T[];
    return rows;
  }

  async count(collection: MemoryBankCollection): Promise<number> {
    const rows = await this.list(collection, { limit: 300 });
    return rows.length;
  }

  stats(): MemoryBankStats {
    // Counts are served lazily by the service layer; keep the snapshot cheap.
    return {
      mode: this.mode,
      projectId: this.projectId,
      collections: MEMORY_BANK_COLLECTIONS.map((name) => ({ name, documents: -1 })),
      totalDocuments: -1,
    };
  }

  private async headers(): Promise<Record<string, string>> {
    if (this.mode === "firestore-emulator") return { "Content-Type": "application/json" };
    try {
      const res = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2_000) },
      );
      if (!res.ok) throw new Error(String(res.status));
      const token = ((await res.json()) as { access_token: string }).access_token;
      return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    } catch {
      return { "Content-Type": "application/json" };
    }
  }
}

function decodeDoc(fields: Record<string, FirestoreValue>, id: string): Record<string, unknown> {
  return { id, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromFirestoreValue(v)])) };
}
