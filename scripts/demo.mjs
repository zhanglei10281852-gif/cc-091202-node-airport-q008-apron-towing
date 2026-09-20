// 端到端演示：夜间集中拖机全流程。
//   node scripts/demo.mjs
//
// 覆盖：申请解释、并发审批、人工放行留痕、机型限制、资质激活拦截、
//       超时自动释放、封闭影响、安全停靠与改道、位置回报、首尾交接、
//       取消/完成幂等、时间线回放、重启一致性。

import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Network } from "../src/domain/network.js";
import { CredentialRegistry } from "../src/domain/credentials.js";
import { TowingEngine, EngineError } from "../src/domain/engine.js";
import { FileEventStore } from "../src/domain/store.js";
import { FakeClock, toIso } from "../src/domain/time.js";

const section = (title) => console.log(`\n=== ${title} ===`);
const ok = (label, value) => console.log(`✔ ${label}${value === undefined ? "" : `：${value}`}`);
const fail = (label, err) => console.log(`✘ ${label}：${err.code}`);

async function main() {
  const base = new URL("../", import.meta.url);
  const logPath = fileURLToPath(new URL("data/demo-events.jsonl", base));
  rmSync(logPath, { force: true });
  const load = async (p) => JSON.parse(await readFile(fileURLToPath(new URL(p, base)), "utf8"));
  const [networkData, credentialData, requestData] = await Promise.all([
    load("fixtures/airport-network.json"),
    load("fixtures/credentials.json"),
    load("fixtures/requests.json"),
  ]);

  const clock = new FakeClock("2026-09-12T02:05:00+08:00");
  const engine = new TowingEngine({
    network: new Network(networkData),
    credentials: CredentialRegistry.from(credentialData),
    store: new FileEventStore(logPath),
    clock,
  });
  await engine.load();

  section("1. 提交四班申请（提交即给出只读预规划：路线、发车/到达、沿途等待）");
  for (const request of requestData.requests) {
    const result = await engine.submit(request);
    const p = result.plan;
    console.log(
      `  ${request.requestId} ${request.aircraft.type} ${request.from}→${request.to} =>`,
      p.ok
        ? `${p.path.join(" / ")}；发车 ${toIso(p.departure)}，到达 ${toIso(p.arrival)}，等待 ${Math.round(p.waitMs / 1000)}s`
        : `无路（${p.code}）${p.reasons[0] ? `，首要约束 ${p.reasons[0].constraint}` : ""}`,
    );
  }

  section("2. 两席并发审批：101 先占窄口，102 被自动错峰；加开的 105 窗口仅 4 分钟，无路可走");
  await Promise.all([
    engine.approve("tow-101", { by: "席A" }),
    engine.submit({
      requestId: "tow-105",
      aircraft: { id: "B-9005", type: "A320", wingspan: "C" },
      crew: ["P-001", "P-002"], vehicle: "TUG-02",
      from: "S12", to: "H21",
      window: { start: "2026-09-12T02:10:00+08:00", seconds: 240 },
      intersectionSeparationSeconds: 60,
      notes: "加开班次，窗口仅 4 分钟",
    }),
  ]);
  const raced = await Promise.allSettled([
    engine.approve("tow-102", { by: "席B" }),
    engine.approve("tow-105", { by: "席A" }),
  ]);
  const p102 = must(engine, "tow-102");
  console.log(`  tow-102 => ${p102.path.join(" / ")}（窄口被 101 占用，自动延后发车）`);
  for (const leg of p102.legs) {
    console.log(`    ${leg.edgeId}  进入 ${toIso(leg.enter)} → 离开 ${toIso(leg.exit)}，段前等待 ${Math.round(leg.waitedMsBefore / 1000)}s`);
  }
  const rejected105 = raced.find((r) => r.status === "rejected").reason;
  fail("tow-105 并发下被拒", rejected105);
  console.log("    无路解释（按波及路径数排序）：");
  for (const reason of rejected105.details.reasons.slice(0, 3)) {
    console.log(`      - ${reason.constraint}（卡于 ${reason.failedEdge ?? reason.reached}，波及 ${reason.affectedPaths} 条路径）`);
  }

  section("3. 人工放行：管制员为急救航班 105 签收每一处冲突并写明理由（逐条留痕，不允许无痕覆盖）");
  const acknowledge = [];
  for (let i = 0; i < 12; i += 1) {
    try {
      await engine.approve("tow-105", {
        by: "席A",
        manual: { reason: "急救器材航班优先，现场已引导对向停车", by: "席A", acknowledge: [...acknowledge] },
      });
      break;
    } catch (error) {
      if (error.code !== "manual_acknowledgement_required") throw error;
      if (acknowledge.includes(error.details.need)) throw error;
      acknowledge.push(error.details.need);
    }
  }
  const p105 = must(engine, "tow-105");
  ok("人工放行许可已发", p105.permitId);
  for (const r of p105.manualReleases.slice(0, 4)) {
    console.log(`    - ${r.resource}:${r.resourceId} 与 ${r.againstPermit} 冲突；理由“${r.reason}”；签收人 ${r.by}`);
  }

  section("4. 机型通行限制：宽体机 tow-201 必须绕开 C 类窄岔 S13->J1 与限宽 D 的 TW-A(J2->J4)");
  await engine.approve("tow-201", { by: "席A" });
  ok("tow-201 路线", must(engine, "tow-201").path.join(" / "));

  section("5. 反面样例 tow-404：路线本身可批，先发证；激活时再校验资质");
  await engine.approve("tow-404", { by: "席B" });
  ok("tow-404 已发证（待激活）");

  section("6. 出发时刻校验：02:10 激活 tow-101（机组当班、证件与车辆有效）");
  clock.set("2026-09-12T02:10:00+08:00");
  await engine.activate("PMT-tow-101", { by: "席A" });
  const again = await engine.activate("PMT-tow-101", { by: "席A" });
  ok("重复激活幂等", `status=${again.status}`);
  clock.set("2026-09-12T02:12:20+08:00");
  await engine.activate("PMT-tow-102", { by: "席B" });
  ok("tow-102 已激活");

  section("7. 02:10:20 封闭 J4->H21（机库门口施工）：查看受影响许可与在途处置建议");
  clock.set("2026-09-12T02:10:20+08:00");
  const closure = await engine.closeEdge("J4->H21", { by: "席A", reason: "机库门口施工" });
  console.log(`  待执行许可（须重排）：${closure.impact.pending.map((p) => `${p.permitId}@leg#${p.blockedLegIndex}`).join(", ") || "无"}`);
  for (const a of closure.impact.active) {
    console.log(`  在途 ${a.permitId}：${a.advice}；安全停靠点 ${a.safeStop}`);
    console.log(`    改道候选：${a.rerouteCandidates.ok ? a.rerouteCandidates.path.join(" / ") : JSON.stringify(a.rerouteCandidates.reasons?.[0] ?? a.rerouteCandidates)}`);
  }

  section("8. tow-101 退回起节点改道：原路线整段保留于修订链，禁止无记录改写");
  const rerouted = await engine.reroute("PMT-tow-101", { by: "席A", node: "S12", reason: "绕行南段联络道经 D1 进机库" });
  const amendment = rerouted.data.amendment;
  ok("改道后路线", amendment.newPath.join(" / "));
  ok("原路线仍在案", amendment.oldPath.join(" / "));

  section("9. 实际经过回报：J1 → HP-SOUTH，并在交接点完成首尾相接换组");
  clock.set("2026-09-12T02:12:00+08:00");
  await engine.reportPosition("PMT-tow-101", { node: "J1", phase: "AT_NODE", note: "通过 J1" });
  clock.set("2026-09-12T02:13:30+08:00");
  await engine.reportPosition("PMT-tow-101", { node: "HP-SOUTH", phase: "AT_NODE", note: "到达南段交接点" });
  await engine.handoff("PMT-tow-101", { fromTeam: "牵引甲组", toTeam: "牵引乙组", reason: "南段司机换班", by: "席A" });
  ok("HP-SOUTH 交接完成", "甲组 → 乙组");

  section("10. tow-101 到达完成（重复完成幂等）；tow-102 奉令在 N8 等待；tow-105 取消");
  clock.set("2026-09-12T02:18:30+08:00");
  await engine.reportPosition("PMT-tow-101", { node: "H21", phase: "AT_NODE" });
  await engine.complete("PMT-tow-101", { by: "席A" });
  ok("重复完成幂等", `status=${(await engine.complete("PMT-tow-101", { by: "席A" })).status}`);
  await engine.reportPosition("PMT-tow-102", { node: "N8", phase: "HOLDING", note: "奉令在起节点等待施工结束" });
  ok("tow-102 在 N8 保持在途等待");
  await engine.cancel("PMT-tow-105", { by: "席A", reason: "急救任务取消" });
  ok("未激活许可取消，重复取消幂等", `status=${(await engine.cancel("PMT-tow-105", { by: "席A" })).status}`);
  try {
    await engine.reportPosition("PMT-tow-105", { node: "J4", phase: "AT_NODE" });
  } catch (error) {
    fail("终态许可拒绝新位置回报", error);
  }

  section("11. 重启一致性（此刻日历非空、封闭仍在、tow-102 在途）：新实例从事件日志重建");
  const rebuilt = new TowingEngine({
    network: new Network(networkData),
    credentials: CredentialRegistry.from(credentialData),
    store: new FileEventStore(logPath),
    clock,
  });
  await rebuilt.load();
  const a = engine.calendarView();
  const b = rebuilt.calendarView();
  ok("资源日历一致", `live=${a.length} 条，rebuilt=${b.length} 条，内容相等=${JSON.stringify(a) === JSON.stringify(b)}`);
  const t2 = rebuilt.timeline("PMT-tow-102");
  ok("在途许可重建", `status=${t2.status}，最后位置=${t2.positions.at(-1).node}/${t2.positions.at(-1).phase}`);
  ok("封闭状态重建", JSON.stringify([...rebuilt.network.closures.keys()]));
  const t1 = engine.timeline("PMT-tow-101");
  const t1b = rebuilt.timeline("PMT-tow-101");
  ok("已完成许可时间线全量相等", JSON.stringify(t1) === JSON.stringify(t1b));

  section("12. 施工结束解封，宽体班 tow-201 在发车窗口内激活并完成；tow-102 在安全点取消");
  clock.set("2026-09-12T02:25:00+08:00");
  await engine.reopenEdge("J4->H21", { by: "席A" });
  clock.set("2026-09-12T02:29:30+08:00");
  await engine.activate("PMT-tow-201", { by: "席A" });
  clock.set("2026-09-12T02:38:30+08:00");
  await engine.reportPosition("PMT-tow-201", { node: "H21", phase: "AT_NODE" });
  await engine.complete("PMT-tow-201", { by: "席A" });
  ok("tow-201 完成");
  await engine.cancel("PMT-tow-102", { by: "席B", node: "N8", reason: "施工超时，本班取消" });
  ok("在途许可安全点取消幂等", `status=${(await engine.cancel("PMT-tow-102", { by: "席B", node: "N8" })).status}`);

  section("13. tow-404：03:10:30 激活被拒（驾驶员证 01:00 到期、9 号车故障未放行）");
  clock.set("2026-09-12T03:10:30+08:00");
  try {
    await engine.activate("PMT-tow-404", { by: "席B" });
  } catch (error) {
    fail("激活 tow-404", error);
    for (const f of error.details.failures) console.log(`      - ${JSON.stringify(f)}`);
  }

  section("14. 超时未激活自动释放（grace 300s，推进到 03:16），重复扫描幂等");
  clock.set("2026-09-12T03:16:00+08:00");
  ok("本次过期释放", (await engine.sweepExpired()).join(", "));
  ok("再次扫描无释放", JSON.stringify(await engine.sweepExpired()));

  section("15. 回放 tow-101：计划路线、实际经过、等待、交接与改道理由");
  const timeline = engine.timeline("PMT-tow-101");
  console.log(JSON.stringify({
    status: timeline.status,
    plannedRoute: timeline.originalRoute.path,
    executedRoute: timeline.route.path,
    waits: timeline.waits,
    positions: timeline.positions,
    handoffs: timeline.handoffs,
    amendments: timeline.amendments.map((x) => ({ seq: x.seq, reason: x.reason, by: x.by, from: x.oldPath.join("/"), to: x.newPath.join("/") })),
  }, null, 2));

  ok("演示终态许可一览", JSON.stringify(engine.listPermits().map((p) => `${p.permitId}=${p.status}`)));
  console.log("\n演示完成。");
}

function must(engine, requestId) {
  const permit = [...engine.permits.values()].find((p) => p.requestId === requestId);
  if (!permit) throw new Error(`missing permit for ${requestId}`);
  return permit;
}

main().catch((error) => {
  if (error instanceof EngineError) {
    console.error("\n引擎错误：", error.code, JSON.stringify(error.details ?? null).slice(0, 600));
  } else {
    console.error(error);
  }
  process.exit(1);
});
