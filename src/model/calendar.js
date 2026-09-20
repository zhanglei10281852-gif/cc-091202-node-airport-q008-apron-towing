// 资源日历：路段占用区间、交叉区通过时刻（带安全间隔）、机位/等待点容量。
// 所有查询都支持 excludePermId —— 改期同一许可时不与自身冲突。
// 数据由事件重放重建，本身不落盘。

const inf = Number.POSITIVE_INFINITY;

function overlap([s1, e1], [s2, e2]) {
  return s1 < e2 && s2 < e1; // 首尾相接（e1===s2）视为可交接，不算冲突
}

class IntervalIndex {
  constructor() { this.items = new Map(); } // key -> [{permId, s, e, meta}]
  add(key, entry) {
    if (!this.items.has(key)) this.items.set(key, []);
    const list = this.items.get(key);
    list.push(entry);
    list.sort((a, b) => a.s - b.s);
  }
  remove(key, permId) {
    const list = this.items.get(key);
    if (!list) return 0;
    const next = list.filter((x) => x.permId !== permId);
    const removed = list.length - next.length;
    if (next.length) this.items.set(key, next); else this.items.delete(key);
    return removed;
  }
  list(key) { return this.items.get(key) ?? []; }
  *[Symbol.iterator]() { for (const [key, list] of this.items) for (const e of list) yield { key, ...e }; }
}

export class ResourceCalendar {
  constructor(airport) {
    this.airport = airport;
    this.edges = new IntervalIndex();
    this.berths = new IntervalIndex();
    this.zones = new Map(); // zoneId -> [{permId, at}]
    this.closedEdges = new Map(); // edgeId -> {from, until(Infinity 表示长期封闭), reason, by}
    this.closedZones = new Map();
  }

  // ---- 封闭管理 ----
  closeEdge(edgeId, { from = 0, until = inf, reason = "", by } = {}) {
    this.closedEdges.set(edgeId, { from, until, reason, by });
  }
  reopenEdge(edgeId) { this.closedEdges.delete(edgeId); }
  closeZone(zoneId, opts = {}) {
    this.closedZones.set(zoneId, { from: opts.from ?? 0, until: opts.until ?? inf, reason: opts.reason ?? "", by: opts.by });
  }
  reopenZone(zoneId) { this.closedZones.delete(zoneId); }

  edgeClosure(edgeId, at) {
    const c = this.closedEdges.get(edgeId);
    return c && at >= c.from && at < c.until ? c : null;
  }
  zoneClosed(zoneId, at) {
    const c = this.closedZones.get(zoneId);
    return c && at >= c.from && at < c.until ? c : null;
  }

  // 路段何时解除封闭（规划器把出发时刻推到解封之后）。
  edgeClosedUntil(edgeId, at) {
    const c = this.edgeClosure(edgeId, at);
    return c ? c.until : null;
  }

  // ---- 占用查询 ----
  edgeConflict(edgeId, s, e, excludePermId) {
    // 封闭区间与通过区间相交即冲突（首尾相接允许）。
    const c = this.closedEdges.get(edgeId);
    if (c && s < c.until && e > c.from) {
      return { kind: "closure", edgeId, from: c.from, until: c.until, reason: c.reason };
    }
    for (const x of this.edges.list(edgeId)) {
      if (x.permId === excludePermId) continue;
      if (overlap([s, e], [x.s, x.e])) return { kind: "edge", edgeId, permId: x.permId, s: x.s, e: x.e };
    }
    return null;
  }

  zoneConflict(zoneId, s, e, separationMs, excludePermId) {
    // 占用区间语义：另一许可与本区间任一端的间隔不足 separationMs 即冲突，
    // 即要求 b.s >= a.e+sep 或 b.e <= a.s-sep。
    const c = this.closedZones.get(zoneId);
    if (c && s < c.until && e > c.from) {
      return { kind: "zoneClosure", zoneId, from: c.from, until: c.until, reason: c.reason };
    }
    for (const x of this.zones.get(zoneId) ?? []) {
      if (x.permId === excludePermId) continue;
      if (s < x.e + separationMs && e > x.s - separationMs) {
        return { kind: "zone", zoneId, permId: x.permId, s: x.s, e: x.e, separationMs };
      }
    }
    return null;
  }

  berthConflict(nodeId, s, e, capacity, excludePermId) {
    if (!Number.isFinite(capacity) || s >= e) return null;
    const list = this.berths.list(nodeId);
    // 区间重叠计数：容量为 1 时返回第一个阻塞者；一般容量做时间点扫描。
    for (const x of list) {
      if (x.permId === excludePermId) continue;
      if (overlap([s, e], [x.s, x.e])) {
        if (capacity <= 1) return { kind: "berth", nodeId, permId: x.permId, s: x.s, e: x.e, capacity };
        // 多容量：统计重叠时刻上的并发占用
        const concurrent = list.filter((y) => y.permId !== excludePermId && overlap([s, e], [y.s, y.e]));
        if (concurrent.length >= capacity) return { kind: "berth", nodeId, permId: x.permId, s: x.s, e: x.e, capacity };
      }
    }
    return null;
  }

  // ---- 预留与释放（许可计划整体）----
  reserve(permit) {
    const plan = permit.plan;
    for (const step of plan.steps) {
      this.edges.add(step.edgeId, { permId: permit.id, s: step.enterAt, e: step.exitAt });
      if (step.zoneId) {
        if (!this.zones.has(step.zoneId)) this.zones.set(step.zoneId, []);
        const list = this.zones.get(step.zoneId);
        // 同一许可连续共享同一交叉区的相邻边合并为一个占用区间。
        const last = list.find((x) => x.permId === permit.id && x.e === step.enterAt);
        if (last) last.e = step.exitAt;
        else list.push({ permId: permit.id, s: step.enterAt, e: step.exitAt });
      }
    }
    for (const hold of plan.holds ?? []) {
      this.berths.add(hold.nodeId, { permId: permit.id, s: hold.s, e: hold.e, reason: hold.reason });
    }
  }

  release(permId) {
    let n = 0;
    for (const key of this.edges.items.keys()) n += this.edges.remove(key, permId);
    for (const key of this.berths.items.keys()) this.berths.remove(key, permId);
    for (const [zoneId, list] of this.zones) {
      const next = list.filter((x) => x.permId !== permId);
      if (next.length !== list.length) {
        if (next.length) this.zones.set(zoneId, next); else this.zones.delete(zoneId);
      }
    }
    return n;
  }

  // 激活时补一段“出发点待命占用”（计划从出发时刻开始预留，激活到出发之间的机位占用）。
  addActiveHold(permId, nodeId, s, e) {
    if (s < e) this.berths.add(nodeId, { permId: permId, s, e, reason: "active-hold" });
  }

  snapshot() {
    const edges = [...this.edges].map((x) => ({ ...x }));
    const zones = [];
    for (const [zoneId, list] of this.zones) for (const x of list) zones.push({ zoneId, ...x });
    const berths = [...this.berths].map((x) => ({ ...x }));
    return { edges, zones, berths, closedEdges: [...this.closedEdges.keys()], closedZones: [...this.closedZones.keys()] };
  }}
