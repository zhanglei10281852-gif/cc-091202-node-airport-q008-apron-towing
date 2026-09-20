// HTTP 适配层：把引擎命令映射为 REST 接口。
// 所有写操作串行进入引擎锁；并发的两席审批不会同时读到空闲资源。

import { createServer } from "node:http";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("body too large"), { httpStatus: 413, code: "body_too_large" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求体不是合法 JSON"), { httpStatus: 400, code: "bad_json" }); }
}

export function buildRouter(engine, airportData) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:([\w-]+)/g, (_, n) => { names.push(n); return "([^/]+)"; })}$`);
    routes.push({ method, re, names, handler });
  };

  const actorOf = (req, body) => body.actor || req.headers["x-controller-id"] || req.headers["x-actor"] || "anonymous";

  // ---- 申请 ----
  route("POST", "/requests", async (req, body) => {
    const out = await engine.register(body, { actor: actorOf(req, body) });
    return [201, out];
  });
  route("GET", "/requests/:id", async (req, body, params) => [200, engine.getRequest(params.id)]);
  route("POST", "/requests/:id/explain", async (req, body, params) => {
    const request = engine.requests.get(params.id);
    if (!request) throw Object.assign(new Error(`申请不存在: ${params.id}`), { httpStatus: 404, code: "not_found" });
    const result = engine.explain(request, { defaultDwellSeconds: request.destinationDwellSeconds ?? engine.config.defaultDwellSeconds });
    return [200, { summary: engine.summarize(result), plans: result.plans }];
  });
  route("POST", "/requests/:id/approve", async (req, body, params) => {
    const out = await engine.approve(params.id, {
      actor: actorOf(req, body), planIndex: body.planIndex ?? 0,
      manual: body.manual ?? null, idempotencyKey: body.idempotencyKey ?? null,
    });
    return [out.idempotent ? 200 : 201, out];
  });

  // ---- 许可生命周期 ----
  route("GET", "/permits/:id", async (req, body, params) => [200, engine.publicPermit(engine.getPermit(params.id))]);
  route("POST", "/permits/:id/activate", async (req, body, params) =>
    [200, await engine.activate(params.id, { actor: actorOf(req, body), at: body.at ? Date.parse(body.at) : null })]);
  route("POST", "/permits/:id/progress", async (req, body, params) =>
    [200, await engine.reportProgress(params.id, body.position ?? body, { actor: actorOf(req, body) })]);
  route("POST", "/permits/:id/complete", async (req, body, params) =>
    [200, await engine.complete(params.id, { actor: actorOf(req, body), at: body.at ? Date.parse(body.at) : null })]);
  route("POST", "/permits/:id/cancel", async (req, body, params) =>
    [200, await engine.cancel(params.id, { reason: body.reason ?? null, actor: actorOf(req, body) })]);
  route("POST", "/permits/:id/reroute", async (req, body, params) =>
    [200, await engine.reroute(params.id, { planIndex: body.planIndex ?? 0, reason: body.reason, actor: actorOf(req, body) })]);
  route("POST", "/permits/:id/divert", async (req, body, params) =>
    [200, await engine.divert(params.id, { candidateIndex: body.candidateIndex ?? 0, reason: body.reason, actor: actorOf(req, body) })]);
  route("POST", "/permits/:id/notes", async (req, body, params) =>
    [201, await engine.note(params.id, { kind: body.kind ?? "manual-release", reason: body.reason, detail: body.detail ?? null, actor: actorOf(req, body) })]);
  route("GET", "/permits/:id/replay", async (req, body, params) => [200, engine.replay(params.id)]);

  // ---- 封闭与影响 ----
  route("POST", "/expire", async (req, body) => [200, await engine.expireDue(body.at ? Date.parse(body.at) : undefined)]);
  route("POST", "/edges/:id/close", async (req, body, params) =>
    [200, await engine.closeEdge(params.id, { until: body.until ?? null, reason: body.reason ?? "", actor: actorOf(req, body) })]);
  route("POST", "/edges/:id/reopen", async (req, body, params) =>
    [200, await engine.reopenEdge(params.id, { actor: actorOf(req, body) })]);
  route("POST", "/zones/:id/close", async (req, body, params) =>
    [200, await engine.closeZone(params.id, { until: body.until ?? null, reason: body.reason ?? "", actor: actorOf(req, body) })]);
  route("POST", "/zones/:id/reopen", async (req, body, params) =>
    [200, await engine.reopenZone(params.id, { actor: actorOf(req, body) })]);
  route("GET", "/closures/impact", async (req, body, params, query) => {
    if (!query.edgeId) throw Object.assign(new Error("缺少 edgeId 查询参数"), { httpStatus: 400, code: "bad_request" });
    return [200, engine.closureImpact(query.edgeId)];
  });

  // ---- 全局视图 ----
  route("GET", "/snapshot", async () => [200, engine.snapshot()]);
  route("GET", "/airport", async () => [200, {
    id: airportData.id, scenario: airportData.scenario, timezone: airportData.timezone,
    nodes: airportData.nodes, zones: airportData.zones,
    edges: airportData.edges.map((e) => ({ id: e.id ?? `${e.from}->${e.to}`, from: e.from, to: e.to, seconds: e.seconds, aircraftTypes: e.aircraftTypes, conflictZone: e.conflictZone ?? null, notes: e.notes ?? "" })),
  }]);

  return {
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const query = Object.fromEntries(url.searchParams);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(path);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return [r, params, query];
      }
      return null;
    },
    routes,
  };
}

export function buildServer(engine, airportData) {
  const router = buildRouter(engine, airportData);
  return createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
      return json(res, 200, { status: "ok" });
    }
    try {
      const body = await readBody(req);
      const match = await router.handle(req, res);
      if (!match) return json(res, 404, { error: "not_found", path: req.url });
      const [r, params, query] = match;
      const [status, out] = await r.handler(req, body, params, query);
      return json(res, status, out);
    } catch (err) {
      const status = err.httpStatus ?? 500;
      if (status >= 500) console.error(err);
      return json(res, status, { error: err.code ?? "internal", message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
  });
}
