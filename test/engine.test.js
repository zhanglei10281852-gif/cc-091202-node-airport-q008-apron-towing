import assert from "node:assert/strict";
import test from "node:test";
import { newEngine, baseRequest, EngineError } from "./helpers.js";

const MIN = 60_000;
const parse = (s) => Date.parse(s);
const rejects = async (p, code) => {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError got ${error}`);
    if (code) assert.equal(error.code, code);
    return error;
  }
  throw new assert.AssertionError({ message: `expected rejection ${code ?? ""}` });
};

test("窄口物理通道：共线反向 TW-A 两班时间窗自动错开，通道占用不重叠", async () => {
  const { engine } = await newEngine();
  await engine.closeEdge("J2->D1", { reason: "test" }); // 迫使南线进入 TW-A
  await engine.submit(baseRequest({
    requestId: "a", from: "HP-SOUTH", to: "H21",
    window: { start: "2026-09-12T02:10:00+08:00", seconds: 1800 },
  }));
  await engine.submit(baseRequest({
    requestId: "b", from: "H21", to: "HP-NORTH",
    window: { start: "2026-09-12T02:10:00+08:00", seconds: 1800 },
  }));
  await engine.approve("a");
  await engine.approve("b");
  const intervals = engine.calendar
    .window("channel", "TW-A", 0, Number.MAX_SAFE_INTEGER)
    .map((e) => [e.start, e.end, e.permitId]);
  assert.equal(intervals.length, 2);
  intervals.sort((x, y) => x[0] - y[0]);
  assert.ok(intervals[0][1] <= intervals[1][0], "TW-A 两班占用必须首尾不相叠");
  assert.notEqual(intervals[0][2], intervals[1][2]);
});

test("交叉区安全间隔：两班进入 J4 的时刻相差不少于 60 秒", async () => {
  const { engine } = await newEngine();
  await engine.submit(baseRequest({ requestId: "a", from: "S12" }));
  await engine.submit(baseRequest({
    requestId: "b", from: "N8", crew: ["P-003", "P-004"], vehicle: "TUG-02",
    window: { start: "2026-09-12T02:10:00+08:00", seconds: 1800 },
  }));
  await engine.approve("a");
  await engine.approve("b");
  const enters = engine.calendar
    .window("zone", "J4", 0, Number.MAX_SAFE_INTEGER)
    .map((e) => e.start)
    .sort((x, y) => x - y);
  assert.equal(enters.length, 2);
  assert.ok(enters[1] - enters[0] >= 60_000, `J4 进入间隔 ${enters[1] - enters[0]}ms < 60s`);
});

test("机型/翼展限制：A380 无机库通路，规划给出结构化原因", async () => {
  const { engine } = await newEngine();
  const result = await engine.submit(baseRequest({
    requestId: "f", aircraft: { id: "X", type: "A380", wingspan: "F" },
    crew: ["P-003", "P-004"], vehicle: "TUG-07",
  }));
  assert.equal(result.plan.ok, false);
  assert.equal(result.plan.code, "no_structural_route");
  assert.ok(result.plan.reasons.some((r) => r.constraint.startsWith("wingspan_exceeded")));
  await rejects(engine.approve("f"), "no_feasible_route");
});

test("窗口过短：时序不可行时返回按约束聚合的无路解释", async () => {
  const { engine } = await newEngine();
  await engine.submit(baseRequest({ requestId: "a" }));
  await engine.approve("a");
  await engine.submit(baseRequest({
    requestId: "late",
    window: { start: "2026-09-12T02:10:00+08:00", seconds: 120 },
  }));
  const error = await rejects(engine.approve("late"), "no_feasible_route");
  assert.ok(error.details.attempts.length > 0);
  assert.ok(error.details.reasons.some((r) => r.constraint.includes("PMT-a") || r.constraint === "window_exceeded"));
});

test("两席并发审批串行化：后审批者必然看到先审批者的预留", async () => {
  const { engine } = await newEngine();
  await engine.submit(baseRequest({ requestId: "a" }));
  await engine.submit(baseRequest({
    requestId: "b", from: "N8", crew: ["P-003", "P-004"], vehicle: "TUG-02",
    window: { start: "2026-09-12T02:10:00+08:00", seconds: 1800 },
  }));
  await Promise.all([engine.approve("a"), engine.approve("b")]);
  const pa = engine.permits.get("PMT-a");
  const pb = engine.permits.get("PMT-b");
  assert.ok(pa.legs[0].enter <= pb.legs[0].enter);
  // 两班对 S12/N8->J4 共用 J4 交叉区，进入时刻必须被拉开
  const zoneA = pa.legs.find((l) => l.zone === "J4").enter;
  const zoneB = pb.legs.find((l) => l.zone === "J4").enter;
  assert.ok(Math.abs(zoneA - zoneB) >= 60_000);
});

test("命令幂等：重复 activate/cancel/complete/expire 不产生第二事件或重复预留", async () => {
  const { engine, clock, store } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  const e1 = await engine.activate("PMT-t-1");
  const e2 = await engine.activate("PMT-t-1");
  assert.equal(e2.idempotent, true);
  assert.equal(e1.eventId !== undefined, true);
  const cancel1 = await engine.cancel("PMT-t-1", { node: "S12", reason: "x" });
  const cancel2 = await engine.cancel("PMT-t-1", { node: "S12", reason: "x" });
  assert.equal(cancel2.idempotent, true);
  assert.notEqual(cancel1.eventId, undefined);
  const cancelledEvents = store.events.filter((e) => e.type === "PERMIT_CANCELLED");
  assert.equal(cancelledEvents.length, 1);
  assert.equal(engine.calendar.all().length, 0);
});

test("资质/车辆状态出发时失效：拒绝激活，许可不释放日历，待管制处理", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest({
    crew: ["P-009", "P-002"], vehicle: "TUG-09",
    window: { start: "2026-09-12T03:10:00+08:00", seconds: 900 },
    activateGraceSeconds: 300,
  }));
  await engine.approve("t-1");
  clock.set("2026-09-12T03:10:30+08:00");
  const error = await rejects(engine.activate("PMT-t-1"), "credentials_invalid_at_departure");
  const kinds = error.details.failures.map((f) => f.kind);
  assert.ok(kinds.includes("crew_cert_expired"));
  assert.ok(kinds.includes("vehicle_unserviceable"));
  assert.equal(engine.permits.get("PMT-t-1").status, "ISSUED");
});

test("超时未激活：扫描自动释放并清空预留，重复扫描幂等", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest({ activateGraceSeconds: 60 }));
  await engine.approve("t-1");
  const before = engine.calendar.all().length;
  assert.ok(before > 0);
  clock.set(parse("2026-09-12T02:10:00+08:00") + 61 * MIN);
  const first = await engine.sweepExpired();
  assert.deepEqual(first, ["PMT-t-1"]);
  assert.deepEqual(await engine.sweepExpired(), []);
  assert.equal(engine.permits.get("PMT-t-1").status, "EXPIRED");
  assert.equal(engine.calendar.all().length, 0);
});

test("封闭路段：列出受影响待执行/在途许可，在途给出安全停靠点与改道候选", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-t-1");
  const impact = (await engine.closeEdge("J4->H21", { reason: "施工" })).impact;
  assert.equal(impact.active.length, 1);
  assert.equal(impact.active[0].safeStop, "S12");
  assert.equal(impact.active[0].rerouteCandidates.ok, true);
  assert.ok(impact.active[0].rerouteCandidates.path.includes("J4->D1"));
  assert.ok(!impact.active[0].rerouteCandidates.path.includes("J4->H21"));
});

test("已进入封闭边时提示继续驶离；未到安全停靠点不得改道", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:11:40+08:00");
  await engine.activate("PMT-t-1");
  await engine.reportPosition("PMT-t-1", { edgeId: "J4->H21", phase: "ENTERING_EDGE" });
  const impact = await engine.closeEdge("J4->H21", { reason: "施工" });
  const active = impact.impact.active[0];
  assert.equal(active.onEdge, true);
  assert.equal(active.safeStop, null);
  assert.equal(active.advice, "edge_already_entered_continue_to_clear");
  await rejects(engine.reroute("PMT-t-1", { node: "J4" }), "reroute_requires_safe_stop");
});

test("改道必须留痕：原路线完整保留于修订链，日历随之替换", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-t-1");
  await engine.closeEdge("J4->H21", { reason: "施工" });
  const result = await engine.reroute("PMT-t-1", { node: "S12", reason: "绕行 D1", by: "席A" });
  assert.deepEqual(result.data.amendment.oldPath, ["S12->J4", "J4->H21"]);
  assert.ok(result.data.amendment.newPath.includes("J4->D1"));
  assert.ok(!result.data.amendment.newPath.includes("J4->H21"));
  const timeline = engine.timeline("PMT-t-1");
  assert.deepEqual(timeline.originalRoute.path, ["S12->J4", "J4->H21"]);
  assert.deepEqual(timeline.amendments[0].oldPath, ["S12->J4", "J4->H21"]);
  // 日历中不再有旧航段，改为绕行航段
  assert.equal(engine.calendar.window("edge", "J4->H21", 0, Number.MAX_SAFE_INTEGER).length, 0);
  assert.ok(engine.calendar.window("edge", "J4->D1", 0, Number.MAX_SAFE_INTEGER).length >= 1);
});

test("交接只允许在标注/终点交接节点，并记录首尾两组", async () => {
  const { engine, clock } = await newEngine();
  // 封闭 S12 直插线，迫使 S12->D1 走南段联络道并经过交接点 HP-SOUTH
  await engine.closeEdge("S12->J4", { reason: "test" });
  await engine.submit(baseRequest({ requestId: "t-1", to: "D1" }));
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-t-1");
  await engine.reportPosition("PMT-t-1", { node: "J1", phase: "AT_NODE" });
  await rejects(engine.handoff("PMT-t-1", { toTeam: "乙组", node: "J1" }), "node_not_handoff");
  await engine.reportPosition("PMT-t-1", { node: "HP-SOUTH", phase: "AT_NODE" });
  // 申报的交接节点与实际位置不符（D1 虽可交接，但人不在那里）
  await rejects(
    engine.handoff("PMT-t-1", { toTeam: "乙组", node: "D1" }),
    "handoff_position_mismatch",
  );
  const result = await engine.handoff("PMT-t-1", { fromTeam: "甲组", toTeam: "乙组", reason: "换班" });
  assert.equal(result.data.toTeam, "乙组");
  assert.deepEqual(engine.timeline("PMT-t-1").handoffs[0].node, "HP-SOUTH");
});

test("人工放行：必须逐条签收冲突并写明理由，记录进入许可审计", async () => {
  const { engine } = await newEngine();
  await engine.submit(baseRequest({ requestId: "a" }));
  await engine.approve("a");
  // 4 分钟窗口：自由流可通过，但避让 a 必然超时——只能人工放行
  await engine.submit(baseRequest({ requestId: "m", window: { start: "2026-09-12T02:10:00+08:00", seconds: 240 } }));
  await rejects(
    engine.approve("m", { manual: { reason: "急救优先", acknowledge: [] } }),
    "manual_acknowledgement_required",
  );
  const need = new Set();
  for (let i = 0; i < 12; i += 1) {
    try {
      await engine.approve("m", { manual: { reason: "急救优先", by: "席A", acknowledge: [...need] } });
      break;
    } catch (error) {
      if (error.code !== "manual_acknowledgement_required") throw error;
      if (need.has(error.details.need)) throw error;
      need.add(error.details.need);
    }
  }
  const permit = engine.permits.get("PMT-m");
  assert.ok(permit.manualReleases.length >= 2);
  assert.ok(permit.manualReleases.every((r) => r.reason === "急救优先" && r.by === "席A"));
  // 无理由的人工放行一律拒绝
  await engine.submit(baseRequest({ requestId: "m2", window: { start: "2026-09-12T02:10:00+08:00", seconds: 240 } }));
  await rejects(engine.approve("m2", { manual: { acknowledge: [...need] } }), "manual_reason_required");
});

test("重启重放：日历、封闭、在途位置与修订链全部一致", async () => {
  const { engine, clock, store } = await newEngine();
  await engine.submit(baseRequest({ requestId: "a" }));
  await engine.submit(baseRequest({ requestId: "b", from: "N8", crew: ["P-003", "P-004"], vehicle: "TUG-02" }));
  await engine.approve("a");
  await engine.approve("b");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-a");
  await engine.closeEdge("J4->H21", { reason: "施工", by: "席A" });
  await engine.reroute("PMT-a", { node: "S12", reason: "绕行" });
  await engine.reportPosition("PMT-a", { node: "J4", phase: "AT_NODE" });

  const { engine: rebuilt } = await newEngine({ events: store.events, start: "2026-09-12T02:10:00+08:00" });
  assert.deepEqual(JSON.parse(JSON.stringify(engine.calendarView())), JSON.parse(JSON.stringify(rebuilt.calendarView())));
  const t1 = engine.timeline("PMT-a");
  const t2 = rebuilt.timeline("PMT-a");
  assert.deepEqual(t2.positions, t1.positions);
  assert.deepEqual(t2.route, t1.route);
  assert.deepEqual(t2.amendments, t1.amendments);
  assert.deepEqual([...rebuilt.network.closures.keys()], ["J4->H21"]);
  assert.equal(rebuilt.permits.get("PMT-b").status, "ISSUED");
});

test("封闭后激活被拒，未激活许可可自起节点改道（留痕）后激活", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.closeEdge("J4->H21", { reason: "施工" });
  await rejects(engine.activate("PMT-t-1"), "route_blocked_by_closure");
  const rerouted = await engine.reroute("PMT-t-1", { node: "S12", reason: "封闭改道", by: "席A" });
  assert.ok(rerouted.data.amendment.newPath.includes("J4->D1"));
  await engine.activate("PMT-t-1");
  assert.equal(engine.permits.get("PMT-t-1").status, "ACTIVE");
});

test("位置回报必须在当前执行路线上", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-t-1");
  await rejects(engine.reportPosition("PMT-t-1", { node: "N8", phase: "AT_NODE" }), "position_off_route");
});

test("完成必须在终点；在途取消必须在安全停靠点", async () => {
  const { engine, clock } = await newEngine();
  await engine.submit(baseRequest());
  await engine.approve("t-1");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-t-1");
  await rejects(engine.complete("PMT-t-1"), "complete_position_mismatch");
  await rejects(engine.cancel("PMT-t-1", { node: "J4" }), "cancel_requires_safe_stop");
  await engine.reportPosition("PMT-t-1", { node: "H21", phase: "AT_NODE" });
  await engine.complete("PMT-t-1");
  assert.equal(engine.permits.get("PMT-t-1").status, "COMPLETED");
});
