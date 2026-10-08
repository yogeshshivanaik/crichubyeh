import type { Config } from "@netlify/functions";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";

// Path-based document API used by public/index.html (a small Firestore-like
// shim). Every device reads and writes the same Netlify Database, so rooms,
// bids, chat and uploaded media references stay in sync across devices.

type Req =
  | { op: "get"; path: string }
  | { op: "set"; path: string; data: unknown }
  | { op: "update"; path: string; data: Record<string, unknown> }
  | { op: "delete"; path: string }
  | { op: "add"; col: string; data: unknown }
  | { op: "query"; col: string; f?: [string, unknown][]; o?: [string, string] | null; l?: number }
  | { op: "acquire"; path: string; holder: string; ttlMs?: number; data?: Record<string, unknown> };

const PATH_RE = /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/;
const FIELD_RE = /^[A-Za-z0-9_]+$/;

const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
const idOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const run = async (q: SQL) => rowsOf(await db.execute(q));

function checkPath(p: unknown, isDoc: boolean): string {
  if (typeof p !== "string" || p.length > 300 || !PATH_RE.test(p)) throw new Error("Bad path");
  const segs = p.split("/").length;
  if (isDoc ? segs % 2 !== 0 : segs % 2 !== 1) throw new Error("Bad path");
  return p;
}

async function handle(r: Req): Promise<unknown> {
  const now = Date.now();
  switch (r.op) {
    case "get": {
      const path = checkPath(r.path, true);
      const [row] = await run(sql`SELECT data FROM docs WHERE path = ${path}`);
      return row ? { exists: true, data: row.data } : { exists: false };
    }
    case "set": {
      const path = checkPath(r.path, true);
      await run(sql`INSERT INTO docs (path, parent, data, updated_at)
        VALUES (${path}, ${parentOf(path)}, ${JSON.stringify(r.data ?? {})}::jsonb, ${now})
        ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`);
      return { ok: true };
    }
    case "update": {
      const path = checkPath(r.path, true);
      await run(sql`INSERT INTO docs (path, parent, data, updated_at)
        VALUES (${path}, ${parentOf(path)}, ${JSON.stringify(r.data ?? {})}::jsonb, ${now})
        ON CONFLICT (path) DO UPDATE SET data = docs.data || EXCLUDED.data, updated_at = EXCLUDED.updated_at`);
      return { ok: true };
    }
    case "delete": {
      const path = checkPath(r.path, true);
      await run(sql`DELETE FROM docs WHERE path = ${path}`);
      return { ok: true };
    }
    case "add": {
      const col = checkPath(r.col, false);
      const id = now.toString(36) + Math.random().toString(36).slice(2, 10);
      const path = `${col}/${id}`;
      await run(sql`INSERT INTO docs (path, parent, data, updated_at)
        VALUES (${path}, ${col}, ${JSON.stringify(r.data ?? {})}::jsonb, ${now})`);
      return { id };
    }
    case "query": {
      const col = checkPath(r.col, false);
      const filter: Record<string, unknown> = {};
      for (const [k, v] of r.f ?? []) {
        if (!FIELD_RE.test(k)) throw new Error("Bad field");
        filter[k] = v;
      }
      let order = sql`ORDER BY path`;
      if (r.o) {
        if (!FIELD_RE.test(r.o[0])) throw new Error("Bad field");
        order = sql`ORDER BY data -> ${r.o[0]}::text ${sql.raw(r.o[1] === "desc" ? "DESC" : "ASC")}, path`;
      }
      const limit = Math.min(Math.max(Number(r.l) || 1000, 1), 1000);
      const rows = await run(sql`SELECT path, data FROM docs
        WHERE parent = ${col} AND data @> ${JSON.stringify(filter)}::jsonb ${order} LIMIT ${limit}`);
      return { docs: rows.map((x) => ({ id: idOf(x.path), data: x.data })) };
    }
    case "acquire": {
      // Atomic lock: succeeds if the doc is free, expired, or already ours.
      const path = checkPath(r.path, true);
      const holder = String(r.holder);
      const data = { ...(r.data ?? {}), __h: holder, __x: now + (Number(r.ttlMs) || 60000) };
      const won = await run(sql`INSERT INTO docs (path, parent, data, updated_at)
        VALUES (${path}, ${parentOf(path)}, ${JSON.stringify(data)}::jsonb, ${now})
        ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
        WHERE COALESCE((docs.data ->> '__x')::bigint, 0) <= ${now} OR docs.data ->> '__h' = ${holder}
        RETURNING path`);
      if (won.length) return { acquired: true, holder };
      const [cur] = await run(sql`SELECT data ->> '__h' AS h FROM docs WHERE path = ${path}`);
      return { acquired: false, holder: cur?.h ?? null };
    }
    default:
      throw new Error("Unknown op");
  }
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body: { reqs?: Req[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  const reqs = Array.isArray(body.reqs) ? body.reqs.slice(0, 50) : [];
  const out = await Promise.all(
    reqs.map((r) => handle(r).then((v) => ({ ok: v }), (e) => ({ err: String(e?.cause?.message || e?.message || e) }))),
  );
  return Response.json({ res: out }, { headers: { "cache-control": "no-store" } });
};

export const config: Config = { path: "/api/db" };
