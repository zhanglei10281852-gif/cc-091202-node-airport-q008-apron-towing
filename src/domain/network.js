// 机场道路资料模型：有向路段、共享交叉区、机型通行限制、可交接节点、封闭状态。
//
// 一条 edge 的占用分为两层：
//   1. 物理通道 channel —— 不同 edge 若共用一条窄道（互为反向或共线），
//      在同一时间窗内互斥，解决“两架飞机会在窄口相遇”；
//   2. 交叉区 zone —— 进入交叉区的时刻之间必须保持安全间隔（同向/对向同一数值，
//      由申请的 intersectionSeparationSeconds 给定，取调度时涉及许可的最大值）。

export const WINGSPAN_CLASSES = ["A", "B", "C", "D", "E", "F"];

/** 机型尺寸等级（ICAO 翼展类别 A..F，取保守的默认值）。 */
export const DEFAULT_WINGSPAN = {
  // A/B 类小机型
  ATR72: "B",
  // C 类
  A320: "C",
  A321: "C",
  B737: "C",
  B738: "C",
  // D 类
  B767: "D",
  B757: "D",
  // E 类
  A330: "E",
  B777: "E",
  B747: "E",
  // F 类
  A380: "F",
};

export class Network {
  constructor(data = {}) {
    this.id = data.id ?? "airport";
    this.edges = new Map();
    this.zones = new Map(); // zoneId -> { separationSeconds? }
    this.nodes = new Set();
    this.handoffNodes = new Set(data.handoffNodes ?? []);
    this.holdingPoints = new Map(); // node -> { safeHold, capacity, note }
    this.closures = new Map(); // edgeId -> { reason, since, by }
    this._validate(data);

    for (const edge of data.edges ?? []) {
      const record = {
        id: edge.id ?? `${edge.from}->${edge.to}`,
        from: edge.from,
        to: edge.to,
        seconds: edge.seconds,
        aircraftTypes: edge.aircraftTypes === undefined ? null : new Set(edge.aircraftTypes),
        zone: edge.zone ?? null,
        channel: edge.channel ?? `${edge.from}->${edge.to}`,
        maxWingspan: edge.maxWingspan ?? "F",
        reversible: edge.reversible ?? false,
      };
      if (this.edges.has(record.id)) throw new Error(`duplicate edge id: ${record.id}`);
      this.edges.set(record.id, record);
      this.nodes.add(record.from).add(record.to);
      if (record.zone) {
        if (!this.zones.has(record.zone)) this.zones.set(record.zone, { id: record.zone });
      }
    }
    for (const zone of data.zones ?? []) {
      const existing = this.zones.get(zone.id) ?? { id: zone.id };
      existing.separationSeconds = zone.separationSeconds ?? existing.separationSeconds ?? 0;
      this.zones.set(zone.id, existing);
    }
    for (const hp of data.holdingPoints ?? []) {
      this.holdingPoints.set(hp.node, {
        node: hp.node,
        safeHold: hp.safeHold ?? true,
        capacity: hp.capacity ?? 1,
        note: hp.note ?? "",
      });
      this.nodes.add(hp.node);
    }
  }

  _validate(data) {
    if (!Array.isArray(data.edges) || data.edges.length === 0) {
      throw new Error("network requires at least one edge");
    }
    for (const edge of data.edges) {
      if (!edge.from || !edge.to) throw new Error("edge requires from/to");
      if (!(Number.isFinite(edge.seconds) && edge.seconds > 0)) {
        throw new Error(`edge ${edge.from}->${edge.to} requires positive seconds`);
      }
      if (edge.maxWingspan && !WINGSPAN_CLASSES.includes(edge.maxWingspan)) {
        throw new Error(`edge ${edge.from}->${edge.to} has bad maxWingspan`);
      }
    }
  }

  isClosed(edgeId) {
    return this.closures.has(edgeId);
  }

  /** 当前可用于某机型的出边（封闭与机型/翼展限制在此统一过滤）。 */
  outgoing(node, aircraftType, wingspan) {
    const result = [];
    for (const edge of this.edges.values()) {
      if (edge.from !== node) continue;
      if (this.closures.has(edge.id)) continue;
      if (edge.aircraftTypes && !edge.aircraftTypes.has(aircraftType)) continue;
      if (WINGSPAN_CLASSES.indexOf(wingspan) > WINGSPAN_CLASSES.indexOf(edge.maxWingspan)) continue;
      result.push(edge);
    }
    return result;
  }

  edgeById(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new Error(`unknown edge: ${edgeId}`);
    return edge;
  }

  canTraverse(edgeId, aircraftType, wingspan) {
    const edge = this.edgeById(edgeId);
    if (this.closures.has(edge.id)) return { ok: false, reason: "edge_closed", edge: edge.id };
    if (edge.aircraftTypes && !edge.aircraftTypes.has(aircraftType)) {
      return { ok: false, reason: "aircraft_type_forbidden", edge: edge.id, aircraftType };
    }
    if (WINGSPAN_CLASSES.indexOf(wingspan) > WINGSPAN_CLASSES.indexOf(edge.maxWingspan)) {
      return { ok: false, reason: "wingspan_exceeded", edge: edge.id, wingspan, max: edge.maxWingspan };
    }
    return { ok: true, edge };
  }

  /** 可交接节点：显式标注的，或没有出边的终点。 */
  canHandOff(node) {
    return this.handoffNodes.has(node) || !this._hasOutgoing(node);
  }

  _hasOutgoing(node) {
    for (const edge of this.edges.values()) if (edge.from === node) return true;
    return false;
  }

  holdingAt(node) {
    return this.holdingPoints.get(node) ?? { node, safeHold: false, capacity: 0, note: "" };
  }
}
