// 机坪道路网络：有向路段 + 共享交叉区 + 机型通行限制 + 机位/停靠点容量。
//
// 数据形态见 fixtures/airport.json。路段是原子的：一旦牵引组进入某条边，
// 必须以该机型的通过耗时完整驶出（中途不能停在窄口里）。
// 交叉区是若干路段共享的资源；不同许可使用同一交叉区之间须满足安全间隔。
// 节点可声明容量（机位 bay/等待点），同一时刻停放的拖行组不能超容。

export class Airport {
  constructor(data = {}) {
    this.id = data.id ?? "airport";
    this.timeZone = data.timeZone ?? "Asia/Shanghai";
    this.defaultSeparationMs = (data.defaultIntersectionSeparationSeconds ?? 60) * 1000;
    this.edgeIndex = new Map();
    this.adjacency = new Map(); // node -> [{edge}]
    this.nodeInfo = new Map();

    for (const n of data.nodes ?? []) {
      this.nodeInfo.set(n.id, {
        id: n.id,
        kind: n.kind ?? "junction", // stand | bay | junction
        capacity: n.capacity ?? (n.kind === "stand" || n.kind === "bay" ? 1 : Infinity),
      });
    }
    for (const e of data.edges ?? []) {
      const edge = {
        id: e.id ?? `${e.from}->${e.to}`,
        from: e.from,
        to: e.to,
        seconds: e.seconds,
        typesAllowed: new Set(e.aircraftTypes ?? e.typesAllowed ?? null),
        widthClass: e.widthClass ?? "narrow",
        notes: e.notes ?? "",
      };
      if (this.edgeIndex.has(edge.id)) throw new Error(`重复路段: ${edge.id}`);
      this.edgeIndex.set(edge.id, edge);
      if (!this.adjacency.has(edge.from)) this.adjacency.set(edge.from, []);
      this.adjacency.get(edge.from).push(edge);
      for (const nodeId of [edge.from, edge.to]) {
        if (!this.nodeInfo.has(nodeId)) this.nodeInfo.set(nodeId, { id: nodeId, kind: "junction", capacity: Infinity });
      }
    }

    // conflictZone 声明在边上（沿用 fixture 形态）；zone 也可在 data.zones 里给别名。
    this.edgeZone = new Map();
    this.zones = new Map();
    for (const e of data.edges ?? []) {
      if (e.conflictZone) this.edgeZone.set(e.id ?? `${e.from}->${e.to}`, e.conflictZone);
    }
    for (const z of data.zones ?? []) {
      this.zones.set(z.id, {
        id: z.id,
        separationMs: (z.separationSeconds ?? this.defaultSeparationMs / 1000) * 1000,
      });
    }
  }

  edge(id) { return this.edgeIndex.get(id); }
  zoneOf(edgeId) { return this.edgeZone.get(edgeId) ?? null; }

  separationFor(zoneId, fallbackSeconds) {
    const z = this.zones.get(zoneId);
    if (z) return z.separationMs;
    return Math.round((fallbackSeconds ?? this.defaultSeparationMs / 1000) * 1000);
  }

  node(id) { return this.nodeInfo.get(id); }

  // 机型是否允许使用该路段；null 白名单表示不限。
  typeAllowed(edgeId, aircraftType) {
    const e = this.edgeIndex.get(edgeId);
    if (!e) return { ok: false, reason: `路段不存在: ${edgeId}` };
    if (e.typesAllowed.size && !e.typesAllowed.has(aircraftType)) {
      return { ok: false, reason: `机型 ${aircraftType} 不在 ${edgeId} 允许列表 [${[...e.typesAllowed].join(",")}]` };
    }
    return { ok: true };
  }

  outgoing(nodeId) { return this.adjacency.get(nodeId) ?? []; }

  // 无环有向路径枚举（真实机坪路网的环用“去重访问节点”剪枝即可，环路重复访问
  // 在一次拖行中没有意义）。带逐边过滤，用于规划与改道候选。
  *paths(from, to, acceptEdge = () => true, maxPaths = 200) {
    const yielded = [];
    const stack = [{ node: from, path: [] }];
    while (stack.length) {
      const { node, path } = stack.pop();
      if (node === to) { yielded.push(path); yield path; if (yielded.length >= maxPaths) return; continue; }
      if (path.length > 64) continue;
      const visited = new Set(path.map((e) => e.to));
      visited.add(from);
      for (const e of this.outgoing(node)) {
        if (visited.has(e.to)) continue;
        if (!acceptEdge(e)) continue;
        stack.push({ node: e.to, path: [...path, e] });
      }
    }
  }
}
