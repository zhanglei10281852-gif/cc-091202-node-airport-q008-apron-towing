import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { buildApp } from "../src/server.js";

async function startServer(logPath = null) {
  const airportPath = new URL("../fixtures/airport.json", import.meta.url);
  let now = Date.parse("2026-09-12T02:05:00+08:00");
  const { server, engine } = await buildApp({ logPath, airportPath, clock: () => now, config: { sweeperIntervalMs: 0 } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const requests = JSON.parse(await readFile(new URL("../fixtures/requests.json", import.meta.url), "utf8")).requests;
  return {
    server, engine, base, requests,
    setTime: (x) => { now = typeof x === "number" ? x : Date.parse(x); },
    stop: () => server.close(),
  };
}

const call = async (base, method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json", "x-controller-id": "ctrl-A" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

test("端到端：登记 → 解释 → 审批 → 激活 → 位置上报 → 完成", async (t) => {
  const h = await startServer();
  t.after(h.stop);

  const reg = await call(h.base, "POST", "/requests", h.requests[0]);
  assert.equal(reg.status, 201);

  const explain = await call(h.base, "POST", "/requests/tow-88/explain", {});
  assert.equal(explain.status, 200);
  assert.equal(explain.json.summary.feasible, true);

  const appr = await call(h.base, "POST", "/requests/tow-88/approve", {});
  assert.equal(appr.status, 201);
  assert.equal(appr.json.permit.status, "approved");

  h.setTime("2026-09-12T02:10:00+08:00");
  const act = await call(h.base, "POST", "/permits/P-tow-88/activate", {});
  assert.equal(act.json.status, "active");
  // 重复激活幂等
  const act2 = await call(h.base, "POST", "/permits/P-tow-88/activate", {});
  assert.equal(act2.status, 200);
  assert.equal(act2.json.idempotent, true);

  const prog = await call(h.base, "POST", "/permits/P-tow-88/progress", { position: { kind: "node", nodeId: "W1", state: "holding" } });
  assert.equal(prog.status, 200);

  const done = await call(h.base, "POST", "/permits/P-tow-88/complete", {});
  assert.equal(done.json.status, "completed");
  const done2 = await call(h.base, "POST", "/permits/P-tow-88/complete", {});
  assert.equal(done2.json.idempotent, true);
});

test("两席经 HTTP 并发审批同一申请：只有一份许可", async (t) => {
  const h = await startServer();
  t.after(h.stop);
  await call(h.base, "POST", "/requests", h.requests[0]);
  const results = await Promise.all([
    call(h.base, "POST", "/requests/tow-88/approve", {}),
    call(h.base, "POST", "/requests/tow-88/approve", {}),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  const snap = await call(h.base, "GET", "/snapshot");
  const live = snap.json.permits.filter((p) => p.requestId === "tow-88" && p.status === "approved");
  assert.equal(live.length, 1);
});

test("无解时 409 返回逐路径阻塞解释", async (t) => {
  const h = await startServer();
  t.after(h.stop);
  await call(h.base, "POST", "/requests", h.requests[0]);
  await call(h.base, "POST", "/requests/tow-88/approve", {});
  const tight = { ...h.requests[1], requestId: "tight", latestStart: "2026-09-12T02:12:00+08:00" };
  await call(h.base, "POST", "/requests", tight);
  const r = await call(h.base, "POST", "/requests/tight/approve", {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "no_route");
  assert.ok(r.json.details.explanation.blockers.length > 0);
});

test("封闭接口返回受影响许可；回放接口展示完整时间线", async (t) => {
  const h = await startServer();
  t.after(h.stop);
  await call(h.base, "POST", "/requests", h.requests[0]);
  await call(h.base, "POST", "/requests/tow-88/approve", {});
  const closed = await call(h.base, "POST", "/edges/J1->J4/close", { reason: "施工" });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.impact.pendingPermits[0].permitId, "P-tow-88");

  const replay = await call(h.base, "GET", "/permits/P-tow-88/replay");
  assert.equal(replay.status, 200);
  assert.ok(replay.json.timeline.some((x) => x.kind === "traversal-scheduled"));

  const bad = await call(h.base, "POST", "/permits/P-tow-88/reroute", {});
  assert.equal(bad.status, 400); // 缺少原因，禁止无记录改写
});

test("非法 JSON 与未知路由有明确错误码", async (t) => {
  const h = await startServer();
  t.after(h.stop);
  const res = await fetch(h.base + "/requests", { method: "POST", headers: { "content-type": "application/json" }, body: "{not-json" });
  assert.equal(res.status, 400);
  const nf = await call(h.base, "GET", "/nope");
  assert.equal(nf.status, 404);
});
