// Weapons: the stats the match uses and the 3D models shown in hand, on bots and on the ground.
//
// Every model is built in the same frame: the firing hand's grip at the origin,
// the barrel along −z, up is +y. `support` is where the other hand goes,
// `sightY` the height of the sight line above the grip, `muzzle` the barrel tip.

import * as THREE from 'three';
import { t } from '/i18n.js';

export const AMMO = { '9mm': '9mm', '556': '5.56', '762': '7.62', '12g': '12 gauge' };

// Names are made up for this game. `spread` is the hip-fire cone (radians) for a
// first shot standing still; aiming down sights narrows it to `ads` of that, and
// `bloom` is added per shot in sustained fire, recovering in a fraction of a second.
export const WEAPONS = {
  orvel:   { name: 'Orvel 9',  cat: 'pistol', ammo: '9mm', dmg: 26, rate: 0.17, mag: 15, reload: 1.6, spread: 0.008, ads: 0.15, bloom: 0.004, range: 100, tier: 1, color: 0x2a2b2e, auto: false },
  kestrix: { name: 'Kestrix',  cat: 'smg',    ammo: '9mm', dmg: 21, rate: 0.07, mag: 30, reload: 2.0, spread: 0.01,  ads: 0.2,  bloom: 0.002, range: 140, tier: 2, color: 0x1f2124, auto: true },
  vantor:  { name: 'Vantor 5', cat: 'ar',     ammo: '556', dmg: 27, rate: 0.092, mag: 30, reload: 2.3, spread: 0.008, ads: 0.12, bloom: 0.0018, range: 220, tier: 3, color: 0x2b2a27, auto: true },
  draxis:  { name: 'Draxis 7', cat: 'ar',     ammo: '762', dmg: 33, rate: 0.11, mag: 30, reload: 2.6, spread: 0.01,  ads: 0.14, bloom: 0.0028, range: 220, tier: 3, color: 0x6b4a2c, auto: true },
  selvar:  { name: 'Selvar M', cat: 'dmr',    ammo: '762', dmg: 46, rate: 0.3,  mag: 15, reload: 2.8, spread: 0.012, ads: 0.05, bloom: 0.003, range: 400, tier: 4, color: 0x3d4434, auto: false, scope: 3 },
  tharn:   { name: 'Tharn 3',  cat: 'sr',     ammo: '762', dmg: 92, rate: 1.35, mag: 5,  reload: 3.4, spread: 0.03,  ads: 0.01, bloom: 0,     range: 600, tier: 5, color: 0x4a3a28, auto: false, scope: 6 },
  bruhn:   { name: 'Bruhn 12', cat: 'sg',     ammo: '12g', dmg: 13, pellets: 9, rate: 0.85, mag: 6, reload: 3.0, spread: 0.05, ads: 0.75, bloom: 0, range: 35, tier: 2, color: 0x5a3d22, auto: false },
};
export const CAT_LABEL = { pistol: t('Súng lục'), smg: t('Tiểu liên'), ar: t('Súng trường'), dmr: t('Súng bắn tỉa bán tự động'), sr: t('Súng bắn tỉa'), sg: t('Súng hoa cải') };

// ---------------------------------------------------------------- materials

let mats = null;
function materials() {
  if (mats) return mats;
  mats = {
    anodized: new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.55, roughness: 0.42 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x1d1e20, metalness: 0.85, roughness: 0.32 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x141517, metalness: 0.3, roughness: 0.6 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x1f2023, metalness: 0.02, roughness: 0.78 }),
    port: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, metalness: 0.2, roughness: 0.9 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb08a3e, metalness: 0.9, roughness: 0.35 }),
    lens: new THREE.MeshStandardMaterial({ color: 0x1b3550, metalness: 0.9, roughness: 0.06, emissive: 0x061020 }),
    furniture: new Map(),
  };
  return mats;
}
function furniture(color) {
  const m = materials();
  if (!m.furniture.has(color)) {
    const wood = (color >> 16) > 0x45;  // brown tones read as wood: a little shinier, warmer
    m.furniture.set(color, new THREE.MeshStandardMaterial({ color, metalness: 0.03, roughness: wood ? 0.48 : 0.74 }));
  }
  return m.furniture.get(color);
}

// ---------------------------------------------------------------- shape helpers
//
// Parts are side profiles: a polygon in (z, y) — z forward is negative — pushed
// out to a thickness across x, with bevelled edges. That's how a gun reads: by
// its silhouette.

const geoCache = new Map();
function profile(key, pts, width, bevel = 0.0025, curves = 1) {
  if (!geoCache.has(key)) {
    const s = new THREE.Shape();
    pts.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y)));
    s.closePath();
    const b = Math.min(bevel, width / 3);
    const g = new THREE.ExtrudeGeometry(s, { depth: width - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b * 0.8, bevelSegments: 2, curveSegments: curves });
    g.rotateY(-Math.PI / 2);                 // profile x → world z, extrusion → world −x
    g.translate((width - 2 * b) / 2, 0, 0);
    g.computeVertexNormals();
    geoCache.set(key, g);
  }
  return geoCache.get(key);
}
function tube(key, r0, r1, len, seg = 20) {
  if (!geoCache.has(key)) { const g = new THREE.CylinderGeometry(r1, r0, len, seg); g.rotateX(-Math.PI / 2); geoCache.set(key, g); }
  return geoCache.get(key);       // r0 at the back (+z end), r1 at the front
}
function box(key, w, h, d) {
  if (!geoCache.has(key)) geoCache.set(key, profile(key + 'p', [[d / 2, -h / 2], [-d / 2, -h / 2], [-d / 2, h / 2], [d / 2, h / 2]], w, Math.min(w, h, d) * 0.2));
  return geoCache.get(key);
}
function put(g, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  g.add(m);
  return m;
}
// a tube along z from z0 (back) to z1 (front) at height y
const barrel = (g, key, r0, r1, z0, z1, y, mat, seg) => put(g, tube(key, r0, r1, z0 - z1, seg), mat, 0, y, (z0 + z1) / 2);
// picatinny rail: a strip with teeth
function rail(g, key, z0, z1, y, mats) {
  put(g, box(key + 'b', 0.021, 0.006, z0 - z1), mats.dark, 0, y, (z0 + z1) / 2);
  for (let z = z0 - 0.006; z > z1 + 0.004; z -= 0.01) put(g, box('tooth', 0.022, 0.004, 0.005), mats.dark, 0, y + 0.004, z);
}

// ---------------------------------------------------------------- models

function scopeOn(g, M, y, z0, len, zoom) {
  const r = 0.017 + zoom * 0.0015;
  barrel(g, `sc-tube${zoom}`, r, r, z0, z0 - len, y, M.anodized, 24);
  barrel(g, `sc-obj${zoom}`, r * 1.05, r * 1.45, z0 - len, z0 - len - 0.06, y, M.anodized, 24);
  barrel(g, `sc-eye${zoom}`, r * 1.35, r * 1.1, z0 + 0.05, z0, y, M.anodized, 24);
  put(g, tube(`sc-turret`, 0.011, 0.011, 0.02, 14), M.anodized, 0, y + r + 0.006, z0 - len * 0.5).rotation.x = Math.PI / 2;
  put(g, tube(`sc-turret`, 0.011, 0.011, 0.02, 14), M.anodized, r + 0.006, y, z0 - len * 0.5).rotation.set(0, Math.PI / 2, 0);
  put(g, tube(`sc-lens${zoom}`, r * 1.38, r * 1.38, 0.003, 24), M.lens, 0, y, z0 - len - 0.061);
  for (const zz of [z0 - len * 0.2, z0 - len * 0.8]) put(g, box('sc-ring', 0.024, 0.026, 0.016), M.anodized, 0, y - r - 0.008, zz);
  return y;
}

// returns { group, support, sightY, muzzle, mag, def }
// A finish from the inventory (Tab › Kho đồ): the gun's body and furniture in `color`, small parts in
// `accent`; `glow` lights the accent up, `metal` makes the body metal. Applied to the player's guns only.
const finishMats = new Map();
export function applyFinish(gun, finish) {
  if (!finish?.color) return gun;
  if (!finishMats.has(finish.id)) {
    const main = new THREE.MeshStandardMaterial({ color: finish.color, metalness: finish.metal ? 1 : 0.35, roughness: finish.metal ? 0.22 : 0.55 });
    const accent = new THREE.MeshStandardMaterial({ color: finish.accent || finish.color, metalness: 0.5, roughness: 0.4,
      emissive: finish.glow ? (finish.accent || finish.color) : 0x000000, emissiveIntensity: finish.glow ? 1.3 : 0 });
    finishMats.set(finish.id, { main, accent });
  }
  const { main, accent } = finishMats.get(finish.id), M = materials();
  gun.group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material === M.anodized || o.material === M.polymer || [...M.furniture.values()].includes(o.material)) o.material = main;
    else if (o.material === M.dark) o.material = accent;
  });
  return gun;
}

export function buildGun(id) {
  const d = WEAPONS[id], M = materials(), F = furniture(d.color);
  const g = new THREE.Group();
  let support, sightY, muzzle, mag;
  const wood = (d.color >> 16) > 0x45;
  switch (d.cat) {
    case 'pistol': {
      // slide with rear serrations, frame with rail, angled grip
      put(g, profile('p-slide', [[0.03, 0.045], [-0.165, 0.045], [-0.17, 0.05], [-0.168, 0.077], [0.024, 0.08], [0.032, 0.072]], 0.029, 0.003), M.anodized);
      for (let i = 0; i < 7; i++) put(g, box('p-serr', 0.0295, 0.026, 0.002), M.dark, 0, 0.062, 0.02 - i * 0.0045);
      put(g, box('p-port', 0.004, 0.012, 0.035), M.port, 0.013, 0.07, -0.035);
      put(g, profile('p-frame', [[0.035, 0.045], [-0.15, 0.045], [-0.15, 0.025], [-0.06, 0.022], [-0.04, 0.005], [0.0, 0.006], [0.035, 0.025]], 0.026, 0.003), M.polymer);
      put(g, profile('p-guard', [[-0.005, 0.012], [-0.06, 0.012], [-0.06, 0.0], [-0.052, -0.006], [-0.005, -0.006], [-0.005, 0.0]], 0.012, 0.002), M.polymer);
      put(g, profile('p-grip', [[0.04, 0.03], [0.0, 0.01], [0.022, -0.085], [0.06, -0.085], [0.07, -0.072], [0.05, 0.02]], 0.03, 0.006, 4), F === furniture(0x2a2b2e) ? M.polymer : F);
      barrel(g, 'p-bore', 0.0055, 0.0055, -0.16, -0.172, 0.064, M.steel, 12);
      put(g, box('p-fs', 0.005, 0.009, 0.006), M.steel, 0, 0.084, -0.155);
      put(g, profile('p-rs', [[0.024, 0.078], [0.012, 0.078], [0.014, 0.089], [0.022, 0.089]], 0.022, 0.0015), M.steel);
      mag = put(g, profile('p-mag', [[0.05, -0.084], [0.024, -0.084], [0.025, -0.092], [0.064, -0.092], [0.066, -0.084]], 0.026, 0.002), M.dark);
      support = new THREE.Vector3(-0.035, -0.03, 0.0);
      sightY = 0.087; muzzle = new THREE.Vector3(0, 0.064, -0.175);
      break;
    }
    case 'ar': case 'dmr': case 'smg': {
      const L = d.cat === 'dmr' ? 1.15 : d.cat === 'smg' ? 0.7 : 1;
      const furn = wood || d.cat === 'dmr' ? F : M.polymer;
      // upper receiver, ejection port, forward assist, charging handle
      put(g, profile('ar-upper', [[0.075, 0.03], [-0.17, 0.03], [-0.17, 0.072], [-0.02, 0.074], [0.06, 0.074], [0.075, 0.066]], 0.04, 0.003), M.anodized);
      put(g, box('ar-port', 0.003, 0.014, 0.055), M.port, 0.0205, 0.052, -0.02);
      put(g, box('ar-portrim', 0.003, 0.003, 0.06), M.brass, 0.021, 0.045, -0.02);
      barrel(g, 'ar-fa', 0.008, 0.008, 0.06, 0.03, 0.06, M.anodized, 12).position.x = 0.022;
      put(g, profile('ar-ch', [[0.085, 0.066], [0.06, 0.066], [0.06, 0.074], [0.085, 0.074]], 0.04, 0.002), M.dark);
      rail(g, 'ar-toprail', 0.065, -0.17 - (d.scope ? 0 : 0.0), 0.077, M);
      // lower receiver: magwell, trigger guard, then the angled grip
      put(g, profile('ar-lower', [[0.07, 0.03], [-0.13, 0.03], [-0.13, 0.0], [-0.115, -0.03], [-0.045, -0.03], [-0.035, 0.0], [0.03, 0.0], [0.07, 0.012]], 0.038, 0.003), M.anodized);
      put(g, profile('ar-guard', [[0.028, 0.002], [-0.03, 0.002], [-0.03, -0.006], [-0.022, -0.014], [0.02, -0.014], [0.028, -0.006]], 0.012, 0.002), M.anodized);
      put(g, profile('ar-grip', [[0.05, 0.0], [0.018, 0.0], [0.04, -0.092], [0.075, -0.098], [0.08, -0.088], [0.064, -0.012]], 0.031, 0.006, 4), furn);
      // curved magazine
      const magPts = d.cat === 'smg'
        ? [[-0.05, -0.005], [-0.105, -0.005], [-0.118, -0.06], [-0.14, -0.125], [-0.108, -0.135], [-0.088, -0.07], [-0.06, -0.02]]
        : [[-0.048, -0.005], [-0.112, -0.005], [-0.125, -0.06], [-0.15, -0.155], [-0.103, -0.168], [-0.08, -0.08], [-0.06, -0.025]];
      mag = put(g, profile(`mag-${d.cat}`, magPts, 0.027, 0.003, 2), M.dark);
      // handguard: a rounded tube with side rails and slots, then the barrel
      const hg0 = -0.17, hg1 = -0.17 - 0.25 * L;
      barrel(g, `ar-hg${L}`, 0.025, 0.024, hg0, hg1, 0.05, furn, 10);
      for (let z = hg0 - 0.03; z > hg1 + 0.02; z -= 0.035) for (const x of [-0.022, 0.022]) put(g, box('ar-slot', 0.006, 0.009, 0.02), M.port, x, 0.05, z);
      rail(g, `ar-hgrail${L}`, hg0, hg1 + 0.02, 0.076, M);
      const bEnd = hg1 - 0.13 * L - (d.cat === 'dmr' ? 0.08 : 0);
      barrel(g, `ar-barrel${L}${d.cat}`, 0.009, 0.0085, hg1, bEnd, 0.052, M.steel, 14);
      barrel(g, 'ar-gas', 0.013, 0.013, hg1 - 0.012, hg1 - 0.04, 0.052, M.steel, 14);
      put(g, profile('ar-fs', [[0.008, 0.06], [-0.008, 0.06], [-0.004, 0.1], [0.004, 0.1]], 0.012, 0.002), M.steel).position.z = hg1 - 0.03;
      barrel(g, 'ar-brake', 0.013, 0.012, bEnd, bEnd - 0.055, 0.052, M.dark, 12);
      for (let i = 0; i < 3; i++) put(g, box('ar-brakeslot', 0.027, 0.004, 0.006), M.port, 0, 0.06, bEnd - 0.012 - i * 0.014);
      // buffer tube and stock (the sniper-ish DMR gets a fixed one)
      barrel(g, 'ar-buffer', 0.015, 0.015, 0.22, 0.07, 0.05, M.anodized, 16);
      put(g, profile(d.cat === 'dmr' ? 'dmr-stock' : 'ar-stock',
        d.cat === 'dmr'
          ? [[0.075, 0.07], [0.3, 0.075], [0.33, 0.07], [0.33, -0.06], [0.3, -0.065], [0.2, -0.02], [0.1, 0.0], [0.075, 0.02]]
          : [[0.13, 0.072], [0.29, 0.07], [0.31, 0.066], [0.31, -0.05], [0.29, -0.055], [0.22, -0.01], [0.15, 0.03], [0.13, 0.04]], 0.042, 0.006, 3), furn);
      put(g, box('ar-pad', 0.043, 0.125, 0.012), M.polymer, 0, 0.008, 0.315);
      if (d.scope) sightY = scopeOn(g, M, 0.115, 0.04, 0.15 + d.scope * 0.015, d.scope);
      else {  // flip-up rear aperture lined up with the front post
        put(g, profile('ar-rs', [[0.05, 0.08], [0.025, 0.08], [0.028, 0.1], [0.047, 0.1]], 0.02, 0.002), M.anodized);
        sightY = 0.098;
      }
      support = new THREE.Vector3(0, 0.05 - 0.028, hg0 - 0.08 * L);
      muzzle = new THREE.Vector3(0, 0.052, bEnd - 0.06);
      break;
    }
    case 'sr': {
      // bolt-action: one long stock with a pistol-grip wrist and a cheek rest
      put(g, profile('sr-stock', [[0.33, 0.065], [0.18, 0.06], [0.1, 0.035], [0.075, 0.035], [0.06, -0.01], [0.03, -0.095], [0.065, -0.1], [0.085, -0.03],
        [0.17, -0.025], [0.33, -0.07], [0.335, -0.06]], 0.042, 0.006, 4), F);
      put(g, profile('sr-fore', [[0.06, 0.045], [-0.4, 0.045], [-0.42, 0.03], [-0.4, 0.008], [-0.05, 0.0], [0.0, -0.005], [0.06, 0.0]], 0.044, 0.007, 3), F);
      barrel(g, 'sr-action', 0.017, 0.017, 0.07, -0.13, 0.06, M.steel, 20);
      const bolt = put(g, tube('sr-bolt', 0.004, 0.004, 0.05, 8), M.steel, 0.03, 0.06, 0.05); bolt.rotation.set(0, Math.PI / 2, 0.3);
      put(g, new THREE.SphereGeometry(0.009, 12, 8), M.steel, 0.055, 0.052, 0.05);
      barrel(g, 'sr-barrel', 0.012, 0.009, -0.13, -0.7, 0.058, M.steel, 16);
      barrel(g, 'sr-brake', 0.014, 0.014, -0.7, -0.76, 0.058, M.dark, 12);
      put(g, box('sr-pad', 0.044, 0.14, 0.014), M.polymer, 0, 0.0, 0.335);
      mag = put(g, box('sr-mag', 0.03, 0.04, 0.07), M.dark, 0, -0.015, -0.06);
      sightY = scopeOn(g, M, 0.11, 0.06, 0.24, d.scope);
      support = new THREE.Vector3(0, 0.02, -0.26);
      muzzle = new THREE.Vector3(0, 0.058, -0.77);
      break;
    }
    case 'sg': {
      put(g, profile('sg-recv', [[0.06, 0.03], [-0.16, 0.03], [-0.16, 0.085], [0.04, 0.085], [0.06, 0.075]], 0.044, 0.004), M.anodized);
      put(g, box('sg-port', 0.003, 0.02, 0.06), M.port, 0.0225, 0.062, -0.05);
      barrel(g, 'sg-barrel', 0.011, 0.011, -0.16, -0.64, 0.072, M.steel, 16);
      barrel(g, 'sg-tube', 0.012, 0.012, -0.16, -0.58, 0.042, M.steel, 16);
      const pump = put(g, profile('sg-pump', [[0.0, 0.025], [-0.17, 0.025], [-0.17, 0.062], [0.0, 0.062]], 0.05, 0.01, 3), F);
      pump.position.z = -0.24;
      for (let i = 0; i < 6; i++) put(g, box('sg-groove', 0.051, 0.003, 0.006), M.dark, 0, 0.03, -0.27 - i * 0.022);
      put(g, profile('sg-guard', [[0.03, 0.03], [-0.04, 0.03], [-0.04, 0.0], [-0.03, -0.01], [0.02, -0.01], [0.03, 0.0]], 0.014, 0.002), M.anodized);
      put(g, profile('sg-stock', [[0.06, 0.075], [0.13, 0.06], [0.33, 0.055], [0.34, 0.05], [0.34, -0.075], [0.32, -0.08], [0.13, -0.02], [0.07, -0.1], [0.035, -0.095], [0.055, 0.0], [0.06, 0.03]], 0.04, 0.006, 3), F);
      put(g, box('sg-pad', 0.041, 0.13, 0.014), M.polymer, 0, -0.012, 0.345);
      put(g, new THREE.SphereGeometry(0.004, 8, 6), M.brass, 0, 0.088, -0.635);
      mag = null;
      support = new THREE.Vector3(0, 0.044 - 0.028, -0.32);
      sightY = 0.092; muzzle = new THREE.Vector3(0, 0.072, -0.645);
      break;
    }
  }
  return { group: g, support, sightY, muzzle, mag, def: d };
}

// ---------------------------------------------------------------- muzzle flash

let flashTex = null;
export function muzzleFlash() {
  if (!flashTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, 'rgba(255,250,220,1)'); rg.addColorStop(0.25, 'rgba(255,200,90,.9)'); rg.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = rg;
    for (let i = 0; i < 5; i++) {   // a star of flame tongues
      g.save(); g.translate(64, 64); g.rotate(i * 1.2566);
      g.beginPath(); g.moveTo(0, -6); g.lineTo(64, 0); g.lineTo(0, 6); g.fill(); g.restore();
    }
    g.beginPath(); g.arc(64, 64, 26, 0, 7); g.fill();
    flashTex = new THREE.CanvasTexture(c);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.visible = false;
  return s;
}
