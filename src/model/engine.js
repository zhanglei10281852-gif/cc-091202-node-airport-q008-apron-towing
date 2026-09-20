// 拖行许可引擎。
//
// 职责：
// - 许可生命周期：registered → approved → active → completed | cancelled | expired
// - 所有状态变化先过串行锁再落事件日志；日历/在途位置完全由事件重放得到
// - 审批并发安全：规划+预留是同一个临界区，两席并发不可能同时看到空闲
// - cancel/complete/expire 幂等；激活复验人员资质与车辆状态；超时自动释放
// - 封闭影响分析：未执行许可列出改期/改道；在途许可给出安全停靠点与改道候选
// - 任何路线变更形成 amendment 链，原始路线永久保留，可回放

import { Airport } from "./airport.js";
import { ResourceCalendar } from "./calendar.js";
import { plan as runPlanner } from "./planner.js";
import { validateCrew } from "./eligibility.js";
import { EventLog } from "./eventlog.js";

const TERMINAL = new Set(["completed", "cancelled", "expired"]);
const ACTIVATION_GRACE_MS = 60_000;

class Mutex {
  constructor() { this.chain = Promise.resolve(); }
  // 临界区串行化：fn 抛错不影响后续任务获取锁。
  run(fn) {
    const result = this.chain.then(() => fn());
    this.chain = result.then(() => {}, () => {});
    return result;
  }
}

function httpError(status, code, message, details = undefined) {
  return Object.assign(new Error(message), { httpStatus: status, code, details });
}

// 兼容简写形态（aircraftType 顶层）与完整形态。
export function normalizeRequest(input) {
  if (!input || typeof input !== "object") throw httpError(400, "bad_request", "申请体必须是 JSON 对象");
  const requestId = input.requestId ?? input.id;
  if (!requestId) throw httpError(400, "bad_request", "缺少 requestId");
  if (!input.from || !input.to) throw httpError(400, "bad_request", "申请必须包含 from / to");
  const aircraft = input.aircraft ?? { type: input.aircraftType, registration: input.registration };
  if (!aircraft?.type) throw httpError(400, "bad_request", "缺少机型 aircraft.type");
  const desiredStart = input.desiredStart ?? input.desiredAt ?? null;
  const parseWhen = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v; // 已是 epoch 毫秒（重复规范化保持幂等）
    return Date.parse(v);
  };
  const req = {
    requestId: String(requestId),
    aircraft: { type: aircraft.type, registration: aircraft.registration ?? null, wingspanClass: aircraft.wingspanClass ?? null },
    crew: input.crew ?? { personnel: [], vehicles: [] },
    from: input.from,
    to: input.to,
    desiredStart: parseWhen(desiredStart),
    latestStart: parseWhen(input.latestStart ?? input.windowEnd ?? null),
    segmentSeconds: input.segmentSeconds ?? {},
    intersectionSeparationSeconds: input.intersectionSeparationSeconds ?? null,
    destinationDwellSeconds: input.destinationDwellSeconds ?? null,
    activationTimeoutSeconds: input.activationTimeoutSeconds ?? 900,
    notes: input.notes ?? null,
  };
  if (Number.isNaN(req.desiredStart) || Number.isNaN(req.latestStart)) {
    throw httpError(400, "bad_request", "期望窗口时间无法解析");
  }
  if (req.from === req.to) throw httpError(400, "bad_request", "起点与终点相同");
  return req;
}

export class TowingEngine {
  constructor({ airport, log, clock, config = {} } = {}) {
    this.airport = airport instanceof Airport ? airport : new Airport(airport ?? {});
    this.log = log ?? new EventLog(null);
    this.clock = clock ?? (() => Date.now());
    this.config = {
      activationTimeoutSeconds: 900,
      defaultDwellSeconds: 1800,
      sweeperIntervalMs: 1000,
      ...config,
    };
    this.calendar = new ResourceCalendar(this.airport);
    this.permits = new Map();
    this.requests = new Map();
    this.events = [];
    this.idempotency = new Map(); // key -> {requestId, permitId?}
    this.lock = new Mutex();
    this.droppedTail = 0;
    this._sweeper = null;
  }

  static async create(options = {}) {
    const log = new EventLog(options.logPath ?? null);
    const engine = new TowingEngine({ ...options, log });
    const { events, droppedTail } = await EventLog.load(options.logPath);
    engine.droppedTail = droppedTail;
    for (const ev of events) engine.apply(ev, { replay: true });
    engine.startSweeper();
    return engine;
  }

  startSweeper() {
    if (this._sweeper || this.config.sweeperIntervalMs <= 0) return;
    this._sweeper = setInterval(() => { this.expireDue().catch(() => {}); }, this.config.sweeperIntervalMs);
    this._sweeper.unref?.();
  }

  now() { return this.clock(); }

  // ---------- 事件应用（纯状态迁移，重放与在线走同一路径）----------
  apply(ev) {
    this.events.push(ev);
    const p = ev.permitId ? this.permits.get(ev.permitId) : null;
    switch (ev.type) {
      case "request.registered":
        this.requests.set(ev.requestId, { ...ev.request, status: "registered", registeredAt: ev.time });
        break;
      case "permit.approved": {
        const permit = {
          id: ev.permitId, requestId: ev.requestId, request: ev.request,
          status: "approved", plan: ev.plan, createdAt: ev.time,
          activatedAt: null, completedAt: null, cancelledAt: null,
          expiryAt: ev.expiryAt, manual: ev.manual ?? null, by: ev.actor ?? null,
          amendments: [], position: null, eventRefs: [ev],
        };
        this.permits.set(ev.permitId, permit);
        this.requests.set(ev.requestId, { ...(this.requests.get(ev.requestId) ?? ev.request), status: "approved", permitId: ev.permitId });
        this.calendar.reserve(permit);
        break;
      }
      case "permit.cancelled":
        if (p && !TERMINAL.has(p.status)) {
          this.calendar.release(p.id); p.status = "cancelled"; p.cancelledAt = ev.time; p.cancelReason = ev.reason ?? null;
        }
        p?.eventRefs.push(ev);
        break;
      case "permit.expired":
        if (p && !TERMINAL.has(p.status)) {
          this.calendar.release(p.id); p.status = "expired"; p.expiredAt = ev.time;
        }
        p?.eventRefs.push(ev);
        break;
      case "permit.activated":
        if (p && p.status === "approved") { p.status = "active"; p.activatedAt = ev.at ?? ev.time; }
        p?.eventRefs.push(ev);
        break;
      case "permit.progress":
        if (p) { p.position = { ...ev.position, at: ev.at ?? ev.time }; p.eventRefs.push(ev); }
        break;
      case "permit.completed":
        if (p && !TERMINAL.has(p.status)) {
          this.calendar.release(p.id); p.status = "completed"; p.completedAt = ev.at ?? ev.time;
        }
        p?.eventRefs.push(ev);
        break;
      case "permit.rerouted": {
        if (p && !TERMINAL.has(p.status)) {
          this.calendar.release(p.id);
          p.amendments.push({ kind: "reroute", at: ev.time, by: ev.actor, reason: ev.reason, previousPlan: p.plan });
          p.plan = ev.plan;
          this.calendar.reserve(p);
        }
        p?.eventRefs.push(ev);
        break;
      }
      case "permit.diverted": {
        if (p) {
          this.calendar.release(p.id);
          p.amendments.push({ kind: "diversion", at: ev.time, by: ev.actor, reason: ev.reason, previousPlan: p.plan, safeStop: ev.safeStop });
          p.plan = ev.plan; // 仅含未来尾段（steps/holds）
          p.plan.pastEdgeIds = ev.pastEdgeIds;
          this.calendar.reserve(p);
          p.eventRefs.push(ev);
        }
        break;
      }
      case "controller.note":
        p?.eventRefs.push(ev);
        break;
      case "edge.closed":
        // JSON 中 until=null 表示长期封闭（Infinity 无法序列化）
        this.calendar.closeEdge(ev.edgeId, { from: ev.from, until: ev.until ?? Infinity, reason: ev.reason, by: ev.actor });
        break;
      case "edge.reopened":
        this.calendar.reopenEdge(ev.edgeId);
        break;
      case "zone.closed":
        this.calendar.closeZone(ev.zoneId, { from: ev.from, until: ev.until ?? Infinity, reason: ev.reason, by: ev.actor });
        break;
      case "zone.reopened":
        this.calendar.reopenZone(ev.zoneId);
        break;
      default:
        // 未知事件保留在事件流中但不改变状态（前向兼容）
    }
  }

  emit(type, payload) {
    const ev = this.log.append({ type, ...payload });
    this.apply(ev);
    return ev;
  }

  // ---------- 查询 ----------
  getRequest(id) { const r = this.requests.get(id); if (!r) throw httpError(404, "not_found", `申请不存在: ${id}`); return r; }
  getPermit(id) { const p = this.permits.get(id); if (!p) throw httpError(404, "not_found", `许可不存在: ${id}`); return p; }

  explain(request, opts = {}) {
    return runPlanner(this.airport, this.calendar, request, { now: this.now(), ...opts });
  }

  // ---------- 命令（全部在锁内串行执行）----------
  register(input, { actor } = {}) {
    return this.lock.run(() => {
      const request = normalizeRequest(input);
      if (this.requests.has(request.requestId)) {
        return { idempotent: true, request: this.publicRequest(request.requestId) };
      }
      this.emit("request.registered", { requestId: request.requestId, request, actor });
      return { idempotent: false, request: this.publicRequest(request.requestId) };
    });
  }

  approve(requestId, { actor, planIndex = 0, manual = null, idempotencyKey = null } = {}) {
    return this.lock.run(() => {
      if (idempotencyKey && this.idempotency.has(`approve:${idempotencyKey}`)) {
        const hit = this.idempotency.get(`approve:${idempotencyKey}`);
        return { idempotent: true, permit: this.publicPermit(this.getPermit(hit.permitId)) };
      }
      const request = this.requests.get(requestId);
      if (!request) throw httpError(404, "not_found", `申请不存在: ${requestId}`);
      const existing = [...this.permits.values()].find((p) => p.requestId === requestId && !TERMINAL.has(p.status));
      if (existing) return { idempotent: true, permit: this.publicPermit(existing) };

      const result = runPlanner(this.airport, this.calendar, request, {
        now: this.now(),
        defaultDwellSeconds: request.destinationDwellSeconds ?? this.config.defaultDwellSeconds,
      });

      let plan = result.plans[planIndex] ?? null;
      if (!plan) {
        if (!manual?.reason) {
          throw httpError(409, "no_route", "当前时空资源下无可执行路线", { explanation: this.summarize(result) });
        }
        // 人工放行：仍须拓扑可达、机型允许、当前不封闭；占用冲突由管制员签字承担。
        const forced = runPlanner(this.airport, this.calendar, request, {
          now: this.now(), ignoreOccupancy: true,
          defaultDwellSeconds: request.destinationDwellSeconds ?? this.config.defaultDwellSeconds,
        });
        plan = forced.plans[planIndex] ?? null;
        if (!plan) throw httpError(409, "no_route", "即使人工放行也无满足机型/封闭约束的路线", { explanation: this.summarize(forced) });
      }

      const permitId = `P-${requestId}`;
      const timeoutMs = request.activationTimeoutSeconds * 1000;
      // 许可可提前签发；激活倒计时锚定计划出发时刻（至少留 1 分钟操作余量）。
      const expiryAt = Math.max(this.now() + 60_000, plan.startAt + timeoutMs);
      // 激活前的资质问题仅作预警；激活时硬性复验。
      const eligibilityWarnings = validateCrew(request.crew, plan.startAt);
      this.emit("permit.approved", {
        permitId, requestId, request, plan, actor, expiryAt,
        manual: manual ? { reason: manual.reason, routeExplanation: result.feasible ? null : this.summarize(result) } : null,
        eligibilityWarnings,
      });
      if (idempotencyKey) this.idempotency.set(`approve:${idempotencyKey}`, { requestId, permitId });
      return { idempotent: false, permit: this.publicPermit(this.getPermit(permitId)), eligibilityWarnings };
    });
  }

  cancel(permitId, { reason = null, actor } = {}) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (p.status === "cancelled") return { idempotent: true, status: p.status };
      if (TERMINAL.has(p.status)) throw httpError(409, "terminal_state", `许可已处于终态 ${p.status}，不能取消`);
      this.emit("permit.cancelled", { permitId, reason, actor });
      return { idempotent: false, status: "cancelled" };
    });
  }

  activate(permitId, { actor, at = null } = {}) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (p.status === "active") return { idempotent: true, status: "active", activatedAt: p.activatedAt };
      if (p.status !== "approved") throw httpError(409, "terminal_state", `许可状态为 ${p.status}，无法激活`);
      const now = at ?? this.now();
      if (now > p.expiryAt + ACTIVATION_GRACE_MS) {
        // 过期释放由 sweeper 兜底；此处直接给出明确结论。
        throw httpError(410, "permit_expired", "许可已超过激活时限，资源已释放或即将释放，请重新申请");
      }
      if (now > p.plan.startAt + ACTIVATION_GRACE_MS) {
        throw httpError(409, "missed_window", `已晚于计划出发 ${new Date(p.plan.startAt).toISOString()}，请改期后再激活`);
      }
      // 激活即出发：资质与车辆状态必须在“此刻”仍有效（申请快照在出发时复验）。
      const failures = validateCrew(p.request.crew, now);
      if (failures.length) {
        throw httpError(412, "eligibility_failed", "人员资质或车辆状态在出发时无效，许可保持但不可激活", { failures });
      }
      this.emit("permit.activated", { permitId, actor, at: now });
      return { idempotent: false, status: "active", activatedAt: now };
    });
  }

  reportProgress(permitId, position, { actor } = {}) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (p.status !== "active") throw httpError(409, "not_active", `许可状态为 ${p.status}`);
      const at = position.at ? Date.parse(position.at) : this.now();
      const normalized = position.kind === "node"
        ? { kind: "node", nodeId: position.nodeId, state: position.state ?? "holding" }
        : { kind: "edge", edgeId: position.edgeId, enteredAt: position.enteredAt ? Date.parse(position.enteredAt) : null };
      if (normalized.kind === "node" && !this.airport.node(normalized.nodeId)) throw httpError(400, "bad_node", `未知节点 ${normalized.nodeId}`);
      if (normalized.kind === "edge" && !this.airport.edge(normalized.edgeId)) throw httpError(400, "bad_edge", `未知路段 ${normalized.edgeId}`);
      this.emit("permit.progress", { permitId, actor, at, position: normalized });
      return { idempotent: false, position: this.getPermit(permitId).position };
    });
  }

  complete(permitId, { actor, at = null } = {}) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (p.status === "completed") return { idempotent: true, status: "completed" };
      if (p.status === "cancelled" || p.status === "expired") throw httpError(409, "terminal_state", `许可已${p.status}，不能完成`);
      this.emit("permit.completed", { permitId, actor, at: at ?? this.now() });
      return { idempotent: false, status: "completed" };
    });
  }

  note(permitId, { kind = "manual-release", reason, actor, detail = null }) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (!reason) throw httpError(400, "bad_request", "人工放行记录必须包含 reason");
      this.emit("controller.note", { permitId, actor, noteKind: kind, reason, detail });
      return { idempotent: false, noted: p.eventRefs.at(-1) };
    });
  }

  // ---------- 超时扫描 ----------
  expireDue(now = this.now()) {
    return this.lock.run(() => {
      const due = [];
      for (const p of this.permits.values()) {
        if (p.status === "approved" && p.expiryAt <= now) due.push(p.id);
      }
      for (const id of due) this.emit("permit.expired", { permitId: id, reason: "activation_timeout" });
      return { expired: due };
    });
  }

  // ---------- 路段封闭与影响 ----------
  closeEdge(edgeId, { until = null, reason = "", actor } = {}) {
    return this.lock.run(() => {
      if (!this.airport.edge(edgeId)) throw httpError(404, "not_found", `路段不存在: ${edgeId}`);
      const now = this.now();
      const untilMs = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
      if (Number.isNaN(untilMs)) throw httpError(400, "bad_time", "until 无法解析");
      this.emit("edge.closed", { edgeId, from: now, until: untilMs, reason, actor });
      return { edgeId, closed: true, impact: this.closureImpact(edgeId, { from: now, until: untilMs }) };
    });
  }

  reopenEdge(edgeId, { actor } = {}) {
    return this.lock.run(() => {
      this.emit("edge.reopened", { edgeId, actor });
      return { edgeId, closed: false };
    });
  }

  closeZone(zoneId, { until = null, reason = "", actor } = {}) {
    return this.lock.run(() => {
      if (!this.airport.zones.has(zoneId)) throw httpError(404, "not_found", `交叉区不存在: ${zoneId}`);
      const now = this.now();
      const untilMs = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
      if (Number.isNaN(untilMs)) throw httpError(400, "bad_time", "until 无法解析");
      this.emit("zone.closed", { zoneId, from: now, until: untilMs, reason, actor });
      return { zoneId, closed: true };
    });
  }

  reopenZone(zoneId, { actor } = {}) {
    return this.lock.run(() => {
      this.emit("zone.reopened", { zoneId, actor });
      return { zoneId, closed: false };
    });
  }

  // 影响分析不产生事件，可随时调用预览。
  closureImpact(edgeId, windowArg = null) {
    const window = windowArg ?? this.calendar.closedEdges.get(edgeId);
    if (!window) return { edgeId, pendingPermits: [], activePermits: [] };
    const overlaps = (s, e) => s < window.until && e > window.from;
    const pendingPermits = [];
    const activePermits = [];
    for (const p of this.permits.values()) {
      if (TERMINAL.has(p.status)) continue;
      const hitStep = (p.plan.steps ?? []).find((st) => st.edgeId === edgeId && overlaps(st.enterAt, st.exitAt));
      if (!hitStep) continue;
      if (p.status === "active") {
        activePermits.push(this.describeActiveImpact(p, edgeId));
      } else {
        pendingPermits.push({ permitId: p.id, requestId: p.requestId, step: hitStep, reroute: this.rerouteFeasibility(p) });
      }
    }
    return { edgeId, window: { from: window.from, until: Number.isFinite(window.until) ? window.until : null }, pendingPermits, activePermits };
  }

  describeActiveImpact(p, closedEdgeId) {
    const pos = p.position ?? { kind: "node", nodeId: p.request.from, at: this.now() };
    const steps = p.plan.steps ?? [];
    const posIndex = this.positionIndex(p, steps); // 下一条尚未完成的边下标
    const targetIndex = steps.findIndex((st, i) => st.edgeId === closedEdgeId && i >= posIndex);
    if (targetIndex === -1) {
      return { permitId: p.id, requestId: p.requestId, urgency: "none", message: "封闭路段已在牵引组后方，不受影响", currentPosition: pos, safeStops: [], diversions: [] };
    }

    if (pos.kind === "edge" && pos.edgeId === closedEdgeId) {
      return {
        permitId: p.id, requestId: p.requestId, urgency: "critical",
        message: "牵引组已在封闭路段内：指令其保持拖行、尽快驶离至前方安全点，禁止在路段内停车",
        currentPosition: pos,
        safeStops: this.safeStopsAhead(p, steps, posIndex),
      };
    }

    const safeStops = [];
    if (pos.kind === "node") {
      const info = this.airport.node(pos.nodeId);
      if (info && Number.isFinite(info.capacity)) safeStops.push({ nodeId: pos.nodeId, eta: pos.at ?? this.now(), capacity: info.capacity, current: true });
    }
    for (let i = Math.max(0, posIndex); i < targetIndex; i++) {
      const node = steps[i].to;
      const info = this.airport.node(node);
      if (info && Number.isFinite(info.capacity)) safeStops.push({ nodeId: node, eta: this.etaAt(p, steps, i), capacity: info.capacity });
    }
    const nearest = safeStops.at(-1) ?? null;
    if (!nearest) {
      // 牵引组已在封闭点之前的最后一条/最后一串无等待点路段上：
      // 不能在交叉口停车，只能在现场引导下继续驶离，属紧急态势。
      const beyond = this.safeStopsAhead(p, steps, targetIndex);
      return {
        permitId: p.id, requestId: p.requestId, urgency: "critical",
        currentPosition: pos,
        message: `已无封闭点之前的安全停靠点（${closedEdgeId} 之前均为不可停车路段）：禁止在交叉口停车，须现场引导其继续驶离封闭段`,
        safeStops: [],
        beyondClosureStops: beyond,
        diversions: [],
      };
    }
    return {
      permitId: p.id, requestId: p.requestId, urgency: "warning",
      currentPosition: pos,
      message: `在 ${nearest.nodeId} 安全停靠，等待解封或按改道候选继续`,
      safeStops,
      diversions: nearest.nodeId !== p.request.to ? this.diversionCandidates(p, nearest) : [],
    };
  }

  safeStopsAhead(p, steps, posIndex) {
    const out = [];
    for (let i = posIndex; i < steps.length; i++) {
      const info = this.airport.node(steps[i].to);
      if (info && Number.isFinite(info.capacity)) out.push({ nodeId: steps[i].to, eta: this.etaAt(p, steps, i) });
    }
    return out;
  }

  positionIndex(p, steps) {
    if (!p.position) return 0;
    if (p.position.kind === "edge") {
      const i = steps.findIndex((st) => st.edgeId === p.position.edgeId);
      return i < 0 ? 0 : i;
    }
    const i = steps.findIndex((st) => st.to === p.position.nodeId);
    return i < 0 ? 0 : i + 1;
  }

  etaAt(p, steps, stepIndex) {
    if (p.position?.kind === "node") return Math.max(p.position.at ?? this.now(), steps[stepIndex]?.exitAt ?? this.now());
    return steps[stepIndex]?.exitAt ?? this.now();
  }

  diversionCandidates(p, safeStop) {
    if (safeStop.nodeId === p.request.to) return [];
    const pseudo = {
      requestId: `${p.requestId}:diversion`,
      aircraft: p.request.aircraft, crew: p.request.crew,
      from: safeStop.nodeId, to: p.request.to,
      desiredStart: safeStop.eta, latestStart: null,
      segmentSeconds: p.request.segmentSeconds,
      intersectionSeparationSeconds: p.request.intersectionSeparationSeconds,
      destinationDwellSeconds: p.request.destinationDwellSeconds,
    };
    const result = runPlanner(this.airport, this.calendar, pseudo, {
      now: Math.min(this.now(), safeStop.eta), earliest: safeStop.eta, excludePermId: p.id,
      defaultDwellSeconds: p.request.destinationDwellSeconds ?? this.config.defaultDwellSeconds,
    });
    return result.plans.slice(0, 3).map((plan) => ({ edgeIds: plan.edgeIds, startAt: plan.startAt, endAt: plan.endAt, plan }));
  }

  rerouteFeasibility(p) {
    const result = runPlanner(this.airport, this.calendar, p.request, { now: this.now(), excludePermId: p.id });
    return { feasible: result.feasible, best: result.best ? { edgeIds: result.best.edgeIds, endAt: result.best.endAt } : null, summary: this.summarize(result) };
  }

  // 未执行许可改期/改道（原始计划进入 amendment 链，不做无记录覆盖）。
  reroute(permitId, { planIndex = 0, reason, actor } = {}) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (TERMINAL.has(p.status)) throw httpError(409, "terminal_state", "终态许可不能改道");
      if (p.status === "active") throw httpError(409, "in_progress", "在途许可须先在安全点停靠，使用 divert 尾段改道");
      if (!reason) throw httpError(400, "bad_request", "改道必须记录原因 reason");
      const result = runPlanner(this.airport, this.calendar, p.request, { now: this.now(), excludePermId: p.id });
      if (!result.feasible) throw httpError(409, "no_route", "改道后仍无可执行路线", { explanation: this.summarize(result) });
      const plan = result.plans[planIndex];
      this.emit("permit.rerouted", { permitId: p.id, actor, reason, previousPlan: p.plan, plan });
      return { idempotent: false, permit: this.publicPermit(this.getPermit(p.id)) };
    });
  }

  // 在途尾段改道：牵引组必须已在安全停靠点报到。
  divert(permitId, { candidateIndex = 0, reason, actor } = {}) {
    return this.lock.run(() => {
      const p = this.getPermit(permitId);
      if (p.status !== "active") throw httpError(409, "not_active", "仅在途许可可尾段改道");
      if (!reason) throw httpError(400, "bad_request", "改道必须记录原因 reason");
      const pos = p.position;
      if (!pos || pos.kind !== "node" || pos.state === "moving") {
        throw httpError(409, "not_at_safe_stop", "牵引组必须先在安全停靠点报到（progress: node/holding）");
      }
      const stop = { nodeId: pos.nodeId, eta: pos.at ?? this.now() };
      const candidates = this.diversionCandidates(p, stop);
      if (!candidates.length) throw httpError(409, "no_route", "安全点之后无改道候选");
      const tail = candidates[candidateIndex]?.plan;
      if (!tail) throw httpError(400, "bad_index", "candidateIndex 超出候选范围");
      const steps = p.plan.steps ?? [];
      const pastEdgeIds = steps.filter((st) => st.exitAt <= stop.eta || st.to === stop.nodeId).map((st) => st.edgeId);
      this.emit("permit.diverted", {
        permitId: p.id, actor, reason, safeStop: stop, pastEdgeIds, plan: tail,
      });
      return { idempotent: false, permit: this.publicPermit(this.getPermit(p.id)), candidates: candidates.map((c) => c.edgeIds) };
    });
  }

  // ---------- 解释与回放 ----------
  summarize(result) {
    const reasons = new Map();
    for (const e of result.evaluated.filter((x) => !x.feasible)) {
      const key = e.blocker ? `${e.blocker.kind}:${e.blocker.edgeId ?? e.blocker.zoneId ?? e.blocker.nodeId ?? ""}` : e.reason;
      if (!reasons.has(key)) reasons.set(key, { count: 0, sample: e });
      reasons.get(key).count += 1;
    }
    const blockers = [...reasons.entries()].map(([key, v]) => ({
      constraint: key, affectedPathCount: v.count,
      path: v.sample.path, atNode: v.sample.atNode, nearEdge: v.sample.nearEdge,
      detail: v.sample.blocker, reason: v.sample.reason,
    }));
    return {
      feasible: result.feasible,
      searchedAt: new Date(result.searchedAt).toISOString(),
      earliestStart: new Date(result.earliest).toISOString(),
      windowEnd: result.latestStart ? new Date(result.latestStart).toISOString() : null,
      candidatePathCount: result.evaluated.length + result.rejectedEdges.length,
      scheduledPathCount: result.evaluated.length,
      typeRejectedEdges: result.rejectedEdges,
      blockers,
      evaluated: result.evaluated,
    };
  }

  replay(permitId) {
    const p = this.getPermit(permitId);
    const timeline = [];
    for (const ev of p.eventRefs) {
      switch (ev.type) {
        case "permit.approved":
          timeline.push({ at: ev.time, kind: "approved", by: ev.actor, manual: ev.manual, expiryAt: ev.expiryAt, route: ev.plan.edgeIds });
          for (const st of ev.plan.steps) timeline.push({ at: st.enterAt, kind: "traversal-scheduled", edgeId: st.edgeId, from: st.enterAt, to: st.exitAt, zoneId: st.zoneId ?? null });
          for (const h of ev.plan.holds ?? []) timeline.push({ at: h.s, kind: "wait-scheduled", nodeId: h.nodeId, from: h.s, to: h.e, reason: h.reason });
          break;
        case "permit.activated": timeline.push({ at: ev.at ?? ev.time, kind: "activated", by: ev.actor }); break;
        case "permit.progress": timeline.push({ at: ev.at ?? ev.time, kind: "position", by: ev.actor, position: ev.position }); break;
        case "permit.rerouted":
          timeline.push({ at: ev.time, kind: "rerouted", by: ev.actor, reason: ev.reason, previousRoute: ev.previousPlan.edgeIds, newRoute: ev.plan.edgeIds }); break;
        case "permit.diverted":
          timeline.push({ at: ev.time, kind: "diverted", by: ev.actor, reason: ev.reason, safeStop: ev.safeStop, pastRoute: ev.pastEdgeIds, newTail: ev.plan.edgeIds }); break;
        case "controller.note": timeline.push({ at: ev.time, kind: ev.noteKind ?? "note", by: ev.actor, reason: ev.reason, detail: ev.detail ?? null }); break;
        case "permit.cancelled": timeline.push({ at: ev.time, kind: "cancelled", by: ev.actor, reason: ev.reason }); break;
        case "permit.expired": timeline.push({ at: ev.time, kind: "expired", reason: ev.reason }); break;
        case "permit.completed": timeline.push({ at: ev.at ?? ev.time, kind: "completed", by: ev.actor }); break;
        default: break;
      }
    }
    return {
      permitId, requestId: p.requestId, aircraft: p.request.aircraft, from: p.request.from, to: p.request.to,
      status: p.status, activatedAt: p.activatedAt,
      currentRoute: (p.plan.pastEdgeIds ?? []).concat(p.plan.edgeIds ?? p.plan.steps.map((s) => s.edgeId)),
      currentPlan: p.plan, position: p.position, amendments: p.amendments.map((a) => ({ kind: a.kind, at: a.at, by: a.by, reason: a.reason, previousRoute: a.previousPlan.edgeIds, safeStop: a.safeStop ?? null })),
      timeline,
    };
  }

  // ---------- 对外视图 ----------
  publicRequest(id) {
    const r = this.requests.get(id);
    return { requestId: id, status: r.status, permitId: r.permitId ?? null, aircraft: r.aircraft?.type, from: r.from, to: r.to };
  }

  publicPermit(p) {
    const tailIds = p.plan.edgeIds ?? p.plan.steps.map((s) => s.edgeId);
    const edgeIds = p.plan.pastEdgeIds ? [...p.plan.pastEdgeIds, ...tailIds] : tailIds;
    return {
      permitId: p.id, requestId: p.requestId, status: p.status,
      aircraft: p.request.aircraft, from: p.request.from, to: p.request.to,
      plan: { edgeIds, tailEdgeIds: tailIds, pastEdgeIds: p.plan.pastEdgeIds ?? null, startAt: p.plan.startAt, endAt: p.plan.endAt, steps: p.plan.steps, holds: p.plan.holds },
      activatedAt: p.activatedAt, expiryAt: p.expiryAt, manual: p.manual, amendments: p.amendments.length,
      position: p.position,
    };
  }

  snapshot() {
    return {
      at: this.now(),
      permits: [...this.permits.values()].map((p) => this.publicPermit(p)),
      calendar: this.calendar.snapshot(),
      closures: {
        edges: [...this.calendar.closedEdges.entries()].map(([edgeId, c]) => ({ edgeId, from: c.from, until: Number.isFinite(c.until) ? c.until : null, reason: c.reason })),
        zones: [...this.calendar.closedZones.entries()].map(([zoneId, c]) => ({ zoneId, from: c.from, until: Number.isFinite(c.until) ? c.until : null, reason: c.reason })),
      },
      replayedEvents: this.events.length,
      droppedTail: this.droppedTail,
    };
  }
}
