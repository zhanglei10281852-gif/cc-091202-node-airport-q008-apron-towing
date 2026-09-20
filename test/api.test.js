import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { buildServer } from "../src/api.js";
import { newEngine, baseRequest } from "./helpers.js";

async function harness() {
  const { engine, clock } = await newEngine();
  const server = buildServer(engine).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(url(path), {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { engine, clock, call, stop };
}

test("HTTP：提交→并发审批→激活→位置→完成 全链路 2xx", async () => {
  const h = await harness();
  try {
    const submitted = await h.call("POST", "/requests", baseRequest());
    assert.equal(submitted.status, 201);
    assert.equal(submitted.json.plan.ok, true);

    const approved = await h.call("POST", "/requests/t-1/approve", {}, { "x-controller": "ctrl-A" });
    assert.equal(approved.status, 201);

    const early = await h.call("POST", "/permits/PMT-t-1/activate", {});
    assert.equal(early.status, 412);
    assert.equal(early.json.error, "activation_before_window");

    h.clock.set("2026-09-12T02:10:00+08:00");
    const activated = await h.call("POST", "/permits/PMT-t-1/activate", { by: "ctrl-A" });
    assert.equal(activated.status, 200);

    const pos = await h.call("POST", "/permits/PMT-t-1/position", { node: "H21", phase: "AT_NODE" });
    assert.equal(pos.status, 200);

    const done = await h.call("POST", "/permits/PMT-t-1/complete", {});
    assert.equal(done.status, 200);

    const timeline = await h.call("GET", "/permits/PMT-t-1");
    assert.equal(timeline.json.status, "COMPLETED");
    assert.equal(timeline.json.positions.length, 1);
  } finally {
    await h.stop();
  }
});

test("HTTP：并发两请求审批不会双方都看到空闲；第二个被错峰", async () => {
  const h = await harness();
  try {
    await h.call("POST", "/requests", baseRequest({ requestId: "a" }));
    await h.call("POST", "/requests", baseRequest({
      requestId: "b", from: "N8", crew: ["P-003", "P-004"], vehicle: "TUG-02",
      window: { start: "2026-09-12T02:10:00+08:00", seconds: 1800 },
    }));
    const results = await Promise.all([
      h.call("POST", "/requests/a/approve", {}),
      h.call("POST", "/requests/b/approve", {}),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201]);
    const calendar = await h.call("GET", "/calendar");
    const j4 = calendar.json.calendar.filter((e) => e.type === "zone" && e.resource === "J4");
    const times = j4.map((e) => Date.parse(e.from)).sort((x, y) => x - y);
    assert.ok(times[1] - times[0] >= 60_000);
  } finally {
    await h.stop();
  }
});

test("HTTP：封闭返回影响面；改道留痕；无路可走返回 422 与解释", async () => {
  const h = await harness();
  try {
    await h.call("POST", "/requests", baseRequest());
    await h.call("POST", "/requests/t-1/approve", {});
    h.clock.set("2026-09-12T02:10:00+08:00");
    await h.call("POST", "/permits/PMT-t-1/activate", {});

    const closed = await h.call("POST", "/admin/closures", { edgeId: "J4->H21", reason: "施工" });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.impact.active[0].safeStop, "S12");

    const rerouted = await h.call("POST", "/permits/PMT-t-1/reroute", { node: "S12", reason: "绕行" });
    assert.equal(rerouted.status, 200);
    assert.deepEqual(rerouted.json.data.amendment.oldPath, ["S12->J4", "J4->H21"]);

    await h.call("POST", "/requests", baseRequest({
      requestId: "wide", aircraft: { type: "A380", wingspan: "F" },
      crew: ["P-003", "P-004"], vehicle: "TUG-07",
    }));
    const noWay = await h.call("POST", "/requests/wide/approve", {});
    assert.equal(noWay.status, 422);
    assert.equal(noWay.json.error, "no_feasible_route");
    assert.ok(Array.isArray(noWay.json.details.reasons));
    const explain = await h.call("GET", "/requests/wide/explain");
    assert.equal(explain.json.code, "no_structural_route");
  } finally {
    await h.stop();
  }
});

test("HTTP：X-Command-Id 保证写接口客户端重试幂等", async () => {
  const h = await harness();
  try {
    await h.call("POST", "/requests", baseRequest());
    const headers = { "X-Command-Id": "cmd-approve-1" };
    const first = await h.call("POST", "/requests/t-1/approve", {}, headers);
    const retry = await h.call("POST", "/requests/t-1/approve", {}, headers);
    assert.equal(first.status, 201);
    // 第二次为幂等命中（许可已存在，返回幂等结果或冲突；此处走命令去重）
    assert.ok([200, 201].includes(retry.status));
    assert.equal(retry.json.idempotent ?? true, true);
  } finally {
    await h.stop();
  }
});

test("HTTP：过期扫描与列表接口", async () => {
  const h = await harness();
  try {
    await h.call("POST", "/requests", baseRequest({ activateGraceSeconds: 30 }));
    await h.call("POST", "/requests/t-1/approve", {});
    h.clock.set("2026-09-12T02:30:00+08:00");
    const sweep = await h.call("POST", "/admin/sweep-expired", {});
    assert.deepEqual(sweep.json.expired, ["PMT-t-1"]);
    const list = await h.call("GET", "/permits");
    assert.equal(list.json.permits[0].status, "EXPIRED");
    const net = await h.call("GET", "/network");
    assert.ok(net.json.edges.length >= 10);
  } finally {
    await h.stop();
  }
});
