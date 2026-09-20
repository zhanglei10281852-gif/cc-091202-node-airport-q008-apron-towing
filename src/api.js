// HTTP 适配层：把命令路由到引擎，错误码映射为状态码。
// 所有写接口都接受可选 commandId（请求体或 X-Command-Id 头）用于客户端幂等。

import { createServer } from "node:http";
import { EngineError } from "./domain/engine.js";

export function buildServer(engine) {
  const server = createServer((request, response) => {
    handle(engine, request, response).catch((error) => {
      if (error instanceof EngineError) return send(response, error.status, { error: error.code, details: error.details });
      console.error(error);
      send(response, 500, { error: "internal", message: error.message });
    });
  });
  return server;
}

async function handle(engine, request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && path === "/health") return send(response, 200, { status: "ok" });
  if (method === "GET" && path === "/permits") return send(response, 200, { permits: engine.listPermits() });
  if (method === "GET" && path === "/calendar") {
    return send(response, 200, {
      calendar: engine.calendarView({
        from: url.searchParams.get("from") ? Date.parse(url.searchParams.get("from")) : undefined,
        to: url.searchParams.get("to") ? Date.parse(url.searchParams.get("to")) : undefined,
      }),
    });
  }
  if (method === "GET" && path === "/network") {
    return send(response, 200, {
      edges: [...engine.network.edges.values()].map((e) => ({
        id: e.id, from: e.from, to: e.to, seconds: e.seconds, zone: e.zone, channel: e.channel,
        maxWingspan: e.maxWingspan,
        aircraftTypes: e.aircraftTypes ? [...e.aircraftTypes] : null,
        closed: engine.network.isClosed(e.id),
      })),
      zones: [...engine.network.zones.values()],
      closures: [...engine.network.closures.entries()].map(([edgeId, v]) => ({ edgeId, ...v, since: new Date(v.since).toISOString() })),
      holdingPoints: [...engine.network.holdingPoints.values()],
    });
  }

  const body = method === "POST" || method === "DELETE" ? await readBody(request) : {};
  const ctx = { by: body.by ?? request.headers["x-controller"] ?? null, commandId: body.commandId ?? request.headers["x-command-id"] ?? null };

  // —— 申请 ——
  if (method === "POST" && path === "/requests") {
    const result = await engine.submit(body, ctx);
    return send(response, 201, result);
  }
  let m;
  if ((m = path.match(/^\/requests\/([^/]+)\/explain$/)) && method === "GET") {
    return send(response, 200, engine.explain(decodeURIComponent(m[1])));
  }
  if ((m = path.match(/^\/requests\/([^/]+)\/approve$/)) && method === "POST") {
    const result = await engine.approve(decodeURIComponent(m[1]), { ...ctx, manual: body.manual ?? null });
    return send(response, 201, result);
  }

  // —— 许可生命周期 ——
  if ((m = path.match(/^\/permits\/([^/]+)\/activate$/)) && method === "POST") {
    return send(response, 200, await engine.activate(decodeURIComponent(m[1]), ctx));
  }
  if ((m = path.match(/^\/permits\/([^/]+)\/position$/)) && method === "POST") {
    return send(response, 200, await engine.reportPosition(decodeURIComponent(m[1]), body, ctx));
  }
  if ((m = path.match(/^\/permits\/([^/]+)\/handoff$/)) && method === "POST") {
    return send(response, 200, await engine.handoff(decodeURIComponent(m[1]), body, ctx));
  }
  if ((m = path.match(/^\/permits\/([^/]+)\/reroute$/)) && method === "POST") {
    return send(response, 200, await engine.reroute(decodeURIComponent(m[1]), { ...ctx, reason: body.reason ?? null, node: body.node ?? null }));
  }
  if ((m = path.match(/^\/permits\/([^/]+)\/cancel$/)) && method === "POST") {
    return send(response, 200, await engine.cancel(decodeURIComponent(m[1]), { ...ctx, reason: body.reason ?? null, node: body.node ?? null }));
  }
  if ((m = path.match(/^\/permits\/([^/]+)\/complete$/)) && method === "POST") {
    return send(response, 200, await engine.complete(decodeURIComponent(m[1]), ctx));
  }
  if ((m = path.match(/^\/permits\/([^/]+)$/)) && method === "GET") {
    return send(response, 200, engine.timeline(decodeURIComponent(m[1])));
  }

  // —— 道路管制 ——
  if (method === "POST" && path === "/admin/closures") {
    return send(response, 200, await engine.closeEdge(body.edgeId, { ...ctx, reason: body.reason ?? null }));
  }
  if (method === "DELETE" && path === "/admin/closures") {
    return send(response, 200, await engine.reopenEdge(body.edgeId, ctx));
  }
  if (method === "POST" && path === "/admin/sweep-expired") {
    return send(response, 200, { expired: await engine.sweepExpired() });
  }

  return send(response, 404, { error: "not_found" });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new EngineError("invalid_json", 400));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, jsonReplacer, 2));
}

function jsonReplacer(key, value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}
