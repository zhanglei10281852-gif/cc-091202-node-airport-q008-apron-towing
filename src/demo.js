// 夜间集中拖机演示：
//   node src/demo.js
// 走完整流程：登记 → 审批（窄口自动错峰/宽体机绕行/资质预警）→ 激活复验 →
//   位置上报 → 封闭影响（未执行改道 + 在途安全点/改道候选）→ 完成/过期 → 回放。
// 纯内存运行，不落事件文件。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TowingEngine } from "./model/engine.js";
import { iso } from "./model/time.js";

const line = (s = "") => console.log(s);
const h1 = (s) => line(`\n=== ${s} ===`);

async function main() {
  const airport = JSON.parse(await readFile(fileURLToPath(new URL("../fixtures/airport.json", import.meta.url)), "utf8"));
  const requests = JSON.parse(await readFile(fileURLToPath(new URL("../fixtures/requests.json", import.meta.url)), "utf8")).requests;

  let now = Date.parse("2026-09-12T02:05:00+08:00");
  const clock = () => now;
  const engine = new TowingEngine({ airport, clock, config: { sweeperIntervalMs: 0 } });
  const TZ = airport.timeZone;

  h1("登记全部夜间拖行申请");
  for (const r of requests) {
    await engine.register(r, { actor: "ctl-night" });
    line(`  ${r.requestId}  ${r.aircraft.type} ${r.aircraft.registration}  ${r.from} → ${r.to}  窗口 ${r.desiredStart}`);
  }

  h1("两席管制员并发审批（临界区串行，窄口 J4 自动错峰）");
  const ids = ["tow-88", "tow-91", "tow-93", "tow-94"];
  const permits = {};
  // Promise.all 模拟两席同时点下“放行”
  const outs = await Promise.all(ids.map((id, i) =>
    engine.approve(id, { actor: i % 2 ? "ctl-B席" : "ctl-A席" }).catch((e) => ({ error: e }))));
  ids.forEach((id, i) => {
    const o = outs[i];
    if (o.error) { line(`  ${id}: 拒绝 ${o.error.code} — ${o.error.message}`); return; }
    permits[id] = o.permit.permitId;
    const p = o.permit;
    line(`  ${id} → ${p.permitId}  [${p.status}]`);
    line(`    路线: ${p.plan.edgeIds.join(" → ")}`);
    line(`    出发 ${iso(p.plan.startAt, TZ)}  到达 ${iso(p.plan.endAt, TZ)}  等待 ${p.plan.holds.filter((h) => !h.reason.startsWith("destination")).reduce((a, h) => a + h.e - h.s, 0) / 1000}s`);
    for (const w of o.eligibilityWarnings ?? []) line(`    ⚠ 资质预警: ${w}`);
  });

  h1("交叉区 J4 预留核验（间隔 ≥ 60s）");
  for (const x of engine.calendar.zones.get("J4") ?? []) {
    line(`  ${x.permId}  占用 ${iso(x.s, TZ)} ~ ${iso(x.e, TZ)}`);
  }

  h1("激活 tow-88，资质复验通过；tow-94 资质已失效被拒");
  now = Date.parse("2026-09-12T02:10:00+08:00");
  line(`  ${(await engine.activate("P-tow-88", { actor: "ctl-A席" })).status}  P-tow-88 @ ${iso(now, TZ)}`);
  now = Date.parse("2026-09-12T02:30:00+08:00");
  try { await engine.activate("P-tow-94", { actor: "ctl-B席" }); }
  catch (e) { line(`  P-tow-94 激活拒绝 [${e.code}]: ${e.details.failures.join("；")}`); }

  h1("tow-88 在途上报：已进入 J1->J4；此时封闭 J4->J3");
  now = Date.parse("2026-09-12T02:11:30+08:00");
  await engine.reportProgress("P-tow-88", { kind: "edge", edgeId: "J1->J4" });
  const impact = (await engine.closeEdge("J4->J3", { reason: "FOD 跑道异物", actor: "值班主管" })).impact;
  for (const a of impact.activePermits) {
    line(`  [${a.urgency}] ${a.permitId}: ${a.message}`);
    for (const s of a.safeStops ?? []) line(`    安全停靠点 ${s.nodeId}（ETA ${iso(s.eta, TZ)}）`);
    for (const d of a.diversions ?? []) line(`    改道候选: ${d.edgeIds.join(" → ")}`);
  }
  for (const p of impact.pendingPermits) {
    line(`  [pending] ${p.permitId} 改期/改道可行: ${p.reroute.feasible}  候选: ${p.reroute.best?.edgeIds.join(" → ") ?? "无"}`);
  }

  h1("解封后取消 tow-94 的演示许可；其余未激活许可超时自动释放");
  await engine.reopenEdge("J4->J3", { actor: "值班主管" });
  await engine.complete("P-tow-88", { actor: "ctl-A席" });
  line(`  再次完成（幂等）: ${JSON.stringify(await engine.complete("P-tow-88"))}`);
  now = Date.parse("2026-09-12T03:10:00+08:00");
  line(`  超时扫描释放: ${(await engine.expireDue()).expired.join(", ")}`);
  line(`  再次扫描（幂等）: ${(await engine.expireDue()).expired.length === 0 ? "无重复释放" : "异常"}`);

  h1("回放 tow-88 实际经过");
  const rp = engine.replay("P-tow-88");
  for (const x of rp.timeline) {
    const t = x.at ?? x.from ?? null;
    line(`  ${t ? iso(t, TZ) : "          "}  ${x.kind}${x.edgeId ? " " + x.edgeId : ""}${x.reason ? " — " + x.reason : ""}${x.by ? " （" + x.by + "）" : ""}`);
  }

  line("\n演示结束。HTTP 服务：npm start 后见 README 中的接口清单。");
}

main().catch((e) => { console.error(e); process.exit(1); });
