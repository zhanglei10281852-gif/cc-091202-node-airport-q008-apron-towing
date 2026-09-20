// 人员资质与车辆状态：申请随附快照；激活时复验 validity 必须覆盖出发时刻。
// 真实系统对接证照库，这里只做结构化校验，规则本身与引擎解耦。

export function validateCrew(crew = {}, atMs) {
  const failures = [];
  for (const p of crew.personnel ?? []) {
    if (!p.id) failures.push(`机务人员缺少 id`);
    for (const cert of p.certifications ?? []) {
      if (!cert.type) failures.push(`${p.id}: 资质缺少类型`);
      const from = cert.validFrom ? Date.parse(cert.validFrom) : -Infinity;
      const to = cert.validTo ? Date.parse(cert.validTo) : Infinity;
      if (atMs < from) failures.push(`${p.id}: 资质 ${cert.type} 在出发时尚未生效`);
      if (atMs >= to) failures.push(`${p.id}: 资质 ${cert.type} 已于出发前过期(${cert.validTo})`);
    }
  }
  for (const v of crew.vehicles ?? []) {
    if (!v.id) failures.push(`车辆缺少 id`);
    const to = v.statusValidTo ? Date.parse(v.statusValidTo) : Infinity;
    if (atMs >= to) failures.push(`${v.id}(${v.kind ?? "vehicle"}): 车辆状态于出发前失效(${v.statusValidTo})`);
    if (v.serviceable === false) failures.push(`${v.id}: 车辆标记为不可用`);
  }
  const roles = new Set((crew.personnel ?? []).flatMap((p) => p.roles ?? []));
  if (crew.requireRoles) {
    for (const r of crew.requireRoles) if (!roles.has(r)) failures.push(`缺少必需岗位: ${r}`);
  }
  return failures;
}
