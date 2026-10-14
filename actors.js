// Characters: the app's model library (Rocketbox / Mixamo rigs), plus a
// two-bone arm IK used both for the first-person arms and for bots holding guns.
//
// Rigs disagree on bone axes, so nothing here relies on them: each hand's frame
// is measured from its own geometry (wrist → fingers, wrist → thumb) in the rest
// pose, and every pose is set as a rotation away from that measured frame.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const cache = new Map();
export const BODY_H = 1.78;

const LEFT_LEG = /(left.*(up.?leg|thigh))|((up.?leg|thigh).*([._]l$|left))|(^|_)l_thigh$/i;
const RIGHT_LEG = /(right.*(up.?leg|thigh))|((up.?leg|thigh).*([._]r$|right))|(^|_)r_thigh$/i;
const sideOf = (n) => (/right|(^|[^a-z])r([^a-z]|$)/i.test(n) ? 'R' : /left|(^|[^a-z])l([^a-z]|$)/i.test(n) ? 'L' : '');

export function loadAvatar(file) {
  if (!cache.has(file)) {
    cache.set(file, new Promise((ok, fail) => loader.load(file.includes('/') ? file : `/models/${encodeURIComponent(file)}`, (g) => {
      const root = g.scene;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      let left = null, right = null;
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
          for (const m of [].concat(o.material)) if (m.transparent) { m.transparent = false; m.alphaTest = 0.5; m.depthWrite = true; }
        }
        if (o.isBone && !left && LEFT_LEG.test(o.name)) left = o;
        if (o.isBone && !right && RIGHT_LEG.test(o.name)) right = o;
      });
      let facing = 0;  // yaw of the model's forward, 0 = +z
      if (left && right) {
        const f = left.getWorldPosition(new THREE.Vector3()).sub(right.getWorldPosition(new THREE.Vector3())).cross(new THREE.Vector3(0, 1, 0));
        if (f.lengthSq() > 1e-10) facing = Math.atan2(f.x, f.z);
      }
      const clip = (re) => g.animations.find((c) => re.test(c.name));
      const clips = {
        idle: clip(/idle/i), walk: clip(/walk/i), run: clip(/run/i) || clip(/walk/i),
      };
      for (const c of Object.values(clips)) if (c) c.tracks = c.tracks.filter((t) => !t.name.endsWith('.position') || /hips|pelvis|bip0?1$/i.test(t.name.split('.')[0]) === false);
      ok({ file, root, clips, height: box.max.y - box.min.y, minY: box.min.y, facing });
    }, undefined, fail)));
  }
  return cache.get(file);
}

// A posable body: the model scaled to BODY_H, standing on the group's origin and facing +z.
export function makeBody(asset) {
  const model = SkeletonUtils.clone(asset.root);
  const k = BODY_H / asset.height;
  const inner = new THREE.Group();
  inner.add(model);
  model.scale.setScalar(k);
  model.position.y = -asset.minY * k;
  inner.rotation.y = -asset.facing;
  const group = new THREE.Group();
  group.add(inner);
  const bones = {};
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  return { group, model, bones, asset };
}

export function findBone(bones, test) {
  return Object.values(bones).find((b) => test(b.name));
}

// ---------------------------------------------------------------- arm IK

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();

// rotation of an object relative to the rig root
function rootQ(root, o, out) {
  root.getWorldQuaternion(_q2).invert();
  return o.getWorldQuaternion(out).premultiply(_q2);
}
function setRootQ(root, o, q) {
  const parentW = o.parent.getWorldQuaternion(new THREE.Quaternion());
  const rootW = root.getWorldQuaternion(new THREE.Quaternion());
  o.quaternion.copy(parentW.invert().multiply(rootW).multiply(q));
  o.updateMatrixWorld(true);
}
function rootPos(root, o, out) {
  return root.worldToLocal(o.getWorldPosition(out));
}

export class ArmRig {
  // root: the object whose local space targets are given in. Must be posed at rest when constructed.
  constructor(root, bones, side) {
    this.root = root; this.side = side;
    const of = (re) => Object.values(bones).find((b) => re.test(b.name) && sideOf(b.name) === side && !/twist|nub|end$/i.test(b.name));
    this.upper = of(/upper.?arm|arm$/i);
    if (this.upper && /fore/i.test(this.upper.name)) this.upper = null;
    this.fore = of(/fore.?arm/i);
    this.hand = of(/hand$/i);
    this.ok = !!(this.upper && this.fore && this.hand);
    if (!this.ok) return;
    // keep only the real chain: forearm must descend from the upper arm, hand from the forearm
    root.updateMatrixWorld(true);
    const A = rootPos(root, this.upper, new THREE.Vector3()), B = rootPos(root, this.fore, new THREE.Vector3()), C = rootPos(root, this.hand, new THREE.Vector3());
    this.la = A.distanceTo(B); this.lb = B.distanceTo(C);
    this.rest = [this.upper, this.fore, this.hand].map((b) => b.quaternion.clone());
    this.restPos = this.upper.position.clone();
    // fingers: chains below the hand
    const chain = (b) => { const out = []; let c = b; while (c && c.isBone) { out.push(c); c = c.children.find((x) => x.isBone); } return out; };
    this.fingers = this.hand.children.filter((b) => b.isBone).map(chain).filter((c) => c.length);
    const bases = this.fingers.map((c) => rootPos(root, c[0], new THREE.Vector3()).sub(C));
    if (bases.length >= 2) {
      const mean = bases.reduce((s, v) => s.add(v.clone().normalize()), new THREE.Vector3()).normalize();
      let ti = 0, worst = 2;
      bases.forEach((v, i) => { const d = v.clone().normalize().dot(mean); if (d < worst) { worst = d; ti = i; } });
      this.thumb = this.fingers[ti];
      this.fingers = this.fingers.filter((_, i) => i !== ti);
      const F = this.fingers.map((c) => rootPos(root, c[0], new THREE.Vector3()).sub(C)).reduce((s, v) => s.add(v), new THREE.Vector3()).normalize();
      const T = bases[ti].clone().sub(F.clone().multiplyScalar(bases[ti].dot(F))).normalize();
      this.restBasis = this.basis(F, T);
    } else {
      // no finger bones: take the hand bone's direction from the forearm, thumb forward
      const F = C.clone().sub(B).normalize();
      const T = new THREE.Vector3(0, 1, 0).sub(F.clone().multiplyScalar(F.y)).normalize();
      this.restBasis = this.basis(F, T);
    }
    this.restHandQ = rootQ(root, this.hand, new THREE.Quaternion());
    this.fingerRest = this.fingers.concat(this.thumb ? [this.thumb] : []).flat().map((b) => b.quaternion.clone());
  }

  // orthonormal frame of a hand: finger direction, thumb direction, palm normal
  basis(F, T) {
    const P = this.side === 'R' ? new THREE.Vector3().crossVectors(T, F) : new THREE.Vector3().crossVectors(F, T);
    return new THREE.Matrix4().makeBasis(F, T, P.normalize());
  }

  reset() {
    if (!this.ok) return;
    [this.upper, this.fore, this.hand].forEach((b, i) => b.quaternion.copy(this.rest[i]));
    this.upper.position.copy(this.restPos);
    this.fingers.concat(this.thumb ? [this.thumb] : []).flat().forEach((b, i) => b.quaternion.copy(this.fingerRest[i]));
  }

  // Put the wrist at `wrist` with the hand's fingers along F and palm facing P
  // (all in root space), the elbow bent toward `pole`. `shoulder`, when given,
  // moves the shoulder joint there first (first-person arms reach further that way).
  solve(wrist, F, P, pole, curl = 0, shoulder = null, thumbCurl = curl * 0.6) {
    if (!this.ok) return;
    const root = this.root;
    root.updateMatrixWorld(true);
    if (shoulder) {
      const w = root.localToWorld(shoulder.clone());
      this.upper.position.copy(this.upper.parent.worldToLocal(w));
      this.upper.updateMatrixWorld(true);
    }
    const A = rootPos(root, this.upper, new THREE.Vector3());
    let B = rootPos(root, this.fore, new THREE.Vector3());
    const toT = wrist.clone().sub(A);
    const d = Math.min(Math.max(toT.length(), 0.01), (this.la + this.lb) * 0.999);
    const dir = toT.normalize();
    const a = (this.la * this.la - this.lb * this.lb + d * d) / (2 * d), h = Math.sqrt(Math.max(0, this.la * this.la - a * a));
    const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const E = A.clone().addScaledVector(dir, a).addScaledVector(perp, h);
    const T = A.clone().addScaledVector(dir, d);
    // upper arm: aim at the elbow
    _q.setFromUnitVectors(B.clone().sub(A).normalize(), E.clone().sub(A).normalize());
    setRootQ(root, this.upper, _q.clone().multiply(rootQ(root, this.upper, new THREE.Quaternion())));
    // forearm: aim at the wrist
    B = rootPos(root, this.fore, new THREE.Vector3());
    const C = rootPos(root, this.hand, new THREE.Vector3());
    _q.setFromUnitVectors(C.clone().sub(B).normalize(), T.clone().sub(B).normalize());
    setRootQ(root, this.fore, _q.clone().multiply(rootQ(root, this.fore, new THREE.Quaternion())));
    // hand: rotate the measured rest frame onto the wanted one
    const Fn = F.clone().normalize(), Pn = P.clone().sub(Fn.clone().multiplyScalar(P.dot(Fn))).normalize();
    const Tn = this.side === 'R' ? new THREE.Vector3().crossVectors(Fn, Pn) : new THREE.Vector3().crossVectors(Pn, Fn);
    const want = new THREE.Matrix4().makeBasis(Fn, Tn, Pn);
    const delta = new THREE.Quaternion().setFromRotationMatrix(want.multiply(_m.copy(this.restBasis).transpose()));
    setRootQ(root, this.hand, delta.multiply(this.restHandQ));
    // fingers curl toward the palm, joint by joint
    if (curl > 0) {
      const axis = new THREE.Vector3().crossVectors(Fn, Pn).normalize();
      const k = [0.85, 1.15, 0.8];
      for (const c of this.fingers) c.slice(0, 3).forEach((b, i) => {
        const r = new THREE.Quaternion().setFromAxisAngle(axis, curl * k[i]);
        setRootQ(root, b, r.multiply(rootQ(root, b, new THREE.Quaternion())));
      });
      if (this.thumb) {
        const ax2 = new THREE.Vector3().crossVectors(Tn, Pn).normalize();
        this.thumb.slice(0, 3).forEach((b, i) => {
          const r = new THREE.Quaternion().setFromAxisAngle(ax2, thumbCurl * (i ? 0.7 : 0.35));
          setRootQ(root, b, r.multiply(rootQ(root, b, new THREE.Quaternion())));
        });
      }
    }
  }
}
