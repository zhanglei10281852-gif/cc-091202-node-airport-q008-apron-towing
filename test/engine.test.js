import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TowingEngine, normalizeRequest } from "../src/model/engine.js";
import { Airport } from "../src/model/airport.js";
import { plan } from "../src/model/planner.js";

const TZ = "+08:00";
const at = (s) => Date.parse(`${s}:00${TZ}`);

async function fixture() {
  const [{ readFile: rf }, path] = [await import("node:fs/promises"), join(tmpdir(), `tow-${Math.random().toString(36).slice(2)}`)];
  const airport = JSON.parse(await rf(new URL("../fixtures/airport.json", import.meta.url), "utf8"));
  const requests = JSON.parse(await rf(new URL("../fixtures/requests.json", import.meta.url), "utf8")).requests;
  return { airport, requests, logPath: join(path, "events.jsonl") };
}

function engine(airport, t, config = {}) {
  let now = t;
  const clock = () => now;
  const e = new TowingEngine({ airport, clock, config: { sweeperIntervalMs: 0, ...config } });
  return {
    e,
    setTime(x) { now = typeof x === "number" ? x : at(x); },
    time() { return now; },
  };
}

test("申请样例与路网均可解析", async () => {
  const { airport, requests } = await fixture();
  assert.ok(airport.edges.length >= 10);
  assert.equal(requests.length, 4);
  const ap = new Airport(airport);
  assert.equal(ap.zoneOf("J1->J4"), "J4");
});

test("机型限制：B777 自动绕行等待坪，窄口边被记录为静态拒绝", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[2]);
  const result = e.explain(requests[2]);
  assert.ok(result.feasible);
  assert.ok(!result.best.edgeIds.includes("J1->J4"));
  assert.deepEqual(result.best.edgeIds, ["S11->J1", "J1->W1", "W1->J5", "J5->J3", "J3->H22"]);
  assert.ok(result.rejectedEdges.some((r) => r.edgeId === "J1->J4"));
});

test("窄口相遇被提前消除：J4 占用区间 + 60 秒安全间隔", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.register(requests[1]);
  const a = await e.approve("tow-88", { actor: "席甲" });
  const b = await e.approve("tow-91", { actor: "席乙" });

  const zone88 = a.permit.plan.steps.filter((s) => s.zoneId === "J4");
  const zone91 = b.permit.plan.steps.filter((s) => s.zoneId === "J4");
  const z88End = zone88.at(-1).exitAt;
  const z91Start = zone91[0].enterAt;
  assert.ok(z91Start >= z88End + 60_000, `间隔 ${(z91Start - z88End) / 1000}s 不足 60s`);
  // tow-91 被安排在起点让行等待
  assert.ok(b.permit.plan.holds.some((h) => h.nodeId === "N8" && h.e - h.s >= 0));
});

test("两席并发审批不会同时看到空闲而双发放行", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  // 同一份申请并发 approve：只有一个真正签发，另一个返回幂等命中。
  const results = await Promise.all([
    e.approve("tow-88", { actor: "席甲" }),
    e.approve("tow-88", { actor: "席乙" }),
    e.approve("tow-88", { actor: "席甲", idempotencyKey: "k1" }),
  ]);
  assert.deepEqual(results.map((r) => r.idempotent), [false, true, true]);
  const live = [...e.permits.values()].filter((p) => p.requestId === "tow-88" && p.status !== "cancelled");
  assert.equal(live.length, 1);
});

test("两条独立申请竞争同一边：后审批者被推迟，路段占用首尾不重叠", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]); // tow-88 S12->H21
  const clone = normalizeRequest({ ...requests[0], requestId: "tow-88b", desiredStart: "2026-09-12T02:10:00+08:00" });
  await e.register(clone);
  const a = await e.approve("tow-88", { actor: "席甲" });
  const b = await e.approve("tow-88b", { actor: "席乙" });
  for (const edgeId of a.permit.plan.edgeIds ?? a.permit.plan.steps.map((s) => s.edgeId)) {
    const sa = a.permit.plan.steps.find((s) => s.edgeId === edgeId);
    const sb = b.permit.plan.steps.find((s) => s.edgeId === edgeId);
    if (sa && sb) assert.ok(sb.enterAt >= sa.exitAt || sa.enterAt >= sb.exitAt, `${edgeId} 占用重叠`);
  }
});

test("资质/车辆状态失效时可批准但不可激活，且失败原因可解释", async () => {
  const { airport, requests } = await fixture();
  const { e, setTime } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[3]); // tow-94 资质 02:15 失效
  const approved = await e.approve("tow-94", { actor: "席甲" });
  assert.equal(approved.permit.status, "approved");
  assert.ok(approved.eligibilityWarnings.length >= 2);
  setTime("2026-09-12T02:30");
  await assert.rejects(e.activate("P-tow-94"), (err) => err.code === "eligibility_failed" && err.details.failures.length >= 2);
  // 许可仍保留，资源仍预留
  assert.equal(e.getPermit("P-tow-94").status, "approved");
});

test("超时未激活自动释放，且释放后资源可被新许可使用；过期操作幂等", async () => {
  const { airport, requests } = await fixture();
  const { e, setTime } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  const a = await e.approve("tow-88", { actor: "席甲" });
  setTime(a.permit.expiryAt + 1000);
  const r1 = await e.expireDue();
  assert.deepEqual(r1.expired, ["P-tow-88"]);
  const r2 = await e.expireDue();
  assert.deepEqual(r2.expired, []);
  assert.equal(e.getPermit("P-tow-88").status, "expired");
  // 日历中无残留占用
  assert.ok(![...e.calendar.edges].some((x) => x.permId === "P-tow-88"));
});

test("取消与完成均幂等；终态间互斥", async () => {
  const { airport, requests } = await fixture();
  const { e, setTime } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.approve("tow-88", { actor: "席甲" });
  const c1 = await e.cancel("P-tow-88", { reason: "机务请假" });
  const c2 = await e.cancel("P-tow-88");
  assert.equal(c1.idempotent, false);
  assert.equal(c2.idempotent, true);
  await assert.rejects(e.complete("P-tow-88"), (err) => err.code === "terminal_state");
});

test("封闭路段：未执行许可出现在影响清单且可无冲突改道（保留原计划记录）", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.approve("tow-88", { actor: "席甲" });
  const { impact } = await e.closeEdge("J1->J4", { reason: "夜间施工", actor: "值班主管" });
  assert.equal(impact.pendingPermits.length, 1);
  assert.equal(impact.pendingPermits[0].permitId, "P-tow-88");
  assert.ok(impact.pendingPermits[0].reroute.feasible);
  const rr = await e.reroute("P-tow-88", { reason: "避开施工段", actor: "席甲" });
  assert.ok(!rr.permit.plan.edgeIds.includes("J1->J4"));
  const replay = e.replay("P-tow-88");
  assert.equal(replay.amendments.length, 1);
  assert.ok(replay.amendments[0].previousRoute.includes("J1->J4"));
  // 改道缺少原因被拒绝（禁止无记录改写）
  await assert.rejects(e.reroute("P-tow-88", {}), (err) => err.code === "bad_request");
});

test("在途拖行遇封闭：给出安全停靠点与改道候选，尾段改道须先在安全点报到", async () => {
  const { airport, requests } = await fixture();
  const { e, setTime } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.closeEdge("J1->J4", { reason: "施工", actor: "主管" });
  await e.closeEdge("W1->J4", { reason: "施工", actor: "主管" });
  const a = await e.approve("tow-88", { actor: "席甲" });
  setTime(a.permit.plan.startAt);
  await e.activate("P-tow-88");
  const w1 = a.permit.plan.steps.find((s) => s.to === "W1");
  setTime(w1.exitAt);
  await e.reportProgress("P-tow-88", { kind: "node", nodeId: "W1", state: "holding" });
  await e.reopenEdge("W1->J4");
  const { impact } = await e.closeEdge("W1->J5", { reason: "漏油清理", actor: "主管" });
  const ai = impact.activePermits[0];
  assert.equal(ai.urgency, "warning");
  assert.deepEqual(ai.safeStops.map((s) => s.nodeId), ["W1"]);
  assert.ok(ai.diversions.some((d) => d.edgeIds[0] === "W1->J4"));
  // 未停靠时 divert 拒绝
  await e.reportProgress("P-tow-88", { kind: "edge", edgeId: "W1->J5" });
  await assert.rejects(e.divert("P-tow-88", { reason: "x" }), (err) => err.code === "not_at_safe_stop");
});

test("无路可走解释：窗口过紧时逐条路径给出阻塞资源", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.approve("tow-88", { actor: "席甲" });
  const tight = normalizeRequest({ ...requests[1], requestId: "tow-tight", latestStart: "2026-09-12T02:12:00+08:00" });
  await e.register(tight);
  await assert.rejects(e.approve("tow-tight", { actor: "席乙" }), (err) => {
    assert.equal(err.code, "no_route");
    assert.ok(err.details.explanation.blockers.length > 0);
    assert.ok(err.details.explanation.evaluated.some((x) => !x.feasible));
    return true;
  });
});

test("人工放行必须签字留痕，并出现在回放时间线中", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.approve("tow-88", { actor: "席甲" });
  const tight = normalizeRequest({ ...requests[1], requestId: "tow-tight2", latestStart: "2026-09-12T02:12:00+08:00" });
  await e.register(tight);
  const p = await e.approve("tow-tight2", { actor: "值班主管", manual: { reason: "现场目视确认 J4 无冲突，人工放行" } });
  assert.equal(p.permit.manual.reason, "现场目视确认 J4 无冲突，人工放行");
  await e.note("P-tow-tight2", { kind: "manual-release", reason: "02:11 目视间隔达标，指令通过", actor: "值班主管" });
  const rp = e.replay("P-tow-tight2");
  assert.ok(rp.timeline.some((x) => x.kind === "approved" && x.manual));
  assert.ok(rp.timeline.some((x) => x.kind === "manual-release"));
});

test("重启重放后资源日历与在途位置一致", async () => {
  const { airport, requests, logPath } = await fixture();
  let now = at("2026-09-12T02:05");
  const e1 = await TowingEngine.create({ airport, logPath, clock: () => now, config: { sweeperIntervalMs: 0 } });
  await e1.register(requests[0], { actor: "席甲" });
  await e1.approve("tow-88", { actor: "席甲" });
  now = at("2026-09-12T02:10");
  await e1.activate("P-tow-88");
  await e1.reportProgress("P-tow-88", { kind: "edge", edgeId: "J1->J4" });
  await e1.closeEdge("N8->J4", { reason: "FOD", actor: "主管" });

  const e2 = await TowingEngine.create({ airport, logPath, clock: () => now, config: { sweeperIntervalMs: 0 } });
  const p = e2.getPermit("P-tow-88");
  assert.equal(p.status, "active");
  assert.deepEqual(p.position, { kind: "edge", edgeId: "J1->J4", enteredAt: null, at: now });
  assert.ok(e2.calendar.edgeClosure("N8->J4", now));
  // 日历占用被完整重建
  assert.ok([...e2.calendar.edges].some((x) => x.permId === "P-tow-88"));
  const snap = e2.snapshot();
  assert.ok(snap.replayedEvents >= 5);
  assert.ok(snap.calendar.closedEdges.includes("N8->J4"));
  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("回放包含计划等待、实际位置、改道理由的完整时间线", async () => {
  const { airport, requests } = await fixture();
  const { e, setTime } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.register(requests[1]);
  await e.approve("tow-88", { actor: "席甲" });
  const b = await e.approve("tow-91", { actor: "席乙" });
  setTime(b.permit.plan.startAt);
  await e.activate("P-tow-91");
  const rp = e.replay("P-tow-91");
  assert.ok(rp.timeline.some((x) => x.kind === "wait-scheduled"));
  assert.ok(rp.timeline.some((x) => x.kind === "traversal-scheduled" && x.zoneId === "J4"));
  assert.ok(rp.timeline.some((x) => x.kind === "activated"));
});

test("封闭影响预览不产生事件", async () => {
  const { airport, requests } = await fixture();
  const { e } = engine(airport, at("2026-09-12T02:05"));
  await e.register(requests[0]);
  await e.approve("tow-88", { actor: "席甲" });
  const before = e.events.length;
  e.closureImpact("J1->J4", { from: at("2026-09-12T03:00"), until: at("2026-09-12T04:00") });
  assert.equal(e.events.length, before);
});
