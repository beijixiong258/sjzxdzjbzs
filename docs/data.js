// 玩家只需修改 data.json；这里负责读取、校验并适配页面使用的数据结构。
export const resourceFields = {
  modelParts: '外观部件', modelWheels: '轮组', modelTracks: '履带',
  collisionMeshes: '碰撞网格', collisionLayers: '碰撞层',
  mesh: '原始网格路径', models: '原始模型路径', folder: '模型目录',
  name: '名称', role: '角色', loc: '位置', rot: '欧拉角', quat: '四元数',
  mount: '挂载点', unplaced: '未定位', url: '资源路径',
  min: '包围盒最小值', max: '包围盒最大值', materials: '材质',
  transforms: '实例变换', scale: '缩放', size: '链节长度',
  points: '样条点', partIndex: '外观部件索引', iou: '匹配度',
  extent: '半尺寸', label: '标签', source: '来源',
  impact: '载具撞击', chassis: '底盘物理', nav: '导航', assembly: '装配',
};
const resourceNames = Object.fromEntries(Object.entries(resourceFields).map(([key, name]) => [name, key]));

function fail(path, message) { throw new Error(path + '：' + message); }
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '应填写一个对象。');
  return value;
}
function list(value, path, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail(path, nonempty ? '应填写非空数组。' : '应填写数组。');
  return value;
}
function text(value, path, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) fail(path, '应填写' + (empty ? '' : '非空') + '文字。');
  return value;
}
function number(value, path, min = 0, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, '应填写' + (max === Infinity ? '不小于 ' + min : min + ' 至 ' + max + ' 之间的') + '数字，不要加引号。');
  }
  return value;
}
function choice(value, choices, path) {
  if (!choices.includes(value)) fail(path, '可选值为：' + choices.join('、') + '。');
  return value;
}
function vector(value, length, path) {
  list(value, path);
  if (value.length !== length || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    fail(path, '应填写 ' + length + ' 个有限数字组成的数组。');
  }
  return value;
}
function optionalNumber(value, path) {
  return value === null ? null : number(value, path);
}
function boolean(value, path, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'boolean') fail(path, '应填写 true 或 false。');
  return value;
}
function decodeResource(value, path) {
  if (Array.isArray(value)) return value.map((item, i) => decodeResource(item, path + '[' + (i + 1) + ']'));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => {
    const key = resourceNames[name];
    if (!key) fail(path + '.' + name, '未知的模型字段。');
    // 材质名称来自模型，必须保持原样。
    return [key, key === 'materials' ? object(child, path + '.' + name) : decodeResource(child, path + '.' + name)];
  }));
}
function validateResource(resource, path) {
  ['modelParts', 'modelWheels', 'modelTracks', 'collisionMeshes'].forEach((key) => {
    list(resource[key], path + '.' + resourceFields[key]);
  });
  object(resource.collisionLayers, path + '.碰撞层');
  function visit(value, at) {
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, at + '[' + (i + 1) + ']')); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const here = at + '.' + (resourceFields[key] || key);
      if (key === 'materials') {
        Object.values(child).forEach((url) => text(url, here));
      } else if (['loc', 'rot', 'min', 'max', 'extent', 'scale'].includes(key)) vector(child, 3, here);
      else if (key === 'quat') vector(child, 4, here);
      else if (key === 'points') list(child, here).forEach((point) => vector(point, 3, here));
      else if (key === 'url') text(child, here);
      else visit(child, here);
    }
  }
  visit(resource, path);
}

export function normalizeData(raw) {
  object(raw, '数据文件');
  const armors = list(raw.装甲类型, '装甲类型', true).map((name, i) => text(name, '装甲类型[' + (i + 1) + ']'));
  if (new Set(armors).size !== armors.length) fail('装甲类型', '名称不能重复。');
  const profiles = object(raw.入射角方案, '入射角方案');
  const angles = {};
  for (const [name, entries] of Object.entries(profiles)) {
    let previous = 0;
    angles[name] = list(entries, '入射角方案.' + name, true).map((entry, i) => {
      const path = '入射角方案.' + name + '[' + (i + 1) + ']';
      object(entry, path);
      const from = number(entry.起始角度, path + '.起始角度', 0, 90);
      const to = number(entry.结束角度, path + '.结束角度', 0, 90);
      if (from !== previous || to <= from) fail(path, '角度区间应按顺序连续覆盖 0 至 90 度。');
      previous = to;
      const title = text(entry.名称, path + '.名称');
      return { label: title + ' ' + from + '–' + to + '°', from, to,
        scale: number(entry.直击倍率, path + '.直击倍率'), hint: text(entry.说明, path + '.说明', true) };
    });
    if (previous !== 90) fail('入射角方案.' + name, '最后一个区间应结束于 90 度。');
  }
  const settings = object(raw.计算设置, '计算设置');
  const profile = choice(settings.入射角方案, Object.keys(angles), '计算设置.入射角方案');
  const angleModes = angles[profile];

  function weapons(entries, section) {
    return list(entries, section).map((entry, i) => {
      const path = section + '[' + (i + 1) + ']';
      object(entry, path);
      const name = text(entry.名称, path + '.名称');
      const where = path + '（' + name + '）';
      const components = list(entry.伤害段, where + '.伤害段', true).map((part, index) => {
        const at = where + '.伤害段[' + (index + 1) + ']';
        object(part, at);
        const coefficients = object(part.装甲系数, at + '.装甲系数');
        Object.keys(coefficients).forEach((armor) => choice(armor, armors, at + '.装甲系数.' + armor));
        const armor = Object.fromEntries(armors.map((armor) => [armor,
          number(coefficients[armor], at + '.装甲系数.' + armor)]));
        return {
          kind: choice(part.类型, ['直击', '爆炸', '直击/持续'], at + '.类型'),
          trigger: text(part.触发方式, at + '.触发方式', true),
          base: number(part.基础伤害, at + '.基础伤害'), armor,
        };
      });
      return {
        name, components,
        vehicle: text(entry.所属载具 ?? '', where + '.所属载具', true),
        owner: text(entry.归属 ?? '', where + '.归属', true),
        group: text(entry.分类 ?? '', where + '.分类', true),
      };
    });
  }

  const resources = object(raw.模型资源, '模型资源');
  const vehicleIds = new Set();
  const vehicles = list(raw.载具, '载具', true).map((entry, i) => {
    const path = '载具[' + (i + 1) + ']';
    object(entry, path);
    const id = number(entry.编号, path + '.编号', 1);
    if (!Number.isSafeInteger(id) || vehicleIds.has(id)) fail(path + '.编号', '编号必须是唯一的正整数。');
    vehicleIds.add(id);
    const name = text(entry.名称, path + '.名称');
    const where = path + '（' + name + '）';
    const resourcePath = '模型资源.' + id;
    const resource = decodeResource(object(resources[id], resourcePath), resourcePath);
    validateResource(resource, resourcePath);
    const parts = list(entry.独立部位, where + '.独立部位').map((part, j) => {
      const at = where + '.独立部位[' + (j + 1) + ']';
      object(part, at);
      const debuff = object(part.损坏惩罚, at + '.损坏惩罚');
      Object.entries(debuff).forEach(([key, value]) => number(value, at + '.损坏惩罚.' + key));
      return { id: number(part.编号, at + '.编号'), kind: text(part.名称, at + '.名称'),
        hp: number(part.耐久, at + '.耐久'), debuff, seat: part.座位 };
    });
    const hitBoxes = list(entry.命中部位, where + '.命中部位').map((box, j) => {
      const at = where + '.命中部位[' + (j + 1) + ']';
      object(box, at);
      const angleProfile = box.入射角方案;
      if (angleProfile !== null) choice(angleProfile, Object.keys(angles), at + '.入射角方案');
      const visual = box.显示关联 === undefined ? undefined : decodeResource(object(box.显示关联, at + '.显示关联'), at + '.显示关联');
      if (visual) {
        const index = number(visual.partIndex, at + '.显示关联.外观部件索引');
        if (!Number.isInteger(index) || index >= resource.modelParts.length) fail(at + '.显示关联', '外观部件索引超出范围。');
        choice(visual.source, ['collision', 'model'], at + '.显示关联.来源');
      }
      return {
        name: text(box.名称, at + '.名称'), raw: text(box.原始标识, at + '.原始标识'),
        region: choice(box.区域类型, ['body', 'engine', 'front', 'side', 'track', 'turret', 'armor', 'unknown'], at + '.区域类型'),
        point: boolean(box.点状部位, at + '.点状部位'), instance: box.独立部位编号,
        scaling: number(box.直击倍率, at + '.直击倍率'),
        radiusScaling: number(box.爆炸倍率, at + '.爆炸倍率'),
        extent: vector(box.半尺寸, 3, at + '.半尺寸'), translation: vector(box.位置, 3, at + '.位置'),
        rotation: vector(box.四元数, 4, at + '.四元数'), scale: vector(box.缩放, 3, at + '.缩放'),
        ignore: boolean(box.忽略伤害, at + '.忽略伤害', true),
        intactReduction: optionalNumber(box.完好减伤, at + '.完好减伤'),
        brokenBonus: optionalNumber(box.损坏加成, at + '.损坏加成'),
        angles: angleProfile === null ? [] : angles[angleProfile].map(({ from, to, scale }) => ({ from, to, scale })),
        antiVehicle: list(box.反载具覆盖, at + '.反载具覆盖').map((rule, k) => {
          const atRule = at + '.反载具覆盖[' + (k + 1) + ']';
          object(rule, atRule);
          return { weapon: text(rule.武器, atRule + '.武器'),
            BodyPartIntactDamageReduction: number(rule.完好减伤, atRule + '.完好减伤'),
            BodyPartBrokenDamageBonus: number(rule.损坏加成, atRule + '.损坏加成') };
        }),
        ...(visual ? { visual } : {}),
      };
    });
    return {
      ...resource, id, name,
      category: text(entry.分类, where + '.分类'), domain: text(entry.目标类型, where + '.目标类型'),
      hp: number(entry.总耐久, where + '.总耐久', Number.MIN_VALUE),
      shield: number(entry.护盾, where + '.护盾'),
      armor: choice(entry.装甲类型, armors, where + '.装甲类型'), armorKey: entry.装甲类型,
      pointRate: number(entry.直击承受倍率, where + '.直击承受倍率'),
      explodeRate: number(entry.爆炸承受倍率, where + '.爆炸承受倍率'),
      lowHpRatio: entry.低血量提示比例 === null ? null : number(entry.低血量提示比例, where + '.低血量提示比例', 0, 1),
      parts, hitBoxes,
    };
  });
  const repair = list(raw.修理规则, '修理规则').map((entry, i) => {
    const path = '修理规则[' + (i + 1) + ']';
    object(entry, path);
    return {
      载具名称: choice(entry.载具名称, vehicles.map((vehicle) => vehicle.name), path + '.载具名称'),
      修复来源: text(entry.修复来源, path + '.修复来源'),
      '开始自愈延迟(秒)': number(entry['开始自愈延迟(秒)'], path + '.开始自愈延迟(秒)'),
      '修复速度(每秒)': number(entry['修复速度(每秒)'], path + '.修复速度(每秒)'),
      '修复上限(%)': number(entry['修复上限(%)'], path + '.修复上限(%)', 0, 100),
    };
  });
  return { vehicles, weapons: weapons(raw.载具武器, '载具武器'),
    gadgets: weapons(raw.步兵武器, '步兵武器'), repair, angleModes };
}

export function parseData(source) {
  const text = source.replace(/^\uFEFF/, '');
  let raw;
  try { raw = JSON.parse(text); }
  catch (error) {
    const position = /position (\d+)/.exec(error.message);
    const location = /line (\d+) column (\d+)/.exec(error.message);
    let at = '';
    if (position) {
      const lines = text.slice(0, Number(position[1])).split('\n');
      at = '第 ' + lines.length + ' 行、第 ' + (lines.at(-1).length + 1) + ' 列';
    } else if (location) at = '第 ' + location[1] + ' 行、第 ' + location[2] + ' 列';
    throw new Error('data.json 格式错误' + (at ? '（' + at + '）' : '') + '：请检查英文双引号、逗号和括号；最后一项后不要加逗号。');
  }
  return normalizeData(raw);
}

export async function loadData(url = new URL('./data.json', import.meta.url), request = fetch) {
  let response;
  try { response = await request(url, { cache: 'no-store' }); }
  catch { throw new Error('无法读取 data.json，请通过启动器打开页面，并确认本地服务仍在运行。'); }
  if (!response.ok) throw new Error('无法读取 data.json（状态码 ' + response.status + '），请确认文件保存在 docs 目录。');
  return parseData(await response.text());
}

