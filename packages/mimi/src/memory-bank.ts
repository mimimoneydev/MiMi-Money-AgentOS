import type {
  MemoryBank,
  MemoryBankCollection,
  MemoryBankStats,
} from "./types.js";
import { MEMORY_BANK_COLLECTIONS } from "./types.js";
/**
 * The MiMi Memory Bank: persistent state for agents, workflows and audit.
 *
 * Two interchangeable backends implement the same tiny interface:
 *  - InMemoryMemoryBank   → local dev, tests, zero-dependency demo mode
 *  - FirestoreMemoryBank  → real Google Firestore over REST (emulator or prod)
 */

export interface MemoryBankDocBase {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export class InMemoryMemoryBank implements MemoryBank {
  readonly mode = "in-memory" as const;
  private readonly stores = new Map<MemoryBankCollection, Map<string, Record<string, unknown>>>();
  private readonly order: string[] = [];

  constructor() {
    for (const c of MEMORY_BANK_COLLECTIONS) this.stores.set(c, new Map());
  }

  async put<T extends { id: string }>(collection: MemoryBankCollection, doc: T): Promise<T> {
    const store = this.store(collection);
    interface Stampable { id: string; createdAt?: string; updatedAt?: string }
    const existing = store.get(doc.id) as { createdAt?: string } | undefined;
    const source = doc as unknown as Stampable;
    const stamped = {
      ...doc,
      createdAt: existing?.createdAt ?? source.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    if (!existing) this.order.push(`${collection}:${doc.id}`);
    store.set(doc.id, stamped);
    return stamped as T;
  }

  async get<T>(collection: MemoryBankCollection, id: string): Promise<T | null> {
    return ((this.store(collection).get(id) as T) ?? null);
  }

  async update<T extends { id: string }>(
    collection: MemoryBankCollection,
    id: string,
    patch: Partial<T>,
  ): Promise<T | null> {
    const store = this.store(collection);
    const current = store.get(id) as (T & { id: string; createdAt: string }) | undefined;
    if (!current) return null;
    const next = { ...current, ...patch, id, updatedAt: nowIso() };
    store.set(id, next);
    return next as T;
  }

  async delete(collection: MemoryBankCollection, id: string): Promise<boolean> {
    return this.store(collection).delete(id);
  }

  async list<T>(
    collection: MemoryBankCollection,
    opts: { orderBy?: string; direction?: "asc" | "desc"; limit?: number } = {},
  ): Promise<T[]> {
    const rows = [...this.store(collection).values()] as (T & { [k: string]: unknown })[];
    const field = opts.orderBy ?? "createdAt";
    rows.sort((a, b) => {
      const av = String(a[field] ?? "");
      const bv = String(b[field] ?? "");
      const cmp = av.localeCompare(bv);
      return opts.direction === "asc" ? cmp : -cmp;
    });
    return (opts.limit ? rows.slice(0, opts.limit) : rows) as T[];
  }

  async count(collection: MemoryBankCollection): Promise<number> {
    return this.store(collection).size;
  }

  stats(): MemoryBankStats {
    const collections = MEMORY_BANK_COLLECTIONS.map((name) => ({
      name,
      documents: this.stores.get(name)!.size,
    }));
    return {
      mode: this.mode,
      projectId: null,
      collections,
      totalDocuments: collections.reduce((acc, c) => acc + c.documents, 0),
    };
  }

  /** Snapshot everything (used by tests and local backup). */
  dump(): Record<string, Array<Record<string, unknown>>> {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const c of MEMORY_BANK_COLLECTIONS) out[c] = [...this.store(c).values()];
    return out;
  }

  private store(c: MemoryBankCollection): Map<string, Record<string, unknown>> {
    const s = this.stores.get(c);
    if (!s) throw new Error(`unknown memory bank collection: ${c}`);
    return s;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
