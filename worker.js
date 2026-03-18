// add variable secret: ADMINKEY

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-API-Key",
    };

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Rate limit helper
    async function checkRateLimit(ip) {
      const last = await env.DB.prepare(
        "SELECT created_at FROM guestbook WHERE ip=? ORDER BY id DESC LIMIT 1"
      ).bind(ip).first();
      if (last && (Date.now() - new Date(last.created_at)) < 5000) {
        return true;
      }
      return false;
    }

    // GET /
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({
        project: "gb.ciu.workers.dev",
        endpoints: {
          Post: "POST /api/guestbook",
          Get: "GET /api/guestbook?page=&limit=",
          RealTime: "GET /api/guestbook/stream",
          Delete: "DELETE /api/guestbook/:id"
        }
      }, null, 2), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
    // GET /api/guestbook?page=&limit=
    if (url.pathname === "/api/guestbook" && request.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const offset = (page - 1) * limit;
      const { results } = await env.DB.prepare(
        "SELECT * FROM guestbook ORDER BY id DESC LIMIT ? OFFSET ?"
      ).bind(limit, offset).all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type":"application/json", ...corsHeaders } });
    }

    // POST /api/guestbook
    if (url.pathname === "/api/guestbook" && request.method === "POST") {
      let data;
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        data = await request.json();
      } else {
        return new Response(JSON.stringify({ error: "Content-Type must be application/json" }), { status: 400, headers: corsHeaders });
      }
      const name = data.name?.trim();
      const message = data.message?.trim();
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!name || !message) return new Response(JSON.stringify({ error: "Name & message required" }), { status: 400, headers: corsHeaders });
      if (await checkRateLimit(ip)) return new Response(JSON.stringify({ error: "Too fast, slow down!" }), { status: 429, headers: corsHeaders });
      await env.DB.prepare("INSERT INTO guestbook (name,message,ip) VALUES (?,?,?)").bind(name,message,ip).run();
      // Trigger SSE by writing to a pseudo-event queue (simplified)
      if (env.EVENT_QUEUE) {
        env.EVENT_QUEUE.send(JSON.stringify({ name, message, created_at: new Date().toISOString() }));
      }
      return new Response(JSON.stringify({ success:true }), { headers: { "Content-Type":"application/json", ...corsHeaders } });
    }

    // DELETE /api/guestbook/:id
    if (url.pathname.startsWith("/api/guestbook/") && request.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const key = request.headers.get("X-API-Key") || "";
      if (key !== env.ADMINKEY) return new Response("Forbidden", { status: 403 });
      await env.DB.prepare("DELETE FROM guestbook WHERE id=?").bind(id).run();
      return new Response(JSON.stringify({ success:true }), { headers: { "Content-Type":"application/json", ...corsHeaders } });
    }

    // SSE realtime: /api/guestbook/stream
    if (url.pathname === "/api/guestbook/stream" && request.method === "GET") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      writer.write(`retry: 3000\n\n`);

      // Pseudo simple SSE using D1 polling
      let lastId = 0;
      const interval = setInterval(async () => {
        const { results } = await env.DB.prepare("SELECT * FROM guestbook WHERE id>? ORDER BY id DESC").bind(lastId).all();
        if (results.length > 0) {
          lastId = results[0].id;
          for (const msg of results.reverse()) { // oldest first inside batch
            writer.write(`data: ${JSON.stringify(msg)}\n\n`);
          }
        }
      }, 1000);
      return new Response(readable, { headers: { "Content-Type":"text/event-stream", ...corsHeaders } });
    }
    return new Response("Not Found", { status: 404 });
  }
}
