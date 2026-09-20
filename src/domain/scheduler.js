// 时空资源日历。
//
// 三类资源，全部以许可为单位预留：
//   edge    有向路段的独占通过窗 [enter, exit)
//   channel 物理通道：共线/反向 edge 共享同一 channel，用于防止窄口相会
//   zone    交叉区进入时刻点；两次进入之间必须保持安全间隔（毫秒）
//
// 日历是可由事件日志重建的派生状态：重启后逐条重放 PERMIT_ISSUED /
// PERMIT_REROUTED / 终态事件即可恢复，不依赖额外存储。

export class Calendar {
  constructor() {
    /** @type {Array<{type:string,id:string,start:number,end:number,permitId:string,separation?:number,kind?:string}>} */
    this.entries = [];
  }

  add(entry) {
    const pos = this.entries.findIndex(
      (e) => e.start > entry.start || (e.start === entry.start && e.end > entry.end),
    );
    if (pos === -1) this.entries.push(entry);
    else this.entries.splice(pos, 0, entry);
  }

  /** 返回与 [start,end) 严格重叠的 edge/channel 占用（不含本许可）。 */
  overlapping(type, id, start, end, selfPermitId = null) {
    return this.entries.filter(
      (e) =>
        e.type === type &&
        e.id === id &&
        e.permitId !== selfPermitId &&
        e.start < end &&
        start < e.end,
    );
  }

  /**
   * 交叉区进入冲突：与其他进入时刻间隔不足。
   * 间隔要求取双方许可安全间隔的最大值（对称约束）。
   */
  zoneBlockers(zoneId, enterMs, separationMs, selfPermitId = null) {
    const blockers = [];
    for (const e of this.entries) {
      if (e.type !== "zone" || e.id !== zoneId || e.permitId === selfPermitId) continue;
      const required = Math.max(separationMs, e.separation ?? 0);
      if (Math.abs(e.start - enterMs) < required) blockers.push({ entry: e, required });
    }
    return blockers;
  }

  /**
   * 计算某条边最早可行进入时刻。
   * @param {object} leg 网络 edge（含 id/channel/zone/seconds）
   * @param {number} earliest 最早可进入时刻（到达节点时刻）
   * @param {number} latestExit 最迟必须离开该边的时刻
   * @param {number} durationMs 本机组预计通过耗时
   * @param {number} separationMs 交叉区安全间隔
   * @param {boolean} canWait 当前节点是否允许等待（仅起节点与安全停靠点允许）
   */
  earliestFeasible(leg, earliest, latestExit, durationMs, separationMs, canWait, selfPermitId = null) {
    let enter = earliest;
    const blockers = [];
    for (let guard = 0; guard < 64; guard += 1) {
      const exit = enter + durationMs;
      const edgeHits = this.overlapping("edge", leg.id, enter, exit, selfPermitId);
      const channelHits = this.overlapping("channel", leg.channel, enter, exit, selfPermitId);
      const zoneHits = leg.zone
        ? this.zoneBlockers(leg.zone, enter, separationMs, selfPermitId)
        : [];
      const hit = edgeHits[0] || channelHits[0] || zoneHits[0]?.entry;
      if (!hit) {
        if (exit > latestExit) {
          return { ok: false, reason: "window_exceeded", enter, exit, blockers };
        }
        return { ok: true, enter, exit, blockers };
      }
      blockers.push({
        edge: edgeHits[0] ? { permitId: edgeHits[0].permitId, until: edgeHits[0].end } : null,
        channel: channelHits[0]
          ? { id: leg.channel, permitId: channelHits[0].permitId, until: channelHits[0].end }
          : null,
        zone: zoneHits[0]
          ? {
              id: leg.zone,
              permitId: zoneHits[0].entry.permitId,
              otherEnter: zoneHits[0].entry.start,
              required: zoneHits[0].required,
            }
          : null,
      });
      if (!canWait) {
        return { ok: false, reason: "conflict_without_holding", enter, blockers };
      }
      // 跳到冲突释放之后：通道/路段取占用结束；交叉区取对方进入时刻 + 要求间隔。
      let next = enter;
      if (edgeHits[0]) next = Math.max(next, edgeHits[0].end);
      if (channelHits[0]) next = Math.max(next, channelHits[0].end);
      for (const z of zoneHits) next = Math.max(next, z.entry.start + z.required);
      if (next <= enter) next = enter + 1000;
      enter = next;
    }
    return { ok: false, reason: "search_limit", enter, blockers };
  }

  reserveLeg(permitId, leg, kind = "PLANNED") {
    this.add({
      type: "edge",
      id: leg.edgeId,
      start: leg.enter,
      end: leg.exit,
      permitId,
      kind,
    });
    this.add({
      type: "channel",
      id: leg.channel,
      start: leg.enter,
      end: leg.exit,
      permitId,
      kind,
    });
    if (leg.zone) {
      this.add({
        type: "zone",
        id: leg.zone,
        start: leg.enter,
        end: leg.enter + 1,
        permitId,
        separation: leg.separation,
        kind,
      });
    }
  }

  releasePermit(permitId) {
    this.entries = this.entries.filter((e) => e.permitId !== permitId);
  }

  /** 重跑改航：用新航段替换该许可的未来预留。 */
  replacePermitLegs(permitId, legs) {
    this.releasePermit(permitId);
    for (const leg of legs) this.reserveLeg(permitId, leg);
  }

  window(type, id, from, to) {
    return this.entries.filter(
      (e) => e.type === type && (!id || e.id === id) && e.start < to && e.end > from,
    );
  }

  all() {
    return [...this.entries];
  }
}
