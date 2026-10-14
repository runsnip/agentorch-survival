// Gear worn over an outfit: glasses, a neck wrap, a vest, a pack, and a colourway for the outfit.
// Every outfit already has its own headwear and gloves, so there are no slots for those.
//
// Pieces are built in body space at the rest pose — measured from the outfit's own mesh (chest front and
// back, neck, eyes) — then attached to the bone they move with (head, chest), so they follow
// every animation. Head and neck gear go on the head bone, which the first-person view hides.
//
//   dress(body, loadout)       body from makeBody(); loadout { eyes, neck, vest, back, tint }
//   randomLoadout(rnd)          a loadout for a bot
//   SLOTS                       what the wardrobe offers, slot → [[id, name], …]

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { t } from '/i18n.js';

export const SLOTS = {
  eyes: [['', t('Không')], ['shades', t('Kính râm')], ['goggles', t('Kính bảo hộ')], ['tactical', t('Kính chiến thuật')]],
  neck: [['', t('Không')], ['gaiter', t('Khăn ống')], ['scarf', t('Khăn quàng')]],
  vest: [['', t('Không')], ['rig', t('Đai đeo ngực')], ['plate', t('Áo giáp tấm')]],
  back: [['', t('Không')], ['pack', t('Ba lô nhỏ')], ['ruck', t('Ba lô lớn')], ['sling', t('Túi đeo chéo')]],
  tint: [['', t('Màu gốc')], ['desert', t('Sa mạc')], ['woodland', t('Rừng')], ['urban', t('Đô thị')], ['night', t('Đêm')]],
};
export const SLOT_NAMES = { eyes: t('Kính'), neck: t('Khăn'), vest: t('Áo giáp'), back: t('Ba lô'), tint: t('Tông màu') };
const TINTS = { desert: 0xd9c49a, woodland: 0x9aae84, urban: 0xb4bcc6, night: 0x5a6070 };
const GEAR = { tan: 0x8f7a55, olive: 0x4f5a3a, black: 0x1d1f23, grey: 0x4a4f57 };

export function randomLoadout(rnd = Math.random) {
  const pick = (k, p) => (rnd() < p ? SLOTS[k][1 + Math.floor(rnd() * (SLOTS[k].length - 1))][0] : '');
  return { eyes: pick('eyes', 0.35), neck: pick('neck', 0.3), vest: pick('vest', 0.5), back: pick('back', 0.55), tint: pick('tint', 0.4) };
}

// ---------------------------------------------------------------- measuring the outfit

const _v = new THREE.Vector3();
const findBone = (bones, re, side) => Object.values(bones).find((b) => re.test(b.name) && (!side || new RegExp(`(^|[ _])${side}([ _]|$)`).test(b.name)));
const at = (g, x, y, z, rx = 0, ry = 0, rz = 0) => g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));

function rounded(w, h, d, r = 0.02) {
  const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3), p = g.attributes.position, v = new THREE.Vector3();
  r = Math.min(r, w / 2, h / 2, d / 2);
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const c = new THREE.Vector3(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    v.sub(c).normalize().multiplyScalar(r).add(c);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// body-space points of the rest pose, and the mesh's extent around the chest and the neck
function measure(body) {
  body.group.updateMatrixWorld(true);
  const toBody = (o) => body.group.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  const B = body.bones;
  const head = findBone(B, /head$/i), neck = findBone(B, /neck$/i), chest = findBone(B, /spine2$/i) || findBone(B, /spine1$/i);
  const m = { head, neck, chest, bones: {} };
  for (const s of ['L', 'R']) m.bones[s] = { hand: findBone(B, /hand$/i, s), finger: findBone(B, /finger2$/i, s), thumb: findBone(B, /finger0$/i, s) };
  m.H = toBody(head); m.N = toBody(neck); m.C = toBody(chest);
  for (const s of ['L', 'R']) { const b = m.bones[s]; b.h = toBody(b.hand); b.f = toBody(b.finger || b.hand); b.t = toBody(b.thumb || b.hand); }
  // the skin's surface: front and back of the chest, half-width of the neck, front of the face
  let front = -Infinity, back = Infinity, neckR = 0, face = -Infinity, wide = 0;
  const inv = new THREE.Matrix4().copy(body.group.matrixWorld).invert();
  body.model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position, mw = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i += 3) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      if (Math.abs(_v.y - m.C.y) < 0.06 && Math.abs(_v.x - m.C.x) < 0.1) { front = Math.max(front, _v.z); back = Math.min(back, _v.z); }
      if (Math.abs(_v.y - m.C.y) < 0.06) wide = Math.max(wide, Math.abs(_v.x - m.C.x));
      if (Math.abs(_v.y - (m.N.y + 0.03)) < 0.025) neckR = Math.max(neckR, Math.hypot(_v.x - m.N.x, _v.z - m.N.z));
      if (Math.abs(_v.y - (m.H.y + 0.08)) < 0.03 && Math.abs(_v.x - m.H.x) < 0.03) face = Math.max(face, _v.z);
    }
  });
  m.front = Number.isFinite(front) ? front : m.C.z + 0.12;
  m.back = Number.isFinite(back) ? back : m.C.z - 0.12;
  m.wide = Math.min(Math.max(wide, 0.16), 0.24);
  m.neckR = Math.min(Math.max(neckR, 0.055), 0.09);
  m.face = Number.isFinite(face) ? face : m.H.z + 0.1;
  return m;
}

// ---------------------------------------------------------------- the pieces (body space, facing +z)

const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.05, ...o });
const LENS = { shades: mat(0x0b0d10, { roughness: 0.08, metalness: 0.8 }), goggles: mat(0xd88a2a, { roughness: 0.1, metalness: 0.5, transparent: true, opacity: 0.8 }),
  tactical: mat(0x223a4a, { roughness: 0.05, metalness: 0.9 }) };

function eyes(m, kind) {
  const g = new THREE.Group(), y = m.H.y + 0.085, z = m.face + 0.012, frame = mat(GEAR.black, { roughness: 0.4 });
  if (kind === 'goggles') {
    g.add(new THREE.Mesh(rounded(0.17, 0.06, 0.04, 0.02), frame).translateX(m.H.x).translateY(y).translateZ(z - 0.01));
    g.add(new THREE.Mesh(rounded(0.15, 0.045, 0.02, 0.015), LENS.goggles).translateX(m.H.x).translateY(y).translateZ(z + 0.008));
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.008, 6, 24, Math.PI * 1.2).rotateX(Math.PI / 2).rotateY(Math.PI * 0.4), frame).translateX(m.H.x).translateY(y).translateZ(z - 0.09));
  } else {
    const lens = LENS[kind] || LENS.shades;
    for (const sx of [-1, 1]) g.add(new THREE.Mesh(rounded(0.058, kind === 'tactical' ? 0.036 : 0.04, 0.008, 0.012), lens).translateX(m.H.x + sx * 0.034).translateY(y).translateZ(z));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.008, 0.008), frame).translateX(m.H.x).translateY(y + 0.018).translateZ(z));
    for (const sx of [-1, 1]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.11), frame).translateX(m.H.x + sx * 0.07).translateY(y + 0.015).translateZ(z - 0.055));
  }
  return g;
}

function neck(m, kind) {
  const cloth = mat(kind === 'scarf' ? 0x7a2e2a : GEAR.olive, { roughness: 0.95 }), r = m.neckR + 0.012;
  const g = new THREE.Group();
  if (kind === 'gaiter') g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.01, 0.09, 20, 1, true), Object.assign(cloth, { side: THREE.DoubleSide })).translateX(m.N.x).translateY(m.N.y + 0.04).translateZ(m.N.z));
  else {
    g.add(new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.022, 8, 24).rotateX(Math.PI / 2), cloth).translateX(m.N.x).translateY(m.N.y + 0.01).translateZ(m.N.z));
    g.add(new THREE.Mesh(rounded(0.06, 0.16, 0.025, 0.01), cloth).translateX(m.N.x + 0.04).translateY(m.N.y - 0.08).translateZ(m.N.z + r + 0.03).rotateZ(0.12));
  }
  return g;
}

function vest(m, kind) {
  const g = new THREE.Group(), c = mat(kind === 'plate' ? GEAR.olive : GEAR.tan), dark = mat(GEAR.black);
  const y = m.C.y - 0.02, w = m.wide * 1.55;
  if (kind === 'plate') {
    g.add(new THREE.Mesh(rounded(w, 0.36, 0.05, 0.03), c).translateX(m.C.x).translateY(y).translateZ(m.front + 0.022));
    g.add(new THREE.Mesh(rounded(w, 0.38, 0.05, 0.03), c).translateX(m.C.x).translateY(y + 0.01).translateZ(m.back - 0.022));
    for (const sx of [-1, 1]) g.add(new THREE.Mesh(rounded(0.05, 0.16, m.front - m.back + 0.04, 0.015), c).translateX(m.C.x + sx * (w / 2 - 0.02)).translateY(y - 0.08).translateZ((m.front + m.back) / 2));
    for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(rounded(0.075, 0.1, 0.045, 0.012), dark).translateX(m.C.x + (i - 1) * 0.085).translateY(y - 0.1).translateZ(m.front + 0.066));
  } else {
    g.add(new THREE.Mesh(rounded(w * 0.92, 0.17, 0.035, 0.02), c).translateX(m.C.x).translateY(y - 0.09).translateZ(m.front + 0.016));
    for (let i = 0; i < 4; i++) g.add(new THREE.Mesh(rounded(0.06, 0.11, 0.045, 0.012), c).translateX(m.C.x + (i - 1.5) * 0.068).translateY(y - 0.08).translateZ(m.front + 0.05));
  }
  // shoulder straps over to the back
  for (const sx of [-1, 1]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, m.front - m.back + 0.06), dark).translateX(m.C.x + sx * 0.09).translateY(m.N.y - 0.07).translateZ((m.front + m.back) / 2));
  return g;
}

function back(m, kind) {
  const g = new THREE.Group(), c = mat(kind === 'sling' ? GEAR.black : kind === 'ruck' ? GEAR.olive : GEAR.grey), strap = mat(GEAR.black);
  if (kind === 'sling') {
    g.add(new THREE.Mesh(rounded(0.24, 0.2, 0.09, 0.03), c).translateX(m.C.x + 0.08).translateY(m.C.y - 0.12).translateZ(m.back - 0.05).rotateZ(-0.35));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.012), strap).translateX(m.C.x).translateY(m.C.y + 0.02).translateZ(m.front + 0.012).rotateZ(0.7));
    return g;
  }
  const big = kind === 'ruck', w = big ? 0.36 : 0.3, h = big ? 0.5 : 0.38, d = big ? 0.2 : 0.14;
  const y = m.C.y - (big ? 0.06 : 0.04);
  g.add(new THREE.Mesh(rounded(w, h, d, 0.05), c).translateX(m.C.x).translateY(y).translateZ(m.back - d / 2 + 0.01));
  g.add(new THREE.Mesh(rounded(w * 0.7, h * 0.32, 0.05, 0.02), c).translateX(m.C.x).translateY(y - h * 0.18).translateZ(m.back - d - 0.015));
  if (big) g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, w + 0.04, 16).rotateZ(Math.PI / 2), mat(0x5a4a38)).translateX(m.C.x).translateY(y + h / 2 + 0.05).translateZ(m.back - d / 2));
  for (const sx of [-1, 1]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, m.front - m.back + 0.04), strap).translateX(m.C.x + sx * 0.08).translateY(m.N.y - 0.07).translateZ((m.front + m.back) / 2));
  return g;
}

// ---------------------------------------------------------------- wearing it

const measured = new WeakMap();   // asset → measurement in body space (the same for every copy of an outfit)

export function dress(body, loadout = {}) {
  undress(body);
  if (!measured.has(body.asset)) measured.set(body.asset, measure(body));
  const m = { ...measured.get(body.asset) };
  // this copy's own bones (measured once on the first copy: the same skeleton, other objects)
  const B = body.bones, own = (b) => b && B[b.name];
  m.head = own(m.head); m.neck = own(m.neck); m.chest = own(m.chest);
  m.bones = Object.fromEntries(Object.entries(m.bones).map(([s, b]) => [s, { ...b, hand: own(b.hand), finger: own(b.finger), thumb: own(b.thumb) }]));
  body.group.updateMatrixWorld(true);
  const worn = [];
  const wear = (obj, bone) => {
    if (!obj || !bone) return;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    body.group.add(obj);
    obj.updateMatrixWorld(true);
    bone.attach(obj);   // keeps where it is, follows the bone from now on
    worn.push(obj);
  };
  if (loadout.eyes) wear(eyes(m, loadout.eyes), m.head);
  if (loadout.neck) wear(neck(m, loadout.neck), m.head);
  if (loadout.vest) wear(vest(m, loadout.vest), m.chest);
  if (loadout.back) wear(back(m, loadout.back), m.chest);
  // the outfit's colourway: its own materials, tinted
  body.model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.userData.baseMaterial ||= o.material;   // the outfit's own colours, kept to go back to
    if (!loadout.tint || !TINTS[loadout.tint]) { o.material = o.userData.baseMaterial; return; }
    const tinted = [].concat(o.userData.baseMaterial).map((mt) => { const c = mt.clone(); c.color.multiply(new THREE.Color(TINTS[loadout.tint])); return c; });
    o.material = tinted.length === 1 ? tinted[0] : tinted;
  });
  body.worn = worn;
  return body;
}

export function undress(body) {
  for (const o of body.worn || []) o.removeFromParent();
  body.worn = [];
}
