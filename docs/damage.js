// 只负责计算；武器基础伤害、装甲系数、部位倍率和角度均来自 data.json。
export function simulateHit(weapon, vehicle, part, angleScale) {
  const active = weapon.components.filter((segment) => segment.base > 0);
  const segments = active.length ? active : weapon.components;
  const rows = segments.map((segment) => {
    const explosion = segment.kind === '爆炸';
    const coefficient = segment.armor[vehicle.armorKey];
    const multiplier = part?.ignore ? 0 : explosion ? (part?.radiusScaling ?? 1) : (part?.scaling ?? 1);
    const angle = explosion ? 1 : angleScale;
    const received = explosion ? vehicle.explodeRate : vehicle.pointRate;
    return {
      kind: segment.kind, base: segment.base, coefficient, multiplier, angle, received,
      damage: segment.base * coefficient * multiplier * angle * received,
      note: explosion ? '爆炸段使用爆炸倍率和爆炸承受倍率' : '直击段使用部位、角度和直击承受倍率',
    };
  });
  const total = rows.reduce((sum, row) => sum + row.damage, 0);
  const percent = total / vehicle.hp * 100;
  return { rows, total, hp: vehicle.hp, percent, bar: 100 - percent };
}

