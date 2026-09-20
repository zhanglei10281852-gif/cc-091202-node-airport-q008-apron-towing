// 人员资质与牵引车状态台账。
//
// 激活许可时必须重新校验（而非审批时）：
//   - 机务/牵引车驾驶员的资质与排班在出发时刻仍有效；
//   - 牵引车检定、保险、维修放行状态在出发时刻仍有效。
// 台账支持“在某时刻生效/失效”的记录，便于演示过期场景。

export class CredentialRegistry {
  constructor() {
    this.people = new Map(); // id -> person
    this.vehicles = new Map(); // id -> vehicle
  }

  static from(data = {}) {
    const registry = new CredentialRegistry();
    const ms = (v, fallback) => {
      if (v === undefined || v === null) return fallback;
      if (typeof v === "number") return v;
      const parsed = Date.parse(v);
      if (Number.isNaN(parsed)) throw new Error(`invalid credential date: ${v}`);
      return parsed;
    };
    for (const person of data.people ?? []) {
      registry.people.set(person.id, {
        id: person.id,
        name: person.name ?? person.id,
        roles: person.roles ?? [],
        ratings: person.ratings ?? [], // 允许牵引的翼展等级
        validFrom: ms(person.validFrom, 0),
        validUntil: ms(person.validUntil, Number.MAX_SAFE_INTEGER),
        onDuty: (person.onDuty ?? []).map((s) => ({ from: ms(s.from, 0), to: ms(s.to, Number.MAX_SAFE_INTEGER) })),
      });
    }
    for (const vehicle of data.vehicles ?? []) {
      registry.vehicles.set(vehicle.id, {
        id: vehicle.id,
        name: vehicle.name ?? vehicle.id,
        ratings: vehicle.ratings ?? [],
        validFrom: ms(vehicle.validFrom, 0),
        validUntil: ms(vehicle.validUntil, Number.MAX_SAFE_INTEGER),
        serviceable: vehicle.serviceable ?? true,
      });
    }
    return registry;
  }

  /**
   * @param {{crew:string[],vehicle:string,wingspan:string}} requirement
   * @param {number} atMs 出发时刻
   */
  check(requirement, atMs) {
    const failures = [];
    const roleRequired = ["tug-driver", "mechanic"];
    const rolesPresent = new Set();
    for (const personId of requirement.crew ?? []) {
      const person = this.people.get(personId);
      if (!person) {
        failures.push({ kind: "crew_unknown", person: personId });
        continue;
      }
      if (atMs < person.validFrom || atMs > person.validUntil) {
        failures.push({ kind: "crew_cert_expired", person: personId, validUntil: person.validUntil });
      }
      if (!person.ratings.includes(requirement.wingspan)) {
        failures.push({ kind: "crew_rating_mismatch", person: personId, wingspan: requirement.wingspan });
      }
      const onDuty = person.onDuty.some((shift) => atMs >= shift.from && atMs <= shift.to);
      if (person.onDuty.length > 0 && !onDuty) {
        failures.push({ kind: "crew_off_duty", person: personId });
      }
      for (const role of person.roles) rolesPresent.add(role);
    }
    for (const role of roleRequired) {
      if (!rolesPresent.has(role)) failures.push({ kind: "crew_role_missing", role });
    }
    const vehicle = this.vehicles.get(requirement.vehicle);
    if (!vehicle) {
      failures.push({ kind: "vehicle_unknown", vehicle: requirement.vehicle });
    } else {
      if (atMs < vehicle.validFrom || atMs > vehicle.validUntil) {
        failures.push({ kind: "vehicle_cert_expired", vehicle: vehicle.id, validUntil: vehicle.validUntil });
      }
      if (!vehicle.serviceable) failures.push({ kind: "vehicle_unserviceable", vehicle: vehicle.id });
      if (!vehicle.ratings.includes(requirement.wingspan)) {
        failures.push({ kind: "vehicle_rating_mismatch", vehicle: vehicle.id, wingspan: requirement.wingspan });
      }
    }
    return { ok: failures.length === 0, failures };
  }

  // —— 管制/运维可在运行中更新台账（产生审计事件）——
  setPerson(person) {
    this.people.set(person.id, {
      onDuty: [],
      roles: [],
      ratings: [],
      validFrom: 0,
      validUntil: Number.MAX_SAFE_INTEGER,
      ...person,
    });
  }
  setVehicle(vehicle) {
    this.vehicles.set(vehicle.id, {
      ratings: [],
      validFrom: 0,
      validUntil: Number.MAX_SAFE_INTEGER,
      serviceable: true,
      ...vehicle,
    });
  }
}
