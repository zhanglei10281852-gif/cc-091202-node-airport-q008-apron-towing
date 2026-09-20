// 拖行许可引擎（事件溯源 + 单命令串行化）。
//
// 所有状态变更都以事件落盘；日历、封闭状态、在途位置均为事件流的派生视图，
// 重启重放后一致。命令带 commandId 去重，取消/完成/过期释放重复调用幂等。
//
// 许可状态：ISSUED(待激活) -> ACTIVE(在途) -> COMPLETED
//                              ISSUED -> EXPIRED / CANCELLED
//                              ACTIVE -> CANCELLED（须在安全停靠点）

import { Calendar } from "./scheduler.js";
import { planRoute } from "./planner.js";
import { toMs, toIso } from "./time.js";

export const TERMINAL = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "REJECTED"]);

/** 最早可在计划发车前多久激活（现场就位容差）。 */
export const ACTIVATION_EARLY_TOLERANCE_MS = 60_000;

export class TowingEngine {
  constructor({ network, credentials, store, clock = () => Date.now(), logger = () => {} }) {
    this.network = network;
    this.credentials = credentials;
    this.store = store;
    this.clock = typeof clock === "function" ? { now: clock } : clock;
    this.log = logger;
    this.calendar = new Calendar();
    this.requests = new Map();
    this.permits = new Map();
    this.commandIndex = new Map(); // commandId -> 命令结果（重启后由事件重建）
    this._seq = 0;
    this._chain = Promise.resolve();
    this._replayed = false;
  }

  /** 重放事件流，重建全部派生状态。 */
  async load() {
    const events = await this.store.readEvents();
    for (const event of events) this._apply(event, /*replay*/ true);
    this._replayed = true;
    return { events: events.length };
  }

  // —— 并发控制：两席审批经同一把锁串行，第二个必然看到第一个的预留 ——
  _serialize(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async _commit(type, data, commandId = null) {
    if (commandId && this.commandIndex.has(commandId)) {
      return { idempotent: true, ...this.commandIndex.get(commandId) };
    }
    this._seq += 1;
    const event = {
      eventId: `evt-${this._seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: this.clock.now(),
      type,
      commandId,
      data,
    };
    await this.store.append(event);
    this._apply(event, false);
    if (commandId) this.commandIndex.set(commandId, { eventId: event.eventId, type, data: summarize(data) });
    return { eventId: event.eventId, type, at: event.at, data };
  }

  _apply(event, replay) {
    const { type, data } = event;
    switch (type) {
      case "REQUEST_SUBMITTED":
        this.requests.set(data.requestId, { ...data, status: "REQUESTED" });
        break;
      case "PERMIT_ISSUED": {
        const p = data.permit;
        this.permits.set(p.permitId, {
          ...p,
          status: "ISSUED",
          routePath: p.path,
          positions: [],
          handoffs: [],
          amendments: [],
        });
        this.requests.set(p.requestId, { ...(this.requests.get(p.requestId) ?? {}), requestId: p.requestId, status: "ISSUED" });
        for (const leg of p.legs) this.calendar.reserveLeg(p.permitId, leg);
        break;
      }
      case "PERMIT_ACTIVATED": {
        const p = this._mustPermit(data.permitId);
        p.status = "ACTIVE";
        p.activatedAt = data.at;
        p.activatedBy = data.by;
        break;
      }
      case "POSITION_REPORTED": {
        const p = this._mustPermit(data.permitId);
        const point = { at: data.at, node: data.node ?? null, edgeId: data.edgeId ?? null, phase: data.phase, note: data.note ?? null };
        p.positions.push(point);
        p.position = point;
        break;
      }
      case "PERMIT_HANDED_OFF": {
        const p = this._mustPermit(data.permitId);
        p.handoffs.push(data);
        p.crewTeam = data.toTeam;
        break;
      }
      case "PERMIT_REROUTED": {
        const p = this._mustPermit(data.permitId);
        p.amendments.push(data.amendment);
        p.legs = [...data.amendment.keptLegs, ...data.amendment.newLegs];
        p.routePath = [...data.amendment.keptLegs.map((l) => l.edgeId), ...data.amendment.newPath];
        // 日历中仅保留改航后的未来航段（已完成航段时间已过去，不构成未来冲突）。
        this.calendar.replacePermitLegs(p.permitId, data.amendment.newLegs);
        break;
      }
      case "MANUAL_RELEASE": {
        const p = this._mustPermit(data.permitId);
        p.manualReleases = [...(p.manualReleases ?? []), data.release];
        break;
      }
      case "PERMIT_CANCELLED":
      case "PERMIT_COMPLETED":
      case "PERMIT_EXPIRED":
      case "PERMIT_REJECTED": {
        const p = this.permits.get(data.permitId);
        if (p) {
          p.status = type.replace("PERMIT_", "");
          p.closedAt = data.at;
          p.closeReason = data.reason ?? null;
          this.calendar.releasePermit(p.permitId);
        }
        const req = this.requests.get(data.requestId);
        if (req) req.status = p?.status ?? req.status;
        break;
      }
      case "EDGE_CLOSED":
        this.network.closures.set(data.edgeId, { reason: data.reason, since: event.at, by: data.by });
        break;
      case "EDGE_REOPENED":
        this.network.closures.delete(data.edgeId);
        break;
      default:
        this.log?.(`unknown event ${type}`);
    }
    if (replay) {
      this._seq += 1;
      if (event.commandId) this.commandIndex.set(event.commandId, { eventId: event.eventId, type, data: summarize(data) });
    }
  }

  _mustPermit(permitId) {
    const p = this.permits.get(permitId);
    if (!p) throw new EngineError("permit_unknown", 404, { permitId });
    return p;
  }

  // ====================== 命令 ======================

  /** 提交申请；同时做一次预规划（只读，结果写入审计）。 */
  submit(raw, ctx = {}) {
    return this._serialize(() => this._submit(raw, ctx));
  }

  async _submit(raw, ctx) {
    const request = normalizeRequest(raw, this.network);
    const preview = this._plan(request);
    const event = await this._commit(
      "REQUEST_SUBMITTED",
      {
        requestId: request.requestId,
        request,
        preview: { ok: preview.ok, code: preview.code ?? null, departure: preview.departure ?? null, arrival: preview.arrival ?? null },
      },
      ctx.commandId ?? `submit:${request.requestId}`,
    );
    return { ...event, plan: preview };
  }

  /** 只读规划解释：某申请为何有路/无路。 */
  explain(requestId) {
    return this._plan(this._mustRequest(requestId));
  }

  _mustRequest(requestId) {
    const entry = this.requests.get(requestId);
    if (!entry?.request) throw new EngineError("request_unknown", 404, { requestId });
    return entry.request;
  }

  _plan(request) {
    return planRoute({
      network: this.network,
      calendar: this.calendar,
      aircraftType: request.aircraft.type,
      wingspan: request.aircraft.wingspan,
      from: request.from,
      to: request.to,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      legSeconds: request.legSeconds,
      separationMs: request.separationMs,
      selfPermitId: request.permitId ?? null,
    });
  }

  /**
   * 审批发放许可。两席并发时由串行锁保证：先到者预留资源，后到者只能看到
   * 已占用日历。无路可走返回结构化原因，不改变状态。
   * manual：人工放行，须逐条列出覆盖的冲突与理由（全部留痕）。
   */
  approve(requestId, ctx = {}) {
    return this._serialize(() => this._sweepExpired().then(() => this._approve(requestId, ctx)));
  }

  async _approve(requestId, ctx) {
    const request = this._mustRequest(requestId);
    const existing = [...this.permits.values()].find((p) => p.requestId === requestId);
    if (existing) {
      // 重复审批天然幂等：无论是否带 commandId，都返回既有许可而不是再次放行。
      return { idempotent: true, permitId: existing.permitId, status: existing.status };
    }

    let plan = this._plan(request);
    let manualReleases = [];
    if (!plan.ok && ctx.manual) {
      const forced = this._forcePlan(request, ctx.manual);
      plan = forced.plan;
      manualReleases = forced.releases;
    }
    if (!plan.ok) {
      throw new EngineError("no_feasible_route", 422, {
        requestId,
        code: plan.code,
        reasons: plan.reasons,
        attempts: plan.attempts,
      });
    }

    const now = this.clock.now();
    const permitId = `PMT-${requestId}`;
    const permit = {
      permitId,
      requestId,
      aircraft: request.aircraft,
      crew: request.crew,
      vehicle: request.vehicle,
      from: request.from,
      to: request.to,
      separationMs: request.separationMs,
      path: plan.path,
      legs: plan.legs,
      legSeconds: request.legSeconds,
      originalPath: plan.path,
      originalLegs: plan.legs,
      issuedAt: now,
      by: ctx.by ?? "anonymous",
      activateBy: plan.legs[0].enter + request.activateGraceMs,
      waitMsTotal: plan.waitMs,
      manualReleases: [], // 实际记录由随后的 MANUAL_RELEASE 事件追加
    };
    const issued = await this._commit("PERMIT_ISSUED", { permit }, ctx.commandId ?? `approve:${requestId}`);
    for (const release of manualReleases) {
      await this._commit("MANUAL_RELEASE", { permitId, release });
    }
    return { ...issued, permitId };
  }

  /** 人工放行：忽略被明确签收的冲突，按最早时刻排程，冲突逐条留痕。 */
  _forcePlan(request, manual) {
    if (!manual.reason) throw new EngineError("manual_reason_required", 400);
    const acknowledged = new Set(manual.acknowledge ?? []);
    // 在不考虑其他许可占有的日历上推演自由流时刻，再用真实日历收集冲突。
    const tentative = planRoute({
      network: this.network,
      calendar: new Calendar(),
      aircraftType: request.aircraft.type,
      wingspan: request.aircraft.wingspan,
      from: request.from,
      to: request.to,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      legSeconds: request.legSeconds,
      separationMs: request.separationMs,
    });
    if (!tentative.ok) {
      throw new EngineError("manual_cannot_fix_structural", 422, { code: tentative.code, reasons: tentative.reasons });
    }
    const releases = [];
    for (const leg of tentative.legs) {
      for (const hit of this.calendar.overlapping("edge", leg.edgeId, leg.enter, leg.exit)) {
        releases.push(this._releaseRecord("edge", leg.edgeId, hit, leg, manual));
      }
      for (const hit of this.calendar.overlapping("channel", leg.channel, leg.enter, leg.exit)) {
        releases.push(this._releaseRecord("channel", leg.channel, hit, leg, manual));
      }
      if (leg.zone) {
        for (const z of this.calendar.zoneBlockers(leg.zone, leg.enter, leg.separation)) {
          const key = `zone:${leg.zone}:${z.entry.permitId}`;
          if (!acknowledged.has(key)) {
            throw new EngineError("manual_acknowledgement_required", 409, { need: key, conflict: z });
          }
          releases.push({
            resource: "zone", resourceId: leg.zone, againstPermit: z.entry.permitId,
            otherEnter: z.entry.start, required: z.required, plannedEnter: leg.enter,
            edgeId: leg.edgeId, reason: manual.reason, by: manual.by ?? "anonymous", at: this.clock.now(),
          });
        }
      }
      for (const rel of releases.filter((r) => r.resource !== "zone")) {
        const key = `${rel.resource}:${rel.resourceId}:${rel.againstPermit}`;
        if (!acknowledged.has(key)) {
          throw new EngineError("manual_acknowledgement_required", 409, { need: key });
        }
      }
    }
    // 同一资源对的冲突只留一条审计记录。
    const deduped = new Map();
    for (const r of releases) {
      deduped.set(`${r.resource}:${r.resourceId}:${r.againstPermit}`, r);
    }
    return { plan: tentative, releases: [...deduped.values()] };
  }

  _releaseRecord(kind, resourceId, hit, leg, manual) {
    return {
      resource: kind,
      resourceId,
      againstPermit: hit.permitId,
      window: [hit.start, hit.end],
      plannedWindow: [leg.enter, leg.exit],
      edgeId: leg.edgeId,
      reason: manual.reason,
      by: manual.by ?? "anonymous",
      at: this.clock.now(),
    };
  }

  /**
   * 激活：出发时重新校验人员资质与车辆状态；任一失效则拒绝激活，
   * 许可保留待查（由管制员取消或等待过期）。
   */
  activate(permitId, ctx = {}) {
    return this._serialize(() => this._activate(permitId, ctx));
  }

  async _activate(permitId, ctx) {
    await this._sweepExpired();
    const p = this._mustPermit(permitId);
    if (p.status === "ACTIVE") return { idempotent: true, permitId, status: "ACTIVE", activatedAt: p.activatedAt };
    if (TERMINAL.has(p.status)) throw new EngineError("permit_not_activatable", 409, { status: p.status });
    const now = this.clock.now();
    if (now > p.activateBy) {
      await this._expire(p, "activation_deadline_passed_on_activation");
      throw new EngineError("permit_expired", 409, { activateBy: p.activateBy });
    }
    const earliestActivation = p.legs[0].enter - ACTIVATION_EARLY_TOLERANCE_MS;
    if (now < earliestActivation) {
      throw new EngineError("activation_before_window", 412, {
        earliestActivation,
        departure: p.legs[0].enter,
        now,
      });
    }
    // 路线上若存在封闭边，禁止带隐患出发；须先由管制员改道（留下修订记录）。
    const closedAhead = p.legs.filter((l) => this.network.isClosed(l.edgeId)).map((l) => l.edgeId);
    if (closedAhead.length) {
      throw new EngineError("route_blocked_by_closure", 412, { closedEdges: closedAhead });
    }
    const check = this.credentials.check(
      { crew: p.crew, vehicle: p.vehicle, wingspan: p.aircraft.wingspan },
      now,
    );
    if (!check.ok) {
      throw new EngineError("credentials_invalid_at_departure", 412, { failures: check.failures, at: now });
    }
    return this._commit("PERMIT_ACTIVATED", { permitId, at: now, by: ctx.by ?? null }, ctx.commandId ?? `activate:${permitId}`);
  }

  reportPosition(permitId, point, ctx = {}) {
    return this._serialize(() => this._reportPosition(permitId, point, ctx));
  }

  async _reportPosition(permitId, point, ctx) {
    const p = this._mustPermit(permitId);
    if (p.status !== "ACTIVE") throw new EngineError("permit_not_active", 409, { status: p.status });
    const at = point.at === undefined ? this.clock.now() : toMs(point.at, "position.at");
    if (!point.node && !point.edgeId) throw new EngineError("position_requires_node_or_edge", 400);
    const onRouteNodes = new Set(p.legs.flatMap((l) => [l.from, l.to]));
    const onRouteEdges = new Set(p.legs.map((l) => l.edgeId));
    if (point.node && !onRouteNodes.has(point.node)) {
      throw new EngineError("position_off_route", 422, { node: point.node, permitId });
    }
    if (point.edgeId && !onRouteEdges.has(point.edgeId)) {
      throw new EngineError("position_off_route", 422, { edgeId: point.edgeId, permitId });
    }
    return this._commit(
      "POSITION_REPORTED",
      { permitId, at, node: point.node ?? null, edgeId: point.edgeId ?? null, phase: point.phase ?? "AT_NODE", note: point.note ?? null },
      ctx.commandId,
    );
  }

  /** 首尾相接交接：当前位置须在可交接节点，接收组留名。 */
  handoff(permitId, input, ctx = {}) {
    return this._serialize(() => this._handoff(permitId, input, ctx));
  }

  async _handoff(permitId, input, ctx) {
    const p = this._mustPermit(permitId);
    if (p.status !== "ACTIVE") throw new EngineError("permit_not_active", 409, { status: p.status });
    const node = input.node ?? p.position?.node;
    if (!node) throw new EngineError("handoff_requires_node", 400);
    if (!this.network.canHandOff(node)) throw new EngineError("node_not_handoff", 422, { node });
    if (p.position?.node && p.position.node !== node) {
      throw new EngineError("handoff_position_mismatch", 409, { reported: p.position.node, requested: node });
    }
    const record = { permitId, at: this.clock.now(), node, fromTeam: input.fromTeam ?? p.crewTeam ?? null, toTeam: input.toTeam, by: input.by ?? ctx.by ?? null, reason: input.reason ?? null };
    if (!record.toTeam) throw new EngineError("handoff_requires_toTeam", 400);
    return this._commit("PERMIT_HANDED_OFF", record, ctx.commandId ?? `handoff:${permitId}:${p.handoffs.length}`);
  }

  /** 管制员封闭路段：返回受影响的未执行/在途许可及安全停靠、改道候选。 */
  closeEdge(edgeId, ctx = {}) {
    return this._serialize(() => this._closeEdge(edgeId, ctx));
  }

  async _closeEdge(edgeId, ctx) {
    this.network.edgeById(edgeId); // 校验存在
    if (this.network.isClosed(edgeId)) {
      return { idempotent: true, edgeId, impact: this.impactOfClosure(edgeId) };
    }
    // 先在派视图上封闭，使改道候选不会再走该边；事件落盘后重放结果一致。
    this.network.closures.set(edgeId, { reason: ctx.reason ?? null, since: this.clock.now(), by: ctx.by ?? null });
    const impact = this.impactOfClosure(edgeId);
    await this._commit(
      "EDGE_CLOSED",
      { edgeId, reason: ctx.reason ?? null, by: ctx.by ?? null, impact },
      ctx.commandId ?? `close:${edgeId}`,
    );
    return { edgeId, closed: true, impact };
  }

  reopenEdge(edgeId, ctx = {}) {
    return this._serialize(async () => {
      if (!this.network.isClosed(edgeId)) return { idempotent: true, edgeId, open: true };
      return this._commit("EDGE_REOPENED", { edgeId, by: ctx.by ?? null }, ctx.commandId ?? `reopen:${edgeId}`);
    });
  }

  /** 计算封闭影响；不修改任何路线（改道须显式命令并留痕）。 */
  impactOfClosure(edgeId) {
    const pending = [];
    const active = [];
    for (const p of this.permits.values()) {
      if (TERMINAL.has(p.status)) continue;
      const idx = p.legs.findIndex((l) => l.edgeId === edgeId);
      if (idx === -1) continue;
      if (p.status === "ISSUED") {
        pending.push({ permitId: p.permitId, requestId: p.requestId, blockedLegIndex: idx, enter: p.legs[idx].enter });
      } else {
        const current = this._currentLegIndex(p);
        if (idx < current) continue; // 封闭边已经通过，不受影响
        const onEdge = p.position?.edgeId === edgeId;
        const stop = onEdge ? null : this._safeStopAhead(p, idx);
        active.push({
          permitId: p.permitId, requestId: p.requestId, blockedLegIndex: idx,
          onEdge,
          advice: onEdge ? "edge_already_entered_continue_to_clear" : "hold_at_safe_stop",
          safeStop: stop,
          rerouteCandidates: stop ? this._rerouteCandidates(p, stop) : [],
        });
      }
    }
    return { edgeId, pending, active };
  }

  /**
   * 改航：仅 ACTIVE 且已抵达安全停靠点时可执行；原路线整段保留于修订链，
   * 日历中只替换尚未完成的预留。
   */
  reroute(permitId, ctx = {}) {
    return this._serialize(() => this._reroute(permitId, ctx));
  }

  async _reroute(permitId, ctx) {
    const p = this._mustPermit(permitId);
    if (p.status !== "ACTIVE" && p.status !== "ISSUED") {
      throw new EngineError("reroute_requires_open_permit", 409, { status: p.status });
    }
    const node = ctx.node ?? (p.status === "ISSUED" ? p.from : p.position?.node);
    if (!node) throw new EngineError("reroute_requires_position", 400);
    if (p.status === "ISSUED" && node !== p.from) {
      throw new EngineError("reroute_issued_requires_origin", 412, { node, origin: p.from });
    }
    const holding = this.network.holdingAt(node);
    if (p.status === "ACTIVE" && !holding.safeHold && node !== p.from) {
      throw new EngineError("reroute_requires_safe_stop", 412, { node });
    }
    let fromLegIndex;
    if (node === p.from) {
      fromLegIndex = 0;
    } else {
      const idx = p.legs.findIndex((l) => l.to === node);
      if (idx < 0) throw new EngineError("position_off_route", 422, { node });
      fromLegIndex = idx + 1;
    }
    const earliest = p.status === "ISSUED"
      ? Math.max(this.clock.now(), p.legs[0].enter)
      : (fromLegIndex === 0 ? this.clock.now() : p.legs[fromLegIndex - 1].exit);
    const plan = this._planFrom(p, node, earliest);
    if (!plan.ok) throw new EngineError("no_feasible_reroute", 422, { code: plan.code, reasons: plan.reasons });
    const now = this.clock.now();
    const completedLegs = p.legs.slice(0, fromLegIndex);
    const amendment = {
      seq: p.amendments.length + 1,
      at: now,
      reason: ctx.reason ?? "controller reroute",
      by: ctx.by ?? null,
      fromNode: node,
      supersedesLegsFrom: fromLegIndex,
      keptLegs: completedLegs,
      oldPath: p.routePath,
      oldLegs: p.legs.slice(fromLegIndex),
      newPath: plan.path,
      newLegs: plan.legs,
    };
    // 日历由 PERMIT_REROUTED 事件的 _apply 统一替换，此处不预先改动。
    return this._commit(
      "PERMIT_REROUTED",
      { permitId, requestId: p.requestId, amendment },
      ctx.commandId ?? `reroute:${permitId}:${p.amendments.length + 1}`,
    );
  }

  _safeStopAhead(permit, blockedLegIndex) {
    // 自在途位置至被封闭边之间，找最近的安全停靠节点（起节点始终可停）。
    const candidates = [];
    for (let i = blockedLegIndex - 1; i >= 0; i -= 1) candidates.push({ node: permit.legs[i].to, legIndex: i });
    candidates.push({ node: permit.from, legIndex: -1 });

    const pos = permit.position;
    let earliestLegIndex; // 候选节点不得早于在途位置（legIndex 为该节点所在航段下标，-1 表示起节点）
    if (pos?.edgeId) {
      const k = permit.legs.findIndex((l) => l.edgeId === pos.edgeId);
      earliestLegIndex = k < 0 ? -Infinity : k; // 当前边尾节点 legs[k].to
    } else if (pos?.node && pos.node !== permit.from) {
      const k = permit.legs.findIndex((l) => l.to === pos.node);
      earliestLegIndex = k < 0 ? -Infinity : k;
    } else {
      earliestLegIndex = -1; // 在起节点或位置未知（按未离场保守处理）
    }
    for (const candidate of candidates) {
      if (candidate.legIndex < earliestLegIndex) continue;
      if (candidate.node === permit.from || this.network.holdingAt(candidate.node).safeHold) return candidate.node;
    }
    return null;
  }

  _currentLegIndex(permit) {
    if (!permit.position) return -1;
    if (permit.position.edgeId) {
      const idx = permit.legs.findIndex((l) => l.edgeId === permit.position.edgeId);
      if (idx >= 0) return idx;
    }
    if (permit.position.node) {
      const idx = permit.legs.findIndex((l) => l.to === permit.position.node);
      if (idx >= 0) return idx + 1; // 已在该节点，下一航段进行中或待发
    }
    return -1;
  }

  _rerouteCandidates(permit, node) {
    const doneIndex = permit.legs.findIndex((l) => l.to === node);
    const eta = doneIndex >= 0 ? permit.legs[doneIndex].exit : this.clock.now();
    const plan = this._planFrom(permit, node, eta);
    if (!plan.ok) return { ok: false, code: plan.code, reasons: plan.reasons };
    return { ok: true, path: plan.path, departure: plan.departure, arrival: plan.arrival, waitMs: plan.waitMs };
  }

  _planFrom(permit, node, earliestMs) {
    return planRoute({
      network: this.network,
      calendar: this.calendar,
      aircraftType: permit.aircraft.type,
      wingspan: permit.aircraft.wingspan,
      from: node,
      to: permit.to,
      windowStart: earliestMs,
      windowEnd: Math.max(permit.activateBy + 6 * 3600_000, earliestMs + 6 * 3600_000),
      legSeconds: permit.legSeconds ?? {},
      separationMs: permit.separationMs,
      selfPermitId: permit.permitId,
    });
  }

  cancel(permitId, ctx = {}) {
    return this._serialize(() => this._cancel(permitId, ctx));
  }

  async _cancel(permitId, ctx) {
    const p = this.permits.get(permitId);
    if (!p) throw new EngineError("permit_unknown", 404, { permitId });
    if (p.status === "CANCELLED") return { idempotent: true, permitId, status: "CANCELLED" };
    if (p.status === "COMPLETED" || p.status === "EXPIRED") {
      return { idempotent: true, permitId, status: p.status };
    }
    if (p.status === "ACTIVE") {
      const node = ctx.node ?? p.position?.node;
      if (!node) throw new EngineError("cancel_active_requires_stop", 412);
      if (!this.network.holdingAt(node).safeHold && node !== p.from && node !== p.to) {
        throw new EngineError("cancel_requires_safe_stop", 412, { node });
      }
    }
    return this._commit(
      "PERMIT_CANCELLED",
      { permitId, requestId: p.requestId, at: this.clock.now(), reason: ctx.reason ?? null, by: ctx.by ?? null, node: ctx.node ?? p.position?.node ?? null },
      ctx.commandId ?? `cancel:${permitId}`,
    );
  }

  complete(permitId, ctx = {}) {
    return this._serialize(() => this._complete(permitId, ctx));
  }

  async _complete(permitId, ctx) {
    const p = this.permits.get(permitId);
    if (!p) throw new EngineError("permit_unknown", 404, { permitId });
    if (p.status === "COMPLETED") return { idempotent: true, permitId, status: "COMPLETED" };
    if (TERMINAL.has(p.status)) return { idempotent: true, permitId, status: p.status };
    if (p.status !== "ACTIVE") throw new EngineError("complete_requires_active", 409, { status: p.status });
    if (p.position?.node !== p.to) {
      throw new EngineError("complete_position_mismatch", 409, { reported: p.position?.node ?? null, destination: p.to });
    }
    return this._commit(
      "PERMIT_COMPLETED",
      { permitId, requestId: p.requestId, at: ctx.at ?? this.clock.now(), by: ctx.by ?? null },
      ctx.commandId ?? `complete:${permitId}`,
    );
  }

  /** 过期扫描：待激活且超过 activateBy 的许可自动释放（幂等）。 */
  sweepExpired() {
    return this._serialize(() => this._sweepExpired());
  }

  async _sweepExpired() {
    const now = this.clock.now();
    const expired = [];
    for (const p of this.permits.values()) {
      if (p.status === "ISSUED" && p.activateBy <= now) expired.push(p);
    }
    for (const p of expired) {
      await this._expire(p, "activation_deadline_passed");
    }
    return expired.map((p) => p.permitId);
  }

  async _expire(p, reason) {
    if (p.status !== "ISSUED") return { idempotent: true, permitId: p.permitId, status: p.status };
    return this._commit("PERMIT_EXPIRED", { permitId: p.permitId, requestId: p.requestId, at: this.clock.now(), reason });
  }

  // ====================== 查询 ======================

  timeline(permitId) {
    const p = this._mustPermit(permitId);
    return {
      permitId,
      requestId: p.requestId,
      status: p.status,
      aircraft: p.aircraft,
      issuedAt: iso(p.issuedAt),
      activateBy: iso(p.activateBy),
      activatedAt: iso(p.activatedAt),
      closedAt: iso(p.closedAt),
      route: {
        path: p.routePath,
        legs: p.legs.map((l) => legView(l)),
      },
      originalRoute: { path: p.originalPath, legs: p.originalLegs.map((l) => legView(l)) },
      amendments: p.amendments.map((a) => ({
        seq: a.seq, at: iso(a.at), reason: a.reason, by: a.by, fromNode: a.fromNode,
        oldPath: a.oldPath, newPath: a.newPath,
      })),
      waits: p.legs.filter((l) => l.waitedMsBefore > 0).map((l) => ({
        edgeId: l.edgeId,
        at: iso(l.enter - l.waitedMsBefore),
        waitSeconds: Math.round(l.waitedMsBefore / 1000),
      })),
      positions: p.positions.map((pt) => ({ ...pt, at: iso(pt.at) })),
      handoffs: p.handoffs.map((h) => ({ ...h, at: iso(h.at) })),
      manualReleases: (p.manualReleases ?? []).map((r) => ({ ...r, at: iso(r.at), otherEnter: iso(r.otherEnter), window: r.window?.map(iso), plannedWindow: r.plannedWindow?.map(iso), required: r.required ? Math.round(r.required / 1000) + "s" : undefined })),
      closeReason: p.closeReason,
    };
  }

  calendarView({ from, to } = {}) {
    const now = this.clock.now();
    const f = from ?? now - 3600_000;
    const t = to ?? now + 12 * 3600_000;
    return this.calendar.all()
      .filter((e) => e.start < t && e.end > f)
      .map((e) => ({ type: e.type, resource: e.id, from: iso(e.start), to: iso(e.end), permitId: e.permitId, separationSeconds: e.separation ? e.separation / 1000 : undefined }));
  }

  listPermits() {
    return [...this.permits.values()].map((p) => ({
      permitId: p.permitId, requestId: p.requestId, status: p.status,
      aircraft: p.aircraft.id, type: p.aircraft.type, from: p.from, to: p.to,
      activateBy: iso(p.activateBy), activatedAt: iso(p.activatedAt),
    }));
  }
}

function legView(l) {
  return {
    edgeId: l.edgeId, from: l.from, to: l.to, channel: l.channel, zone: l.zone,
    enter: iso(l.enter), exit: iso(l.exit), durationSeconds: Math.round(l.durationMs / 1000),
    waitedSecondsBefore: Math.round(l.waitedMsBefore / 1000),
  };
}

function iso(v) {
  return v === undefined || v === null ? null : toIso(v);
}

function summarize(data) {
  if (data.permit) return { permitId: data.permit.permitId };
  return data;
}

function normalizeRequest(raw, network) {
  if (!raw.requestId) throw new EngineError("request_id_required", 400);
  if (!raw.aircraft?.type) throw new EngineError("aircraft_type_required", 400);
  if (!raw.from || !raw.to) throw new EngineError("endpoints_required", 400);
  if (!Array.isArray(raw.crew) || raw.crew.length === 0) throw new EngineError("crew_required", 400);
  if (!raw.vehicle) throw new EngineError("vehicle_required", 400);
  const start = toMs(raw.window?.start ?? raw.desiredAt, "window.start");
  const windowSeconds = raw.window?.seconds ?? 3600;
  const wingspan = raw.aircraft.wingspan ?? defaultWingspan(raw.aircraft.type);
  const request = {
    requestId: raw.requestId,
    aircraft: { id: raw.aircraft.id ?? raw.requestId, type: raw.aircraft.type, wingspan },
    crew: raw.crew,
    vehicle: raw.vehicle,
    from: raw.from,
    to: raw.to,
    windowStart: start,
    windowEnd: raw.window?.end ? toMs(raw.window.end, "window.end") : start + windowSeconds * 1000,
    legSeconds: raw.legSeconds ?? {},
    separationMs: (raw.intersectionSeparationSeconds ?? 60) * 1000,
    activateGraceMs: (raw.activateGraceSeconds ?? 600) * 1000,
    notes: raw.notes ?? null,
  };
  if (!network.nodes.has(request.from)) throw new EngineError("origin_unknown", 404, { from: request.from });
  if (!network.nodes.has(request.to)) throw new EngineError("destination_unknown", 404, { to: request.to });
  return request;
}

function defaultWingspan(type) {
  const map = { ATR72: "B", A320: "C", A321: "C", B737: "C", B738: "C", B757: "D", B767: "D", A330: "E", B777: "E", B747: "E", A380: "F" };
  return map[type] ?? "C";
}

export class EngineError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
