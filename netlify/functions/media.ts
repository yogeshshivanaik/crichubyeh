import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Uploaded logos, player photos and sounds. Stored once in Netlify Blobs and
// served from a shared URL so every device sees the same files.

const MAX = 5 * 1024 * 1024;
const ID_RE = /^[a-z0-9]{6,40}$/;

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "media", consistency: "strong" });

  if (req.method === "POST") {
    const type = req.headers.get("content-type") || "application/octet-stream";
    if (!/^(image|audio)\//.test(type)) return Response.json({ error: "Only images and audio" }, { status: 415 });
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX) return Response.json({ error: "File too big (max 5 MB)" }, { status: 413 });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    await store.set(id, buf, { metadata: { type } });
    return Response.json({ id });
  }

  if (req.method === "GET") {
    const id = context.params.id;
    if (!id || !ID_RE.test(id)) return new Response("Not found", { status: 404 });
    const r = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!r) return new Response("Not found", { status: 404 });
    return new Response(r.data, {
      headers: {
        "content-type": String(r.metadata?.type || "application/octet-stream"),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: ["/api/media", "/api/media/:id"] };
