// 时空规划器。
//
// 规则：
// 1. 路径是有向路段序列，机型白名单在枚举前过滤；封闭是动态约束（会给出解封时刻）。
// 2. 路径按“可等待点”（机位/等待坪/起点/终点）切成刚性区块，区块内部全是
//    不可等待的交叉口/窄口：整段区块以固定偏移一次性排进时空槽位，
//    让行等待只能发生在区块入口的可等待点 —— 禁止在交叉口内停车等让。
// 3. 同一路段区间互斥（端点相接允许交接）；同一交叉区两次通过时刻须满足安全间隔；
//    可等待点有容量，让行等待本身也要占容量。
// 4. 超过期望出发窗口（latestStart）判不可行，并保留每条候选路径的被否原因。

const MAX_ITERS = 2000;

function waitable(airport, nodeId) {
  const n = airport.node(nodeId);
  return n && Number.isFinite(n.capacity); // stand/bay/显式声明容量的等待点
}

function durationFor(edge, request) {
  const override = request.segmentSeconds?.[edge.id];
  return Math.round((typeof override === "number" ? override : edge.seconds) * 1000);
}

// 枚举机型可用的有向路径，附带静态淘汰统计。
export function enumeratePaths(airport, request) {
  const candidates = [];
  const rejectedEdges = new Map();
  for (const path of airport.paths(request.from, request.to, (e) => {
    const chk = airport.typeAllowed(e.id, request.aircraft.type);
    if (!chk.ok) {
      rejectedEdges.set(e.id, chk.reason);
      return false;
    }
    return true;
  })) {
    candidates.push(path);
  }
  return { candidates, rejectedEdges: [...rejectedEdges.entries()].map(([edgeId, reason]) => ({ edgeId, reason })) };
}

function buildBlocks(airport, path, request) {
  const blocks = [];
  let current = { entryNode: path[0].from, segments: [], offsets: new Map() };
  let offset = 0;
  for (let i = 0; i < path.length; i++) {
    const edge = path[i];
    const dur = durationFor(edge, request);
    const zoneId = airport.zoneOf(edge.id);
    current.segments.push({
      edgeId: edge.id, from: edge.from, to: edge.to,
      enterOff: offset, exitOff: offset + dur, dur,
      zoneId,
    });
    offset += dur;
    const atNode = edge.to;
    const isLast = i === path.length - 1;
    if (!isLast && waitable(airport, atNode)) {
      blocks.push(current);
      current = { entryNode: atNode, segments: [], offsets: new Map() };
      offset = 0;
    }
  }
  blocks.push(current);
  return blocks;
}

// 在不早于 earliest 的前提下，为一个刚性区块寻找可整体放入的起点 T。
function scheduleBlock(airport, calendar, block, earliestInput, ctx) {
  const sepFallback = ctx.separationSeconds;
  let earliest = earliestInput;
  let T = earliest;
  const cap = airport.node(block.entryNode)?.capacity ?? Infinity;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let bumpTo = null;
    let blocker = null;

    if (!ctx.ignoreOccupancy) {
      for (const seg of block.segments) {
        const s = T + seg.enterOff;
        const e = T + seg.exitOff;
        const ec = calendar.edgeConflict(seg.edgeId, s, e, ctx.excludePermId);
        if (ec) {
          blocker = ec;
          bumpTo = ec.kind === "closure" ? ec.until - seg.enterOff : ec.e - seg.enterOff;
          break;
        }
        if (seg.zoneId) {
          const sep = airport.separationFor(seg.zoneId, sepFallback);
          const zc = calendar.zoneConflict(seg.zoneId, s, e, sep, ctx.excludePermId);
          if (zc) {
            blocker = zc;
            bumpTo = zc.kind === "zoneClosure" ? zc.until - seg.enterOff
              : zc.e + sep - seg.enterOff;
            break;
          }
        }
      }
    } else {
      // 人工放行：占用冲突由签字管制员承担，路段/交叉区封闭区间与通过区间相交仍强制。
      for (const seg of block.segments) {
        const s = T + seg.enterOff;
        const e = T + seg.exitOff;
        const c = calendar.closedEdges.get(seg.edgeId);
        if (c && s < c.until && e > c.from) {
          blocker = { kind: "closure", edgeId: seg.edgeId, until: c.until };
          bumpTo = Number.isFinite(c.until) ? c.until - seg.enterOff : Infinity;
          break;
        }
        if (seg.zoneId) {
          const zc = calendar.closedZones.get(seg.zoneId);
          if (zc && s < zc.until && e > zc.from) {
            blocker = { kind: "zoneClosure", zoneId: seg.zoneId, until: zc.until };
            bumpTo = Number.isFinite(zc.until) ? zc.until - seg.enterOff : Infinity;
            break;
          }
        }
      }
    }

    if (bumpTo === null) {
      // 区块入口的让行等待也要占机位/等待点容量。
      if (!ctx.ignoreOccupancy && T > earliest) {
        const bc = calendar.berthConflict(block.entryNode, earliest, T, cap, ctx.excludePermId);
        if (bc) { earliest = bc.e; T = Math.max(T, earliest); continue; }
      }
      return { ok: true, T, waitFrom: earliest };
    }

    if (!Number.isFinite(bumpTo)) {
      return { ok: false, reason: blocker.kind === "closure" || blocker.kind === "zoneClosure"
        ? `${blocker.edgeId ?? blocker.zoneId} 已封闭且未给出解封时刻`
        : "需要的等待时刻超出时间范围", blocker };
    }
    if (bumpTo <= T) bumpTo = T + 1000; // 防御性步进
    T = bumpTo;
    if (ctx.latestStart && T > ctx.latestStart) {
      return { ok: false, reason: `最早可出发时刻 ${new Date(T).toISOString()} 晚于窗口截止 ${new Date(ctx.latestStart).toISOString()}`, blocker };
    }
  }
  return { ok: false, reason: "调度迭代超过上限（资源队列异常）", blocker: null };
}

// 评估单条路径，返回可行计划或带 blocker 的不可行解释。
export function evaluatePath(airport, calendar, path, request, ctx) {
  const blocks = buildBlocks(airport, path, request);
  const steps = [];
  const holds = [];
  let cursor = ctx.earliest;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const isLast = bi === blocks.length - 1;
    const blockStart = cursor;
    let res;
    for (;;) {
      res = scheduleBlock(airport, calendar, block, cursor, { ...ctx, firstBlock: bi === 0 });
      if (!res.ok) break;
      if (isLast) {
        // 终点停靠（机位交接/完成前的占用）也要满足终点容量；
        // 冲突时把整个刚性区块顺延到“到达时刻恰好不早于占用者离开”。
        const blockLen = block.segments.at(-1).exitOff;
        const arrival0 = res.T + blockLen;
        const dwellMs0 = (request.destinationDwellSeconds ?? ctx.defaultDwellSeconds ?? 1800) * 1000;
        const destCap = airport.node(request.to)?.capacity ?? Infinity;
        const bc = calendar.berthConflict(request.to, arrival0, arrival0 + dwellMs0, destCap, ctx.excludePermId);
        if (bc) { cursor = Math.max(cursor, bc.e - blockLen); continue; }
      }
      break;
    }
    if (!res.ok) {
      const seg0 = block.segments[0];
      return {
        feasible: false,
        path: path.map((e) => e.id),
        reason: res.reason,
        blocker: res.blocker,
        atNode: block.entryNode,
        nearEdge: seg0.edgeId,
      };
    }
    if (res.T > blockStart) {
      holds.push({ nodeId: block.entryNode, s: blockStart, e: res.T, reason: bi === 0 ? "window/queue-wait at origin" : "hold short of conflict" });
    }
    for (const seg of block.segments) {
      const enterAt = res.T + seg.enterOff;
      const exitAt = res.T + seg.exitOff;
      steps.push({
        edgeId: seg.edgeId, from: seg.from, to: seg.to,
        enterAt, exitAt, plannedSeconds: seg.dur / 1000,
        zoneId: seg.zoneId,
      });
    }
    cursor = res.T + block.segments.at(-1).exitOff; // 到达下一可等待点
  }

  const arrival = steps.at(-1).exitAt;
  const dwellMs = (request.destinationDwellSeconds ?? ctx.defaultDwellSeconds ?? 1800) * 1000;
  holds.push({ nodeId: request.to, s: arrival, e: arrival + dwellMs, reason: "destination dwell until handover/complete" });

  return {
    feasible: true,
    plan: {
      edgeIds: path.map((e) => e.id),
      steps,
      holds,
      startAt: steps[0].enterAt,
      endAt: arrival,
      durationSeconds: (arrival - steps[0].enterAt) / 1000,
      waitSeconds: holds.filter((h) => h.reason !== "destination dwell").reduce((a, h) => a + (h.e - h.s), 0) / 1000,
    },
  };
}

// 主入口：解释所有路径为何可行/不可行，返回按到达时刻排序的可行方案。
export function plan(airport, calendar, request, opts = {}) {
  const now = opts.now ?? Date.now();
  const earliest = Math.max(request.desiredStart ?? now, now, opts.earliest ?? 0);
  const latestStart = request.latestStart ?? null;
  const ctx = {
    earliest,
    latestStart,
    separationSeconds: request.intersectionSeparationSeconds ?? airport.defaultSeparationMs / 1000,
    excludePermId: opts.excludePermId ?? null,
    ignoreOccupancy: opts.ignoreOccupancy ?? false,
    defaultDwellSeconds: opts.defaultDwellSeconds ?? 1800,
  };

  const { candidates, rejectedEdges } = enumeratePaths(airport, request);
  const evaluations = candidates.map((p) => evaluatePath(airport, calendar, p, request, ctx));
  const feasible = evaluations.filter((e) => e.feasible).map((e) => e.plan)
    .sort((a, b) => a.endAt - b.endAt || a.waitSeconds - b.waitSeconds);

  return {
    feasible: feasible.length > 0,
    plans: feasible,
    best: feasible[0] ?? null,
    evaluated: evaluations.map((e) => e.feasible
      ? { path: e.plan.edgeIds, feasible: true, endAt: e.plan.endAt }
      : { path: e.path, feasible: false, reason: e.reason, blocker: e.blocker, atNode: e.atNode, nearEdge: e.nearEdge }),
    rejectedEdges,
    searchedAt: now,
    earliest,
    latestStart,
  };
}
