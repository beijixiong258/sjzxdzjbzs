import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadData } from './data.js';
import { simulateHit } from './damage.js';

/* ------------------------------------------------------------------ *
 * 坐标约定
 *   解包数据是 UE 的厘米、X 前 / Y 右 / Z 上；
 *   glTF 导出时做了 (x, z, y) 交换并乘 0.01，所以这里是米。
 * ------------------------------------------------------------------ */
const S = 0.01;
const toVec3 = (v) => new THREE.Vector3(v[0] * S, v[2] * S, v[1] * S);
const toQuat = (q) => new THREE.Quaternion(q[0], q[2], q[1], -q[3]);

const COLORS = {
  body: 0x72c7c7,
  engine: 0xff6b5a,
  front: 0xffb340,
  side: 0x56a1ff,
  track: 0x4ad07a,
  turret: 0xc07bff,
  armor: 0xff83b5,
  ignore: 0x7d8794,
};

// 部位盒之外的碰撞体积，颜色分开，避免和部位盒混淆
const LAYER_COLORS = {
  impact: 0xffd24a,      // 载具撞击碰撞盒
  chassis: 0x35d6c0,     // 底盘物理盒
  nav: 0x9b8cff,         // AI 导航盒
  assembly: 0xb9c2cc,    // 装配体盒
};
const COLLISION_MESH_COLOR = 0x39e0ff;

const state = {
  data: null,
  vehicle: null,
  hitParts: [],
  showModels: true,
  showBoxes: true,
  boxFill: true,
  showLabels: true,
  boxAlpha: 0.10,
  selectedBoxIndex: -1,
  page: 'home',
  sim: { domain: '', targetId: null, weaponType: '', weaponIndex: -1, boxIndex: -1, angle: 0 },

  view: '3d',
  bounds: null,
  layers: { impact: false, chassis: false, nav: false, assembly: false, colmesh: false },
};

let scene, renderer, controls, modelGroup, boxGroup, axes, grid;
const layerGroups = {};
let perspCamera, orthoCamera, activeCamera;
let boxMeshes = [];
let hitVisuals = [];
let vehicleLoadToken = 0;
let labelLayer, hoverLabel;
let boxListEl;
let collisionMeshMaterials = [];

const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const textureCache = new Map();

init().catch(showStartupError);

async function init() {
  labelLayer = document.getElementById('labels');
  state.data = await loadData();
  setupScene();
  bindControls();

  const params = new URLSearchParams(location.search);
  renderVehicleList();

  const wantId = Number(params.get('veh'));
  const vehicle = state.data.vehicles.find((v) => v.id === wantId) || state.data.vehicles[0];

  // URL 参数（便于自动化截图）
  const toggle = (id, key, value) => {
    if (value === null) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = value !== '0';
    state[key] = el.checked;
    el.dispatchEvent(new Event('change'));
  };
  toggle('showBoxes', 'showBoxes', params.get('boxes'));
  toggle('showModels', 'showModels', params.get('models'));
  toggle('showLabels', 'showLabels', params.get('labels'));
  toggle('boxFill', 'boxFill', params.get('fill'));
  if (params.get('help') !== null) {
    document.getElementById('layerHelp').hidden = params.get('help') === '0';
  }
  if (params.get('alpha')) {
    const slider = document.getElementById('boxAlpha');
    slider.value = params.get('alpha');
    state.boxAlpha = Number(params.get('alpha')) / 100;
  }

  selectVehicle(vehicle.id);
  const view = params.get('view');
  if (view) setView(view);
  if (params.get('box') !== null) {
    const index = Number(params.get('box'));
    if (state.vehicle.hitBoxes[index]) {
      state.selectedBoxIndex = state.hitParts.findIndex((part) => part.sourceIndices.includes(index));
      applyBoxAlpha();
      renderBoxList();
      renderBoxInfo();
    }
  }

  document.querySelectorAll('.layer-toggle').forEach((box) => {
    const value = params.get(`layer_${box.dataset.layer}`);
    if (value === null) return;
    box.checked = value !== '0';
    box.dispatchEvent(new Event('change'));
  });
  // 旧的计算/修理链接仍可打开对应页面，普通访问默认进入主页。
  const legacyTab = params.get('tab');
  const legacyPage = legacyTab === 'repair' ? 'repair'
    : ['sim', 'weapons', 'gadgets'].includes(legacyTab) ? 'combat' : 'home';
  if (legacyPage === 'combat') {
    state.sim.domain = vehicle.domain;
    state.sim.targetId = vehicle.id;
    if (['weapons', 'gadgets'].includes(legacyTab)) state.sim.weaponType = legacyTab;
  }
  renderPlainTable(document.getElementById('repairTable'), state.data.repair);
  showPage(location.hash.slice(1) || legacyPage);

  animate();
}


/** 配置错误时展示可读提示，避免页面停在无反馈的空白状态。 */
function showStartupError(error) {
  console.error(error);
  document.querySelectorAll('.page').forEach((page) => { page.hidden = true; });
  document.getElementById('pageNav').hidden = true;
  document.getElementById('dataError').hidden = false;
  document.getElementById('dataErrorMessage').textContent = /[\u4e00-\u9fff]/.test(error.message || '')
    ? error.message : '页面初始化失败，请检查浏览器是否支持三维显示，或在控制台查看具体原因。';
  document.getElementById('reloadData').addEventListener('click', () => location.reload());
}

/** 图例沿用当前载具的数据，修改倍率后不会显示旧的固定数值。 */
function updateLegend(vehicle) {
  for (const [region, label] of [['engine', '发动机舱'], ['front', '车首装甲'], ['side', '侧面/顶部装甲带']]) {
    const values = [...new Set(vehicle.hitBoxes.filter((box) => box.region === region).map((box) => box.scaling))];
    const value = values.length === 1 ? values[0] : values.length ? Math.min(...values) + '–' + Math.max(...values) : null;
    document.getElementById(region + 'LegendLabel').textContent = label + (value === null ? '' : ' ×' + value);
  }
}
/* ------------------------------ 场景 ------------------------------ */

function setupScene() {
  const canvas = document.getElementById('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0f1216, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0f1216, 22, 70);

  perspCamera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
  perspCamera.position.set(6, 4, 7);
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
  activeCamera = perspCamera;

  controls = new OrbitControls(activeCamera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a3038, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(7, 12, 9);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
  fill.position.set(-9, 7, -7);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(-4, 3, 10);
  scene.add(rim);

  grid = new THREE.GridHelper(60, 60, 0x2b333d, 0x1b2128);
  scene.add(grid);
  axes = new THREE.AxesHelper(2);
  axes.visible = false;
  scene.add(axes);

  modelGroup = new THREE.Group();
  boxGroup = new THREE.Group();
  scene.add(modelGroup, boxGroup);
  Object.keys(LAYER_COLORS).forEach((key) => {
    layerGroups[key] = new THREE.Group();
    layerGroups[key].visible = state.layers[key];
    scene.add(layerGroups[key]);
  });
  layerGroups.colmesh = new THREE.Group();
  layerGroups.colmesh.visible = state.layers.colmesh;
  scene.add(layerGroups.colmesh);

  hoverLabel = document.createElement('div');
  hoverLabel.id = 'hoverLabel';
  hoverLabel.className = 'label';
  hoverLabel.style.display = 'none';
  labelLayer.appendChild(hoverLabel);

  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(document.getElementById('viewport'));
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('mousemove', onMove);
  resize();
}

function resize() {
  const viewport = document.getElementById('viewport');
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  perspCamera.aspect = w / h;
  perspCamera.updateProjectionMatrix();
  updateOrtho();
}

/* ---------------------------- 交互绑定 ---------------------------- */

function bindControls() {
  document.getElementById('showModels').addEventListener('change', (e) => {
    state.showModels = e.target.checked;
    modelGroup.visible = state.showModels;
    refreshCollisionMeshStyle();
  });
  document.getElementById('showBoxes').addEventListener('change', (e) => {
    state.showBoxes = e.target.checked;
    boxGroup.visible = state.showBoxes;
    if (!state.showBoxes) hoverLabel.style.display = 'none';
  });
  document.getElementById('showLabels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
    if (!state.showLabels) hoverLabel.style.display = 'none';
  });
  document.getElementById('showAxes').addEventListener('change', (e) => {
    axes.visible = e.target.checked;
    grid.visible = !e.target.checked;
  });
  document.getElementById('autoRotate').addEventListener('change', (e) => {
    controls.autoRotate = e.target.checked;
    controls.autoRotateSpeed = 1.1;
  });

  document.getElementById('boxAlpha').addEventListener('input', (e) => {
    state.boxAlpha = Number(e.target.value) / 100;
    applyBoxAlpha();
  });
  document.getElementById('boxFill').addEventListener('change', (e) => {
    state.boxFill = e.target.checked;
    applyBoxAlpha();
  });
  document.getElementById('resetView').addEventListener('click', () => {
    setView('3d');
    fitCamera();
  });
  document.getElementById('soloCollision').addEventListener('click', () => {
    // 只留实车碰撞体：关模型、关部位盒、只开 *_COL 那一层
    setToggle('showModels', false);
    setToggle('showBoxes', false);
    document.querySelectorAll('.layer-toggle').forEach((box) => {
      const want = box.dataset.layer === 'colmesh';
      if (box.checked !== want) box.checked = want;
      box.dispatchEvent(new Event('change'));
    });
  });
  document.getElementById('layerHelpBtn').addEventListener('click', () => {
    const panel = document.getElementById('layerHelp');
    panel.hidden = !panel.hidden;
  });
  document.querySelectorAll('.layer-toggle').forEach((box) => {
    box.addEventListener('change', () => {
      const key = box.dataset.layer;
      state.layers[key] = box.checked;
      if (layerGroups[key]) layerGroups[key].visible = box.checked;
      if (key === 'colmesh') refreshCollisionMeshStyle();
    });
  });
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
  document.getElementById('combatControls').addEventListener('change', (event) => {
    if (!state.data) return;
    const sim = state.sim;
    const value = event.target.value;
    switch (event.target.id) {
      case 'simDomain':
        sim.domain = value;
        sim.targetId = null;
        sim.boxIndex = -1;
        break;
      case 'simTarget':
        sim.targetId = value ? Number(value) : null;
        sim.boxIndex = -1;
        break;
      case 'simPart': sim.boxIndex = Number(value); break;
      case 'simAngle': sim.angle = Number(value); break;
      case 'simWeaponType':
        sim.weaponType = value;
        sim.weaponIndex = -1;
        break;
      case 'simWeapon': sim.weaponIndex = value === '' ? -1 : Number(value); break;
      default: return;
    }
    renderSimulator();
  });
}

function showPage(page) {
  state.page = ['home', 'combat', 'repair'].includes(page) ? page : 'home';
  for (const name of ['home', 'combat', 'repair']) {
    document.getElementById(`${name}Page`).hidden = name !== state.page;
  }
  document.querySelectorAll('.page-link').forEach((link) => {
    const active = link.dataset.page === state.page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (state.page === 'home') resize();
  if (state.page === 'combat' && state.data) renderSimulator();
}

const VIEW_DIR = {
  front: new THREE.Vector3(1, 0, 0),
  rear: new THREE.Vector3(-1, 0, 0),
  side: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0, 1, 0),
};

/** 改某个开关的状态并触发它自己的 change 逻辑（顶部按钮用）。 */
function setToggle(id, checked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = checked;
  el.dispatchEvent(new Event('change'));
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  applyView();
}

/** 把当前视角模式真正落到相机上（换车、改窗口、切模式都要走一遍）。 */
function applyView() {
  if (state.view === '3d') {
    activeCamera = perspCamera;
    controls.object = perspCamera;
    controls.maxPolarAngle = Math.PI * 0.495;
    perspCamera.up.set(0, 1, 0);
    fitCamera();
    return;
  }
  activeCamera = orthoCamera;
  controls.object = orthoCamera;
  controls.maxPolarAngle = Math.PI;
  fitOrthoCamera(VIEW_DIR[state.view]);
}

/* ---------------------------- 载具列表 ---------------------------- */

function renderVehicleList() {
  const groups = { 地面: [], 空中: [], 水上: [], 其他: [] };
  state.data.vehicles.forEach((v) => (groups[v.domain] || groups.其他).push(v));
  const groundOrder = [
    1101001, 1101005, 1101003, 1101004, 1101002,
    1101006, 1101009, 1102001, 1103012, 1103007,
  ];
  groups.地面 = [
    ...groundOrder.map((id) => groups.地面.find((v) => v.id === id)).filter(Boolean),
    ...groups.地面.filter((v) => !groundOrder.includes(v.id)),
  ];
  const container = document.getElementById('vehicleGroups');
  container.innerHTML = '';
  Object.entries(groups).forEach(([domain, list]) => {
    if (!list.length) return;
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = domain;
    container.appendChild(title);
    list.forEach((v) => {
      const button = document.createElement('button');
      button.className = 'vehicle-item';
      button.dataset.id = v.id;
      button.textContent = v.name;
      button.addEventListener('click', () => selectVehicle(v.id));
      container.appendChild(button);
    });
  });
}

function selectVehicle(id) {
  const vehicle = state.data.vehicles.find((v) => v.id === id);
  if (!vehicle) return;
  state.vehicle = vehicle;
  state.hitParts = groupHitBoxes(vehicle);
  updateLegend(vehicle);
  document.getElementById('bodyLegendLabel').textContent = `${bodyPartName(vehicle)} ×1.0`;
  document.getElementById('status').textContent = '正在加载…';
  state.selectedBoxIndex = -1;

  document.querySelectorAll('.vehicle-item').forEach((el) =>
    el.classList.toggle('active', Number(el.dataset.id) === id));

  renderVehicleInfo();
  renderBoxList();
  renderBoxInfo();
  const token = ++vehicleLoadToken;
  buildHitBoxes(vehicle, token);
  buildModel(vehicle, token);
}

/* ---------------------------- 车体加载 ---------------------------- */

function loadTexture(url) {
  if (textureCache.has(url)) return textureCache.get(url);
  const promise = new Promise((resolve) => {
    texLoader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      // glTF 的 UV 原点在左上，three.js 默认要翻 V；不关掉的话轮胎、车号这些
      // 有明确上下方向的地方会整体错位（轮毂对不上轮心、编号倒过来）。
      tex.flipY = false;
      resolve(tex);
    }, undefined, () => resolve(null));
  });
  textureCache.set(url, promise);
  return promise;
}

const gltfCache = new Map();

/**
 * 导出的骨骼网格在 three.js 里会被骨架矩阵带偏：主战坦克的炮管会掉到车底、
 * 天线会缩成一个点拉着几条细线、底盘会塌掉。原因是这份 GLB 的
 * 逆绑定矩阵/骨架姿态与本机导出不完全一致。
 * 这里统一只取「绑定姿态的顶点」当普通静态网格用——顶点本来就是正确的形状，
 * 位置交给蓝图里的 RelativeLocation 决定，实测与三维可视化报告里的包围盒完全吻合。
 */
function flattenSkinned(scene) {
  const skinned = [];
  scene.traverse((child) => { if (child.isSkinnedMesh) skinned.push(child); });
  skinned.forEach((child) => {
    const mesh = new THREE.Mesh(child.geometry, child.material);
    mesh.name = child.name;
    mesh.position.copy(child.position);
    mesh.quaternion.copy(child.quaternion);
    mesh.scale.copy(child.scale);
    mesh.visible = child.visible;
    child.parent.add(mesh);
    child.parent.remove(child);
  });
  return scene;
}

function loadGltf(url) {
  if (!gltfCache.has(url)) {
    gltfCache.set(url, new Promise((resolve) => {
      gltfLoader.load(url, (gltf) => {
        flattenSkinned(gltf.scene);
        resolve(gltf);
      }, undefined, (error) => {
        console.error('模型加载失败', url, error);
        resolve(null);
      });
    }));
  }
  return gltfCache.get(url);
}

async function loadMaterialSet(entry) {
  const textures = {};
  await Promise.all(Object.entries(entry.materials || {}).map(async ([name, url]) => {
    textures[name] = await loadTexture(url);
  }));
  return textures;
}

function applyMaterials(object, textures) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    const tex = textures ? textures[child.material?.name] : null;
    const material = new THREE.MeshStandardMaterial({
      map: tex || null,
      color: tex ? 0xffffff : 0x98a6b6,
      metalness: 0.28,
      roughness: 0.68,
    });
    // 换材质时必须把原来的材质名带上：同一个网格第二次套贴图全靠它找对应关系
    material.name = child.material?.name || '';
    child.material = material;
    if (child.geometry) child.geometry.computeBoundingBox();
  });
}

function place(object, loc, quat, scale) {
  object.position.copy(toVec3(loc || [0, 0, 0]));
  object.quaternion.copy(quat ? new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3])
    : new THREE.Quaternion());
  if (scale) object.scale.set(scale[0], scale[1], scale[2]);
}

async function buildModel(vehicle, token) {
  modelGroup.clear();
  modelGroup.userData.parts = [];
  modelGroup.visible = state.showModels;
  Object.values(layerGroups).forEach((g) => g.clear());
  collisionMeshMaterials = [];

  const allParts = vehicle.modelParts || [];
  const parts = allParts.filter((part) => !part.unplaced);
  const loaded = await Promise.all(parts.map(async (part) => {
    const gltf = await loadGltf(part.url);
    if (!gltf) return null;
    const textures = await loadMaterialSet(part);
    if (token !== vehicleLoadToken) return null;
    const object = gltf.scene.clone(true);
    applyMaterials(object, textures);
    return { part, object };
  }));
  if (token !== vehicleLoadToken) return;

  await buildWheels(vehicle, token);
  if (token !== vehicleLoadToken) return;
  await buildTracks(vehicle, token);
  if (token !== vehicleLoadToken) return;
  await buildCollisionMeshes(vehicle, token);
  if (token !== vehicleLoadToken) return;
  buildCollisionBoxes();

  const ok = loaded.filter(Boolean).length;
  const partCount = state.hitParts.length;
  const status = document.getElementById('status');
  const skipped = allParts.length - parts.length;
  if (status) {
    status.textContent = `外观件 ${ok}/${parts.length}`
      + ` · 轮 ${(vehicle.modelWheels || []).reduce((n, w) => n + w.transforms.length, 0)}`
      + ` · 履带 ${(vehicle.modelTracks || []).length}`
      + ` · 命中部位 ${partCount}`
      + (skipped ? ` · 未定位 ${skipped}` : '');
  }
  modelGroup.userData.parts = loaded.filter(Boolean);
  modelGroup.userData.parts.forEach(({ object }) => modelGroup.add(object));
  layoutParts();
  computeBounds();
  applyView();
}

/* 实例化轮组：位置直接来自蓝图 InitWheelTransforms */
async function buildWheels(vehicle, token) {
  for (const group of vehicle.modelWheels || []) {
    const gltf = await loadGltf(group.url);
    if (!gltf) continue;
    const textures = await loadMaterialSet(group);
    if (token !== vehicleLoadToken) return;
    const template = gltf.scene.clone(true);
    applyMaterials(template, textures);
    group.transforms.forEach((transform) => {
      const object = template.clone(true);
      place(object, transform.loc, transform.quat, transform.scale);
      modelGroup.add(object);
    });
  }
}

/* 履带链节：沿蓝图样条按 TrackSize 等距铺链节 */
const TRACK_LINK_LIMIT = 200;

async function buildTracks(vehicle, token) {
  for (const track of vehicle.modelTracks || []) {
    const gltf = await loadGltf(track.url);
    if (!gltf) continue;
    const textures = await loadMaterialSet(track);
    if (token !== vehicleLoadToken) return;
    const offset = toVec3(track.loc);
    const curve = new THREE.CatmullRomCurve3(
      track.points.map((p) => toVec3(p).add(offset)), false, 'catmullrom', 0.5);
    const length = curve.getLength();
    const spacing = Math.max(0.05, (track.size || 20) / 100);
    const count = Math.min(TRACK_LINK_LIMIT, Math.max(2, Math.round(length / spacing)));
    const template = gltf.scene.clone(true);
    applyMaterials(template, textures);
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0 : i / (count - 1);
      const point = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const object = template.clone(true);
      object.position.copy(point);
      object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(tangent.y, tangent.x));
      modelGroup.add(object);
    }
  }
}

/* _COL 简化碰撞网格：贴着对应外观件画一层淡青色“碰撞皮” */
async function buildCollisionMeshes(vehicle, token) {
  for (const entry of vehicle.collisionMeshes || []) {
    const gltf = await loadGltf(entry.url);
    if (!gltf) continue;
    if (token !== vehicleLoadToken) return;
    const part = entry.partIndex >= 0 ? vehicle.modelParts[entry.partIndex] : null;
    const object = gltf.scene.clone(true);
    object.traverse((child) => {
      if (!child.isMesh) return;
      child.material = new THREE.MeshBasicMaterial({
        color: COLLISION_MESH_COLOR, transparent: true, opacity: 0.22,
        depthWrite: false, side: THREE.DoubleSide,
      });
      collisionMeshMaterials.push(child.material);
    });
    place(object, part?.loc, part?.quat, part?.scale);
    layerGroups.colmesh.add(object);
  }
  refreshCollisionMeshStyle();
}

/** 车体隐藏时把实车碰撞体画得更实，方便单独观察子弹判定体。 */
function refreshCollisionMeshStyle() {
  const solo = !state.showModels;
  collisionMeshMaterials.forEach((material) => {
    material.opacity = solo ? 0.5 : 0.22;
    material.depthWrite = solo;
  });
}

/* 车辆撞击 / 底盘 / AI 导航 / 装配体：只画线框，避免盖住部位盒 */
function buildCollisionBoxes() {
  const layers = state.vehicle.collisionLayers || {};
  Object.entries(LAYER_COLORS).forEach(([key, color]) => {
    const boxes = layers[key] || [];
    for (const box of boxes) {
      const size = box.extent.map((e) => (e || 0) * S * 2);
      const geometry = new THREE.BoxGeometry(size[0], size[2], size[1]);
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      place(lines, box.loc, box.quat);
      layerGroups[key].add(lines);
    }
  });
}

function isBodyModelPart(part) {
  // 这两辆车只把底盘标为 body，完整车身另记在 other 中。
  return part.role === 'body' || ['ORV_Body_01_3P', 'LSOV_Body_01_3P'].includes(part.name);
}

function placeModelPart(object, part) {
  place(object, part.loc, part.quat, part.scale);
}

function layoutParts() {
  (modelGroup.userData.parts || []).forEach(({ part, object }) => placeModelPart(object, part));
  hitVisuals.forEach((visual) => {
    if (visual?.sources) layoutMergedParts(visual);
    else if (visual?.part) placeModelPart(visual.object, visual.part);
  });
}

/* ---------------------------- 命中部位 ---------------------------- */

function boxColor(box) {
  return box.ignore ? COLORS.ignore : (COLORS[box.region] ?? COLORS.ignore);
}

function bodyPartName(vehicle) {
  return ({ 空中: '机体', 水上: '艇体' })[vehicle.domain] || '车体';
}

/** 普通本体只生成显示框，不改写游戏判定数据，也不继承发动机等部位的倍率。 */
function createBodyDisplayPart(vehicle, groups) {
  const bounds = new THREE.Box3();
  (vehicle.modelParts || []).filter((part) => isBodyModelPart(part) && !part.unplaced).forEach((part) => {
    if (!part.min || !part.max || ![...part.min, ...part.max].every(Number.isFinite)) return;
    const matrix = new THREE.Matrix4().compose(toVec3(part.loc || [0, 0, 0]),
      new THREE.Quaternion(...(part.quat || [0, 0, 0, 1])), new THREE.Vector3(...(part.scale || [1, 1, 1])));
    bounds.union(new THREE.Box3(new THREE.Vector3(...part.min), new THREE.Vector3(...part.max)).applyMatrix4(matrix));
  });
  if (bounds.isEmpty()) return null;

  const sections = groups.filter((part) => !part.point).map((part) => ({ part, bounds: mergedBoxBounds(part.members) }));
  const endTrim = bounds.clone();
  sections.forEach(({ part, bounds: occupied }) => {
    if (part.region === 'front') endTrim.max.x = Math.min(endTrim.max.x, occupied.min.x);
    if (part.region === 'engine') endTrim.min.x = Math.max(endTrim.min.x, occupied.max.x);
  });
  if (endTrim.max.x - endTrim.min.x > 0.01) {
    bounds.min.x = endTrim.min.x;
    bounds.max.x = endTrim.max.x;
  }

  const sides = sections.filter(({ part }) => ['左侧装甲带', '右侧装甲带'].includes(part.name));
  const sideTrim = bounds.clone();
  sides.forEach(({ part, bounds: occupied }) => {
    if (part.name === '左侧装甲带') sideTrim.min.z = Math.max(sideTrim.min.z, occupied.max.z);
    else sideTrim.max.z = Math.min(sideTrim.max.z, occupied.min.z);
  });
  if (sideTrim.max.z - sideTrim.min.z > 0.01) {
    bounds.min.z = sideTrim.min.z;
    bounds.max.z = sideTrim.max.z;
  } else {
    // 轻坦克的左右装甲盒各覆盖半个车体；保留其上方空间，避免裁成零宽。
    const sideTop = Math.max(...sides.map((side) => side.bounds.max.y));
    if (bounds.max.y - sideTop > 0.01) bounds.min.y = Math.max(bounds.min.y, sideTop);
  }
  const roof = sections.find(({ part }) => part.name === '顶部装甲带');
  if (roof && roof.bounds.min.y - bounds.min.y > 0.01) bounds.max.y = Math.min(bounds.max.y, roof.bounds.min.y);
  const center = bounds.getCenter(new THREE.Vector3());
  const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  if (![half.x, half.y, half.z].every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    name: bodyPartName(vehicle), raw: 'BodyDisplay', region: 'body', displayOnly: true,
    point: false, instance: 0, scaling: 1, radiusScaling: 1,
    extent: [half.x / S, half.z / S, half.y / S],
    translation: [center.x / S, center.z / S, center.y / S], rotation: [0, 0, 0, 1],
    ignore: false, intactReduction: null, brokenBonus: null, antiVehicle: [],
    angles: state.data.angleModes.map(({ from, to, scale }) => ({ from, to, scale })),
  };
}
/** 展示按部位合并，原始 hitBoxes 始终保留，伤害倍率沿用原记录。 */
function groupHitBoxes(vehicle) {
  const groups = new Map();
  vehicle.hitBoxes.forEach((box, index) => {
    let name = box.name;
    const side = /^left/i.test(box.raw) ? '左' : /^(right|righr)/i.test(box.raw) ? '右' : '';
    if (!box.point && box.region === 'track' && side) name = `${side}履带`;
    if (!box.point && box.region === 'side') {
      if (side) name = `${side}侧装甲带`;
      else if (/^topbox/i.test(box.raw)) name = '顶部装甲带';
    }
    if (!box.point && box.region === 'front' && !['首上装甲', '首下装甲'].includes(name)) name = '正面装甲';
    if (box.point && box.region === 'armor') name = name.replace(/（[^）]*）/g, '');
    const key = `${box.region}:${name}`;
    if (!groups.has(key)) groups.set(key, { ...box, name, members: [], sourceIndices: [] });
    groups.get(key).members.push(box);
    groups.get(key).sourceIndices.push(index);
  });
  const body = createBodyDisplayPart(vehicle, Array.from(groups.values()));
  if (body) groups.set('body', { ...body, members: [body], sourceIndices: [] });
  const order = ['车体', '正面装甲', '首上装甲', '首下装甲', '左侧装甲带', '右侧装甲带',
    '顶部装甲带', '左履带', '右履带', '炮塔', '发动机舱', '左侧反应装甲', '右侧反应装甲'];
  const rank = (part) => part.region === 'body' ? -1 : order.includes(part.name) ? order.indexOf(part.name) : order.length;
  return Array.from(groups.values()).sort((a, b) => rank(a) - rank(b));
}

function isReactiveArmor(part) {
  return part.region === 'armor' && part.name.includes('反应装甲');
}

function partValue(part, key) {
  const values = [...new Set(part.members.map((box) => box[key]))];
  if (values.length === 1) return values[0];
  return values.every((value) => typeof value === 'number')
    ? `${Math.min(...values)}–${Math.max(...values)}` : values.map((value) => value ?? '无').join(' / ');
}

/** 将旋转后的各盒完整包住，只生成一个外框，不保留内部分段线。 */
function mergedBoxBounds(boxes) {
  const bounds = new THREE.Box3();
  boxes.forEach((box) => {
    const half = toVec3(box.extent);
    const matrix = new THREE.Matrix4().compose(toVec3(box.translation), toQuat(box.rotation), new THREE.Vector3(1, 1, 1));
    bounds.union(new THREE.Box3(half.clone().negate(), half).applyMatrix4(matrix));
  });
  return bounds;
}

function makeDisplayBox() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.material.dispose();
  mesh.userData.ownsGeometry = true;
  return mesh;
}

function fitDisplayBox(mesh, bounds) {
  bounds.getCenter(mesh.position);
  bounds.getSize(mesh.scale);
}

function layoutMergedParts(visual) {
  const bounds = new THREE.Box3();
  visual.sources.forEach(({ object, part }) => {
    placeModelPart(object, part);
    bounds.union(new THREE.Box3().setFromObject(object));
  });
  fitDisplayBox(visual.object, bounds);
}
/** 仅使用数据中明确关联的模型；零体积记录本身不能生成一个猜测的盒子。 */
function pointVisualSource(vehicle, box) {
  const link = box.visual;
  if (!link) return null;
  const part = vehicle.modelParts?.[link.partIndex];
  if (!part || part.unplaced) return null;
  const url = link.source === 'collision'
    ? vehicle.collisionMeshes?.find((entry) => entry.partIndex === link.partIndex)?.url
    : link.source === 'model' ? part.url : null;
  return url ? { part, url, source: link.source } : null;
}

function addHitVisual(object, index, box, source, part = null) {
  const meshes = [];
  object.traverse((child) => { if (child.isMesh) meshes.push(child); });
  if (!meshes.length) return;
  const color = boxColor(box);
  meshes.forEach((mesh) => {
    // 贴合部件的碰撞网格可能位于外观表面内侧，叠加显示以免高亮被外壳遮住。
    const overlay = source !== 'box';
    mesh.material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: state.boxAlpha, depthWrite: false,
      depthTest: !overlay, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    mesh.renderOrder = overlay ? 2 : 0;
    mesh.userData.index = index;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 25),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: !overlay }),
    );
    edges.renderOrder = overlay ? 3 : 1;
    mesh.add(edges);
    boxMeshes.push(mesh);
  });
  const bounds = new THREE.Box3().setFromObject(object);
  const anchor = bounds.getCenter(new THREE.Vector3());
  if (source !== 'box') anchor.y = bounds.max.y + 0.08;
  object.worldToLocal(anchor);
  hitVisuals[index] = { object, anchor, part, source };
  if (part) placeModelPart(object, part);
  boxGroup.add(object);
}

async function buildHitBoxes(vehicle, token) {
  boxGroup.traverse((object) => {
    if (object.isMesh || object.isLineSegments) object.material.dispose();
    if (object.isLineSegments || object.userData.ownsGeometry) object.geometry.dispose();
  });
  boxGroup.clear();
  boxMeshes = [];
  const parts = state.hitParts;
  hitVisuals = new Array(parts.length).fill(null);
  boxGroup.visible = state.showBoxes;
  hoverLabel.style.display = 'none';

  await Promise.all(parts.map(async (part, index) => {
    if (part.point) {
      const sources = await Promise.all(part.members.map(async (box) => {
        const binding = pointVisualSource(vehicle, box);
        if (!binding) return null;
        const gltf = await loadGltf(binding.url);
        return gltf ? { ...binding, object: gltf.scene.clone(true) } : null;
      }));
      if (token !== vehicleLoadToken) return;
      const loaded = sources.filter(Boolean);
      if (!loaded.length) return;
      if (loaded.length === 1) {
        const source = loaded[0];
        addHitVisual(source.object, index, part, source.source, source.part);
      } else {
        const mesh = makeDisplayBox();
        const visual = { object: mesh, sources: loaded };
        layoutMergedParts(visual);
        addHitVisual(mesh, index, part, loaded[0].source);
        hitVisuals[index].sources = loaded;
      }
    } else {
      const mesh = makeDisplayBox();
      if (part.members.length > 1) {
        fitDisplayBox(mesh, mergedBoxBounds(part.members));
      } else {
        mesh.scale.copy(toVec3(part.extent)).multiplyScalar(2);
        mesh.position.copy(toVec3(part.translation));
        mesh.quaternion.copy(toQuat(part.rotation));
      }
      addHitVisual(mesh, index, part, 'box');
    }
    applyBoxAlpha();
  }));
  if (token !== vehicleLoadToken) return;
  renderBoxList();
  renderBoxInfo();
}
function applyBoxAlpha() {
  boxMeshes.forEach((mesh) => {
    const selected = mesh.userData.index === state.selectedBoxIndex;
    mesh.material.opacity = state.boxFill
      ? (selected ? Math.min(0.75, state.boxAlpha + 0.25) : state.boxAlpha) : 0;
  });
}

/* ---------------------------- 相机 ---------------------------- */

function computeBounds() {
  const box = new THREE.Box3();
  let has = false;
  (modelGroup.userData.parts || []).forEach(({ part }) => {
    if (!part.min || !part.max) return;
    const local = new THREE.Box3(
      new THREE.Vector3(part.min[0], part.min[1], part.min[2]),
      new THREE.Vector3(part.max[0], part.max[1], part.max[2]),
    );
    const matrix = new THREE.Matrix4().compose(
      toVec3(part.loc),
      part.quat ? new THREE.Quaternion(part.quat[0], part.quat[1], part.quat[2], part.quat[3]) : new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    );
    box.union(local.applyMatrix4(matrix));
    has = true;
  });
  (state.vehicle.hitBoxes || []).forEach((b) => {
    const half = new THREE.Vector3(
      Math.abs(b.extent[0] || 0) * S, Math.abs(b.extent[2] || 0) * S, Math.abs(b.extent[1] || 0) * S,
    );
    const center = toVec3(b.translation);
    box.union(new THREE.Box3(center.clone().sub(half), center.clone().add(half)));
    has = true;
  });
  // 轮组、履带、撞击碰撞盒也要包进来，不然相机可能切掉它们
  (state.vehicle.modelWheels || []).forEach((group) => {
    group.transforms.forEach((transform) => {
      box.union(localBox(group.min, group.max, transform.loc, transform.quat, transform.scale));
      has = true;
    });
  });
  (state.vehicle.modelTracks || []).forEach((track) => {
    const offset = toVec3(track.loc);
    track.points.forEach((point) => {
      const world = toVec3(point).add(offset);
      box.union(new THREE.Box3(world.clone().subScalar(0.3), world.clone().addScalar(0.3)));
      has = true;
    });
  });
  ['impact', 'chassis'].forEach((key) => {
    ((state.vehicle.collisionLayers || {})[key] || []).forEach((entry) => {
      box.union(localBox(
        [-entry.extent[0] * S, -entry.extent[1] * S, -entry.extent[2] * S],
        [entry.extent[0] * S, entry.extent[1] * S, entry.extent[2] * S],
        entry.loc, entry.quat, [1, 1, 1]));
      has = true;
    });
  });
  state.bounds = has ? box : null;
}

/** 把“glTF 米制局部包围盒 + UE 厘米制变换”换算成世界包围盒。 */
function localBox(min, max, loc, quat, scale) {
  const local = new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );
  const matrix = new THREE.Matrix4().compose(
    toVec3(loc || [0, 0, 0]),
    quat ? new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3]) : new THREE.Quaternion(),
    new THREE.Vector3(...(scale || [1, 1, 1])),
  );
  return local.applyMatrix4(matrix);
}

function fitCamera() {
  const box = state.bounds;
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // 视觉重心略高于包围盒中心（底盘/履带被算进了包围盒），把镜头落点抬高一点，让车体往下坐
  const target = center.clone().add(new THREE.Vector3(0, size.y * 0.08, 0));
  controls.target.copy(target);
  const fovV = THREE.MathUtils.degToRad(perspCamera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * perspCamera.aspect);
  const dir = new THREE.Vector3(0.66, 0.34, 0.68).normalize();
  const distance = frameDistance(box, target, dir, fovV, fovH);
  activeCamera.position.copy(target).addScaledVector(dir, distance);
  perspCamera.near = Math.max(0.05, distance / 400);
  perspCamera.far = distance * 80;
  perspCamera.updateProjectionMatrix();
  controls.update();
}

/** 让包围盒的 8 个角刚好落进视锥所需的相机距离（比用外接球贴合得多）。 */
function frameDistance(box, center, dir, fovV, fovH) {
  const up0 = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up0, dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const tanV = Math.tan(fovV / 2) || 0.4;
  const tanH = Math.tan(fovH / 2) || 0.4;
  let distance = 0;
  for (let i = 0; i < 8; i += 1) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(center);
    const depth = corner.dot(dir);
    distance = Math.max(distance,
      depth + Math.abs(corner.dot(right)) / tanH,
      depth + Math.abs(corner.dot(up)) / tanV);
  }
  return distance * 0.92 + 0.15;
}

function updateOrtho() {
  const viewport = document.getElementById('viewport');
  const aspect = viewport.clientWidth && viewport.clientHeight
    ? viewport.clientWidth / viewport.clientHeight : perspCamera.aspect;
  const box = state.bounds;
  const radius = box ? box.getBoundingSphere(new THREE.Sphere()).radius : 6;
  const half = box ? orthoHalf(box, aspect) : 6;
  orthoCamera.near = -radius * 4 - 20;
  orthoCamera.far = radius * 4 + 20;
  orthoCamera.left = -half * aspect;
  orthoCamera.right = half * aspect;
  orthoCamera.top = half;
  orthoCamera.bottom = -half;
  orthoCamera.updateProjectionMatrix();
}

/** 正交投影时，按当前视角方向算出需要的半高。 */
function orthoHalf(box, aspect) {
  const center = box.getCenter(new THREE.Vector3());
  const dir = new THREE.Vector3().subVectors(activeCamera.position, center).normalize();
  const up0 = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up0, dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  let halfW = 0;
  let halfH = 0;
  for (let i = 0; i < 8; i += 1) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(center);
    halfW = Math.max(halfW, Math.abs(corner.dot(right)));
    halfH = Math.max(halfH, Math.abs(corner.dot(up)));
  }
  return Math.max(halfH, halfW / Math.max(0.3, aspect)) * 1.06 + 0.3;
}

function fitOrthoCamera(dir) {
  const box = state.bounds;
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  controls.target.copy(center);
  activeCamera.position.copy(center).addScaledVector(dir, radius * 3 + 10);
  activeCamera.up.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.9) activeCamera.up.set(0, 0, -1);
  updateOrtho();
  controls.update();
}

/* ---------------------------- 拾取 ---------------------------- */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function toPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pick(event) {
  if (!state.showBoxes) return -1;
  toPointer(event);
  raycaster.setFromCamera(pointer, activeCamera);
  const hits = raycaster.intersectObjects(boxMeshes, false);
  return hits.length ? hits[0].object.userData.index : -1;
}

function onClick(event) {
  state.selectedBoxIndex = pick(event);
  applyBoxAlpha();
  renderBoxList();
  renderBoxInfo();
}

function onMove(event) {
  if (!state.showLabels || !state.showBoxes) { hoverLabel.style.display = 'none'; return; }
  const index = pick(event);
  if (index < 0) { hoverLabel.style.display = 'none'; return; }
  const box = state.hitParts[index];
  hoverLabel.textContent = `${box.name} · ${isReactiveArmor(box) ? '特殊' : `×${partValue(box, 'scaling')}`}`;
  hoverLabel.style.display = 'block';
  const rect = renderer.domElement.getBoundingClientRect();
  hoverLabel.style.left = `${event.clientX - rect.left}px`;
  hoverLabel.style.top = `${event.clientY - rect.top}px`;
}

/* ---------------------------- 侧栏 ---------------------------- */

function renderVehicleInfo() {
  const v = state.vehicle;
  document.getElementById('vehicleInfo').innerHTML = `
    <div class="card">
      <h3>${v.name}</h3>
      <div>
        <span class="pill">${v.category}</span>
        <span class="pill">${v.domain}</span>
        <span class="pill">${v.armor || '—'}</span>
      </div>
      <div class="kv" style="margin-top:8px">
        <span>总耐久</span><span>${v.hp ?? '—'}</span>
        <span>护盾</span><span>${v.shield ?? 0}</span>
        <span>直击伤害承受</span><span>${v.pointRate ?? '—'}</span>
        <span>爆炸伤害承受</span><span>${v.explodeRate ?? '—'}</span>
        <span>低血量提示</span><span>${v.lowHpRatio ?? '—'}</span>
        <span>外观网格</span><span>${(v.modelParts || []).filter((p) => !p.unplaced).length} 件</span>
      </div>
      ${(v.modelParts || []).some((p) => p.unplaced) ? `<div class="owner">
        另有 ${(v.modelParts || []).filter((p) => p.unplaced).length} 个部件（
        ${(v.modelParts || []).filter((p) => p.unplaced).map((p) => p.name).join('、')}）
        蓝图里没有给位置，运行时才由起落架/倾转系统摆放，这里不画以免穿模。</div>` : ''}
    </div>
    <div class="card">
      <h3>独立部位（${v.parts.length}）</h3>
      ${v.parts.length ? v.parts.map((p) => `
        <div class="kv">
          <span>${p.kind}</span>
          <span>耐久 ${p.hp}${p.debuff && Object.keys(p.debuff).length
            ? ' · ' + Object.entries(p.debuff).map(([k, val]) => `${k}=${val}`).join('、') : ''}</span>
        </div>`).join('') : '<div class="kv"><span>无</span><span>该载具没有细分部位</span></div>'}
    </div>`;
}

function renderBoxList() {
  const list = state.hitParts.map((box, index) => `
    <div class="box-row ${index === state.selectedBoxIndex ? 'active' : ''}" data-index="${index}">
      <span>${box.name}</span>
      <span class="scaling">${isReactiveArmor(box) ? '特殊' : box.point && box.region !== 'turret' ? (box.visual?.source === 'collision' ? '碰撞网格' : box.visual?.source === 'model' ? '外观' : '未定位') : `×${box.scaling}`}${box.ignore ? ' · 不结算' : ''}</span>
    </div>`).join('');
  boxListEl = document.getElementById('boxListCard');

  const armorNote = state.hitParts.some(isReactiveArmor)
    ? '<div class="owner armor-note">反应装甲倍率为特殊，在此不展开说明。</div>' : '';
  boxListEl.innerHTML = `<div class="card"><h3>命中部位（${state.hitParts.length}）</h3>${
    list || '<div class="kv"><span>无</span><span>该载具没有细分命中盒</span></div>'}${armorNote}</div>`;
  boxListEl.querySelectorAll('.box-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedBoxIndex = Number(row.dataset.index);
      applyBoxAlpha();
      renderBoxList();
      renderBoxInfo();
    });
  });
}

function renderBoxInfo() {
  const holder = document.getElementById('boxInfo');
  if (state.selectedBoxIndex < 0) {
    holder.innerHTML = `<div class="card"><h3>命中部位详情</h3>
      <div class="kv"><span>提示</span><span>在列表或三维视图中点击一个部位</span></div></div>`;
    return;
  }
  const box = state.hitParts[state.selectedBoxIndex];
  if (isReactiveArmor(box)) {
    holder.innerHTML = `<div class="card"><h3>${box.name}</h3>
      <div class="kv"><span>伤害倍率</span><span>特殊</span></div>
      <div class="owner armor-note">反应装甲倍率为特殊，在此不展开说明。</div></div>`;
    return;
  }
  const parts = state.vehicle.parts.filter((p) => box.members.some((member) => member.instance === p.id));
  const angles = box.angles.map((a) => `${a.from}–${a.to}° = ×${a.scale}`).join('<br>');
  const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
  const anti = box.antiVehicle.length
    ? box.antiVehicle.map((c) => `${c.weapon}：部位完好时减伤 ${pct(c.BodyPartIntactDamageReduction)}`
      + `、部位损坏后加成 ${pct(c.BodyPartBrokenDamageBonus)}`).join('<br>')
    : '—';
  holder.innerHTML = `
    <div class="card">
      <h3>${box.name}</h3>
      ${box.displayOnly ? `<div class="owner">普通${box.name}，部位倍率 ×1.0；着色框表示${box.name}范围。</div>` : box.point ? `<div class="kv"><span>显示说明</span><span>${box.visual?.source === 'collision'
        ? '此部位没有独立长方体；高亮使用对应部件的现有碰撞网格。'
        : box.visual?.source === 'model'
          ? '反应装甲：未提供独立碰撞网格，着色范围不代表独立伤害判定体。'
          : '此记录没有可确认的位置或关联模型，不在三维视图中绘制。'}</span></div>` : box.members.length > 1 ? '<div class="owner">同一部位合为一个显示框，覆盖原有各段的范围。</div>' : ''}
      <div class="kv">
        <span>伤害倍率</span><span>×${partValue(box, 'scaling')}</span>
        <span>爆炸衰减倍率</span><span>×${partValue(box, 'radiusScaling')}</span>
        <span>命中盒自带减伤</span><span>${partValue(box, 'intactReduction') ?? '无'}</span>
        <span>忽略伤害</span><span>${box.ignore ? '是（装饰件）' : '否'}</span>
        <span>对应部位</span><span>${parts.length ? parts.map((part) => `${part.kind}（耐久 ${part.hp}）`).join('、') : bodyPartName(state.vehicle)}</span>
        ${!box.point && !box.displayOnly && box.members.length === 1 ? `<span>半尺寸(米)</span><span>${box.extent.map((e) => (e / 100).toFixed(2)).join(' × ')}</span>` : ''}
      </div>
    </div>
    <div class="card">
      <h3>入射角修正</h3>
      <div class="kv"><span>角度区间</span><span>${angles || '—'}</span></div>
    </div>
    <div class="card">
      <h3>反载具武器覆盖</h3>
      <div class="kv"><span>武器</span><span>${anti}</span></div>
      ${box.antiVehicle.length ? '<div class="owner">同一部位对「完好 / 已损坏」两种状态，'
        + '只有名单里的武器结算不同；不在名单里的武器按上面的伤害倍率直接结算。</div>' : ''}
    </div>`;
}

/* ------------------------- 甲弹对抗 ------------------------- */


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function renderSimulator() {
  const sim = state.sim;
  const vehicle = state.data.vehicles.find((item) => item.id === sim.targetId && item.domain === sim.domain);
  const targets = state.data.vehicles.filter((item) => item.domain === sim.domain);
  const boxes = vehicle ? groupHitBoxes(vehicle).filter((part) => !part.point && !part.displayOnly) : [];
  if (!Number.isInteger(sim.boxIndex) || sim.boxIndex < -1 || sim.boxIndex >= boxes.length) sim.boxIndex = -1;
  if (!state.data.angleModes[sim.angle]) sim.angle = 0;
  const entries = ['gadgets', 'weapons'].includes(sim.weaponType) ? state.data[sim.weaponType] : [];
  if (!Number.isInteger(sim.weaponIndex) || !entries[sim.weaponIndex]) sim.weaponIndex = -1;
  const chosen = sim.weaponIndex >= 0 ? { row: entries[sim.weaponIndex], table: sim.weaponType } : null;
  const box = sim.boxIndex >= 0 ? boxes[sim.boxIndex] : null;
  const angle = state.data.angleModes[sim.angle];
  const option = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  const fill = (id, html, value, disabled = false) => {
    const select = document.getElementById(id);
    select.innerHTML = html;
    select.value = String(value);
    select.disabled = disabled;
  };

  fill('simDomain', option('', '请选择目标类型')
    + [...new Set(state.data.vehicles.map((item) => item.domain))].map((domain) => option(domain, domain)).join(''), sim.domain);
  fill('simTarget', option('', sim.domain ? '请选择具体载具' : '请先选择目标类型')
    + targets.map((target) => option(target.id, target.name)).join(''), vehicle?.id ?? '', !sim.domain);
  fill('simPart', option(-1, vehicle ? `${bodyPartName(vehicle)}（无部位加成）` : '请先选择载具')
    + boxes.map((part, index) => option(index, `${part.name} ×${part.scaling}`)).join(''), sim.boxIndex, !vehicle);
  fill('simAngle', state.data.angleModes.map((mode, index) => option(index, mode.label)).join(''), sim.angle, !vehicle);
  document.getElementById('combatTargetSummary').textContent = vehicle
    ? `${vehicle.name} · ${vehicle.armor || vehicle.armorKey} · 总耐久 ${vehicle.hp}`
    : '选择目标后，可设置击中位置和入射角。';

  document.getElementById('weaponSelection').disabled = !vehicle;
  document.getElementById('simWeaponType').value = sim.weaponType;
  const weaponGroups = new Map();
  entries.forEach((row, index) => {
    const group = sim.weaponType === 'weapons' ? (row.vehicle || '多车通用') : (row.group || '步兵武器');
    if (!weaponGroups.has(group)) weaponGroups.set(group, []);
    // value 使用条目索引，避免不同载具的同名武器互相串用伤害参数。
    const label = sim.weaponType === 'weapons' ? `${group} · ${row.name}` : row.name;
    weaponGroups.get(group).push(option(index, label));
  });
  fill('simWeapon', option('', sim.weaponType ? '请选择具体武器' : '请先选择武器类别')
    + Array.from(weaponGroups, ([name, options]) => `<optgroup label="${escapeHtml(name)}">${options.join('')}</optgroup>`).join(''),
    sim.weaponIndex < 0 ? '' : sim.weaponIndex, !vehicle || !sim.weaponType);
  document.getElementById('combatWeaponSummary').textContent = !vehicle ? '请先选择目标载具。'
    : chosen ? (chosen.table === 'weapons' ? `来源载具：${chosen.row.vehicle || '多车通用'}` : chosen.row.owner || '步兵武器')
      : sim.weaponType ? '选择具体武器后，自动计算伤害。' : '按步兵武器或载具武器选择。';

  const result = vehicle && chosen ? simulateHit(chosen.row, vehicle, box, angle.scale) : null;
  document.getElementById('combatResult').innerHTML = result
    ? simResultHtml(chosen, vehicle, box, angle, result)
    : `<div class="empty-state">${vehicle ? '选择武器类别和具体武器，查看伤害结果。' : '选择目标和武器后，显示伤害结果与计算过程。'}</div>`;
}

function simResultHtml(chosen, vehicle, box, angle, result) {
  const weaponName = chosen.table === 'weapons'
    ? `${chosen.row.vehicle || '多车通用'} · ${chosen.row.name}` : chosen.row.name;
  const lines = result.rows.map((row) => `
    <tr>
      <td>${row.kind}</td>
      <td class="num">${round1(row.base)}</td>
      <td class="num">×${row.coefficient}</td>
      <td class="num">×${row.multiplier}</td>
      <td class="num">${row.angle === 1 ? '—' : `×${row.angle}`}</td>
      <td class="num">×${row.received}</td>
      <td class="num primary">${round1(row.damage)}</td>
      <td class="owner">${row.note}</td>
    </tr>`).join('');
  const factor = result.percent;
  return `
    <div class="simhead">
      <div><b>${escapeHtml(weaponName)}</b> → ${escapeHtml(vehicle.name)}${box ? ` · ${box.name}` : ` · ${bodyPartName(vehicle)}整体`} · ${angle.label}</div>
      <div class="bignum">${round1(result.total)} <span>点</span></div>
      <div class="owner">掉 ${factor.toFixed(2)}% 总耐久　→　血条显示 <b>${result.bar.toFixed(1)}</b></div>
    </div>
    <div class="result-table"><table class="damagetable simtable">
      <thead><tr><th>段</th><th class="num">基础</th><th class="num">护甲系数</th>
      <th class="num">部位/衰减倍率</th><th class="num">角度</th><th class="num">载具承受</th><th class="num primary">小计</th><th>说明</th></tr></thead>
      <tbody>${lines}</tbody>
    </table></div>
    <div class="explainbox simnote">
      <div class="formula">对「${vehicle.name}」的伤害 ＝ Σ（每段基础伤害 × 该弹种对${vehicle.armor || vehicle.armorKey}的系数 × 命中倍率 × 角度 × 载具承受倍率）</div>
      <div class="owner"><b>直击段</b>使用命中部位倍率、当前角度方案和载具直击承受倍率；
      <b>爆炸段</b>使用命中部位的爆炸倍率和载具爆炸承受倍率，不受入射角影响。</div>
    </div>`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** 独立修理规则页，沿用原有数据。 */
function renderPlainTable(area, source) {
  if (!source || !source.length) { area.innerHTML = '暂无数据'; return; }
  const columns = Object.keys(source[0]);
  const head = columns.map((c) => `<th>${c}</th>`).join('');
  const body = source.map((row) => `<tr>${
    columns.map((c) => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`).join('');
  area.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------------------------- 渲染循环 ---------------------------- */

function animate() {
  requestAnimationFrame(animate);
  if (state.page !== 'home') return;
  controls.update();
  renderer.render(scene, activeCamera);
  updateLabels();
}

function updateLabels() {
  if (!state.showLabels || !state.vehicle) {
    labelLayer.querySelectorAll('.label:not(#hoverLabel)').forEach((el) => el.remove());
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const nodes = Array.from(labelLayer.children).filter((el) => el !== hoverLabel);
  const labels = [];
  state.hitParts.forEach((box, index) => {
    let node = nodes[index];
    if (!node) {
      node = document.createElement('div');
      node.className = 'label';
      labelLayer.appendChild(node);
    }
    const visual = hitVisuals[index];
    const text = box.name;
    if (node.textContent !== text) node.textContent = text;
    if (!visual || !state.showBoxes) { node.style.display = 'none'; return; }
    const position = visual.object.localToWorld(visual.anchor.clone()).project(activeCamera);
    const x = (position.x * 0.5 + 0.5) * rect.width;
    const y = (-position.y * 0.5 + 0.5) * rect.height;
    const visible = position.z >= -1 && position.z < 1 && x > 0 && y > 0 && x < rect.width && y < rect.height;
    node.style.display = visible ? 'block' : 'none';
    node.style.opacity = index === state.selectedBoxIndex ? '1' : '0.72';
    if (visible) labels.push({ node, x, y, width: node.offsetWidth + 6, height: node.offsetHeight + 4 });
  });
  // 按画面从上到下排开相邻标签，保留炮塔在上、履带在下的空间关系。
  const toolbar = document.getElementById('layerbar');
  const topLimit = toolbar.offsetTop + toolbar.offsetHeight + 8;
  const occupied = [];
  labels.sort((a, b) => a.y - b.y).forEach((label) => {
    label.y = Math.max(label.y, topLimit + label.height / 2);
    occupied.forEach((previous) => {
      if (Math.abs(label.x - previous.x) < (label.width + previous.width) / 2
        && Math.abs(label.y - previous.y) < (label.height + previous.height) / 2) {
        label.y = previous.y + (label.height + previous.height) / 2;
      }
    });
    label.node.style.left = `${label.x}px`;
    label.node.style.top = `${label.y}px`;
    occupied.push(label);
  });
  nodes.slice(state.hitParts.length).forEach((el) => el.remove());
}
// 供截图脚本/调试使用
window.__viewer = { state, setView, selectVehicle, fitCamera };
