// 可执行路线搜索：在有向图上枚举候选路径，再对每条路径做前向时空可行性推演。
//
// 等待策略（关键安全约束）：只有起节点与标注为安全停靠点的节点允许等待让行；
// 进入路段后必须按预计耗时连续通过，因此窄口内无法临时避让——这一时序在
// calendar.earliestFeasible 中通过 canWait=false 强制。

const MAX_PATHS = 64;

export function planRoute({
  network,
  calendar,
  aircraftType,
  wingspan,
  from,
  to,
  windowStart,
  windowEnd,
  legSeconds = {},
  separationMs = 0,
  selfPermitId = null,
}) {
  if (!network.nodes.has(from)) return { ok: false, code: "origin_unknown", attempts: [], reasons: [] };
  if (!network.nodes.has(to)) return { ok: false, code: "destination_unknown", attempts: [], reasons: [] };

  const paths = enumeratePaths(network, from, to, aircraftType, wingspan);
  if (paths.length === 0) {
    return {
      ok: false,
      code: "no_structural_route",
      attempts: [],
      reasons: explainStructural(network, from, to, aircraftType, wingspan),
    };
  }

  const attempts = [];
  let best = null;
  for (const path of paths.slice(0, MAX_PATHS)) {
    const attempt = simulate({
      network,
      calendar,
      path,
      aircraftType,
      wingspan,
      earliest: windowStart,
      windowEnd,
      legSeconds,
      separationMs,
      selfPermitId,
    });
    attempts.push(attempt);
    if (attempt.ok && (!best || attempt.arrival < best.arrival)) best = attempt;
  }

  if (best) {
    return {
      ok: true,
      path: best.path,
      legs: best.legs,
      departure: best.legs[0].enter,
      arrival: best.arrival,
      waitMs: best.waitMs,
      attemptsConsidered: attempts.length,
      attempts,
    };
  }
  return {
    ok: false,
    code: "no_temporal_route",
    attempts,
    reasons: aggregateReasons(attempts),
  };
}

/** 深度优先枚举简单路径，结构上即按机型/翼展/封闭过滤，按标称耗时排序。 */
function enumeratePaths(network, from, to, aircraftType, wingspan) {
  const results = [];
  const visit = (node, stack, seconds) => {
    if (results.length >= MAX_PATHS) return;
    if (node === to) {
      results.push({ edges: [...stack], seconds });
      return;
    }
    const options = network.outgoing(node, aircraftType, wingspan);
    options.sort((a, b) => nominal(network, a, seconds) - nominal(network, b, seconds));
    for (const edge of options) {
      if (stack.some((e) => e.from === edge.to || e.to === edge.to)) continue; // 简单路径
      stack.push(edge);
      visit(edge.to, stack, seconds + edge.seconds);
      stack.pop();
      if (results.length >= MAX_PATHS) return;
    }
  };
  visit(from, [], 0);
  results.sort((a, b) => a.seconds - b.seconds);
  return results.map((r) => r.edges);
}

function nominal(network, edge, acc) {
  return acc + edge.seconds;
}

function legDuration(edge, legSeconds) {
  const key = edge.id;
  const alt = `${edge.from}->${edge.to}`;
  const value = legSeconds[key] ?? legSeconds[alt] ?? edge.seconds;
  return value * 1000;
}

function simulate({
  network,
  calendar,
  path,
  earliest,
  windowEnd,
  legSeconds,
  separationMs,
  selfPermitId,
}) {
  // 在每个可停靠节点（起节点/安全停靠点）记录“最早可离开时刻”。
  // 当后续窄口冲突且当前节点不能等待时，把所需延误回溯注入最近的停靠节点后重推。
  const holdAt = path.map((edge, i) => {
    const node = edge.from;
    return i === 0 || network.holdingAt(node).safeHold;
  });
  const departures = path.map((_, i) => (i === 0 ? earliest : null));
  const blockersSeen = [];

  for (let round = 0; round < 64; round += 1) {
    const legs = [];
    let t = earliest;
    let waitMs = 0;
    let failure = null;
    for (let i = 0; i < path.length; i += 1) {
      const edge = path[i];
      const arrivalAtNode = t;
      if (departures[i] !== null && departures[i] > t) t = departures[i];
      const duration = legDuration(edge, legSeconds);
      const decision = calendar.earliestFeasible(
        edge,
        t,
        windowEnd,
        duration,
        separationMs,
        holdAt[i],
        selfPermitId,
      );
      if (!decision.ok) {
        failure = { index: i, edge, decision, node: edge.from, reached: legs[i - 1]?.to ?? path[0].from };
        break;
      }
      waitMs += decision.enter - arrivalAtNode;
      legs.push({
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        channel: edge.channel,
        zone: edge.zone,
        enter: decision.enter,
        exit: decision.exit,
        durationMs: duration,
        waitedMsBefore: decision.enter - arrivalAtNode,
        separation: separationMs,
      });
      t = decision.exit;
    }
    if (!failure) return { ok: true, path: path.map((e) => e.id), legs, arrival: t, waitMs };

    blockersSeen.push({
      failedEdge: failure.edge.id,
      reached: failure.reached,
      reason: failure.decision.reason,
      blockers: failure.decision.blockers,
    });

    if (failure.decision.reason === "window_exceeded") {
      return {
        ok: false, path: path.map((e) => e.id), reached: failure.reached,
        failedEdge: failure.edge.id, reason: "window_exceeded", blockers: blockersSeen, legs: [],
      };
    }

    // 回溯：找到失败航段之前最近的可停靠节点，把延误上提到该处错峰发车。
    let hold = -1;
    for (let j = failure.index; j >= 0; j -= 1) {
      if (holdAt[j]) { hold = j; break; }
    }
    if (hold === -1) {
      return {
        ok: false, path: path.map((e) => e.id), reached: failure.reached,
        failedEdge: failure.edge.id, reason: failure.decision.reason, blockers: blockersSeen, legs: [],
      };
    }

    // 失败航段必须晚于：冲突占用结束 / 交叉区对方进入时刻 + 安全间隔。
    const last = failure.decision.blockers[failure.decision.blockers.length - 1] ?? {};
    let conflictClear = failure.decision.enter;
    if (last.edge) conflictClear = Math.max(conflictClear, last.edge.until);
    if (last.channel) conflictClear = Math.max(conflictClear, last.channel.until);
    if (last.zone) conflictClear = Math.max(conflictClear, last.zone.otherEnter + last.zone.required);
    // hold 与失败航段之间各边均不可等待（首个失败前无冲突），故为自由流行程时间。
    const freeFlowMs = durationBetween(path, hold, failure.index, legSeconds);
    const mustDepartHold = conflictClear - freeFlowMs;
    const arrivalAtHold = earliest + durationBetween(path, 0, hold, legSeconds);
    const currentDepart = Math.max(departures[hold] ?? arrivalAtHold, arrivalAtHold);
    if (mustDepartHold <= currentDepart) {
      return {
        ok: false, path: path.map((e) => e.id), reached: failure.reached,
        failedEdge: failure.edge.id, reason: failure.decision.reason, blockers: blockersSeen, legs: [],
      };
    }
    departures[hold] = mustDepartHold;
    for (let j = hold + 1; j < path.length; j += 1) departures[j] = null;
  }
  return { ok: false, path: path.map((e) => e.id), reason: "search_limit", blockers: blockersSeen, legs: [] };
}

function durationBetween(path, fromIndex, toIndex, legSeconds) {
  let total = 0;
  for (let i = fromIndex; i < toIndex; i += 1) total += legDuration(path[i], legSeconds);
  return total;
}

/** 汇总各次推演失败，给出管制员可读的“为什么无路可走”。 */
function aggregateReasons(attempts) {
  const tally = new Map();
  for (const attempt of attempts) {
    if (attempt.ok) continue;
    const last = attempt.blockers?.[attempt.blockers.length - 1];
    const parts = [];
    if (last?.edge) parts.push(`edge_busy:${last.edge.permitId}`);
    if (last?.channel) parts.push(`channel_busy:${last.channel.id}:${last.channel.permitId}`);
    if (last?.zone) parts.push(`zone_separation:${last.zone.id}:${last.zone.permitId}`);
    const key = parts.length ? parts.join("|") : attempt.reason;
    const entry = tally.get(key) ?? { key, count: 0, example: attempt };
    entry.count += 1;
    tally.set(key, entry);
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ key, count, example }) => ({
      constraint: key,
      affectedPaths: count,
      failedEdge: example.failedEdge,
      reached: example.reached,
      detail: example.blockers?.[example.blockers.length - 1] ?? null,
    }));
}

function explainStructural(network, from, to, aircraftType, wingspan) {
  const reasons = [];
  for (const edge of network.edges.values()) {
    const reachable = reachableFrom(network, from).has(edge.from);
    if (!reachable) continue;
    if (network.isClosed(edge.id)) reasons.push({ constraint: `edge_closed:${edge.id}`, failedEdge: edge.id });
    if (edge.aircraftTypes && !edge.aircraftTypes.has(aircraftType)) {
      reasons.push({ constraint: `aircraft_type_forbidden:${edge.id}`, failedEdge: edge.id });
    }
    if (WINGSPAN_INDEX(wingspan) > WINGSPAN_INDEX(edge.maxWingspan)) {
      reasons.push({ constraint: `wingspan_exceeded:${edge.id}`, failedEdge: edge.id });
    }
  }
  if (!reachableFrom(network, from).has(to)) {
    reasons.push({ constraint: `destination_unreachable:${to}`, failedEdge: null });
  }
  return dedupe(reasons);
}

function WINGSPAN_INDEX(level) {
  return ["A", "B", "C", "D", "E", "F"].indexOf(level);
}

function reachableFrom(network, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const edge of network.edges.values()) {
      if (edge.from !== node || network.isClosed(edge.id)) continue;
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.constraint;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
