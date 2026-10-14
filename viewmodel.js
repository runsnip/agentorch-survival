// First-person view: only the two arms and the weapon.
//
// The arms are the chosen character's own model, drawn in a separate small
// scene over the world (so they never clip into walls). Its head and legs are
// collapsed, the camera sits where the eyes were, and both arms are posed every
// frame by IK onto the weapon's grip and support points.

import { dress } from './accessories.js';
import * as THREE from 'three';
import { makeBody, ArmRig, findBone } from './actors.js';
import { applyFinish, buildGun, muzzleFlash } from './weapons.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
// where each kind of weapon sits from the hip, in camera space (metres)
const HIP = {
  pistol: V(0.07, -0.115, -0.56), smg: V(0.13, -0.14, -0.42), ar: V(0.14, -0.145, -0.4),
  dmr: V(0.14, -0.145, -0.39), sr: V(0.14, -0.15, -0.38), sg: V(0.14, -0.145, -0.4),
};
const ADS_Z = { pistol: -0.48, smg: -0.3, ar: -0.28, dmr: -0.26, sr: -0.25, sg: -0.3 };

export class Viewmodel {
  constructor(env) {
    this.scene = new THREE.Scene();
    this.scene.environment = env;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 6);
    this.hemi = new THREE.HemisphereLight(0xdfe9f2, 0x4a4535, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 1.5);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.flashLight);
    this.rig = new THREE.Group();          // camera space
    this.scene.add(this.rig);
    this.gunHolder = new THREE.Group();
    this.rig.add(this.gunHolder);
    this.guns = new Map();
    this.flash = muzzleFlash();
    this.flash.scale.setScalar(0.16);
    this.t = 0; this.ads = 0; this.sprint = 0; this.kick = 0; this.kickRot = 0;
    this.sway = new THREE.Vector2(); this.bob = 0; this.lastShot = -1;
    this.current = null; this.wanted = undefined; this.phase = null; this.phaseT = 0; this.rack = false;
    this.seen = new Set();
    this.handMag = new THREE.Mesh();
    this.handMag.visible = false;
    this.rig.add(this.handMag);
  }

  setBody(asset, gear = {}) {
    if (this.body) this.rig.remove(this.body.group);
    const body = dress(makeBody(asset), gear);   // gloves show on the hands
    this.body = body;
    // the camera sits at the eyes: find the head, then face the body along −z
    body.group.rotation.y = Math.PI;
    this.rig.add(body.group);
    body.group.updateMatrixWorld(true);
    const head = findBone(body.bones, (n) => /head$/i.test(n) && !/top|end|nub/i.test(n));
    const eye = head ? this.rig.worldToLocal(head.getWorldPosition(new THREE.Vector3())) : V(0, 1.62, 0);
    body.group.position.set(-eye.x, -eye.y - 0.1, -eye.z + 0.02);
    body.group.updateMatrixWorld(true);
    this.arms = { R: new ArmRig(this.rig, body.bones, 'R'), L: new ArmRig(this.rig, body.bones, 'L') };
    // hide what a player never sees of themselves
    for (const b of Object.values(body.bones)) {
      if ((/head$/i.test(b.name) && !/top|end/i.test(b.name)) || /up.?leg|thigh/i.test(b.name)) b.scale.setScalar(1e-4);
    }
  }

  // the player's equipped finish (inventory): every gun in hand wears it
  setFinish(finish) {
    if ((finish?.id || '') === (this.finish?.id || '')) return;
    this.finish = finish;
    const held = this.current ? [...this.guns].find(([, g]) => g === this.current)?.[0] : null;
    for (const g of this.guns.values()) g.group.removeFromParent();
    this.guns.clear();
    if (held) this.mount(held);   // the gun in hand, repainted
  }

  gun(id) {
    if (!this.guns.has(id)) {
      const g = applyFinish(buildGun(id), this.finish);
      g.group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      this.guns.set(id, g);
    }
    return this.guns.get(id);
  }

  // s: { weapon: id | null, ads, sprint, moving (0..1), reload (0..1, -1 when not), reloadEmpty,
  //      shotAt, lookDX, lookDY, busy, sunView }
  update(dt, s) {
    this.t += dt;
    if (!this.body) return;
    const ease = (a, b, k) => a + (b - a) * Math.min(1, dt * k);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const win = (x, a, b) => smooth((x - a) / (b - a));      // 0 → 1 over [a, b]

    // ---- weapon change: the old one is lowered out of frame, then the new one is drawn
    if (s.weapon !== this.wanted) {
      this.wanted = s.weapon;
      this.phase = this.current ? 'holster' : 'draw';
      this.phaseT = 0;
      if (!this.current) this.mount(s.weapon);
    }
    this.phaseT += dt;
    if (this.phase === 'holster' && this.phaseT > 0.22) { this.mount(this.wanted); this.phase = 'draw'; this.phaseT = 0; }
    const DRAW = this.rack ? 0.85 : 0.45;
    if (this.phase === 'draw' && this.phaseT > DRAW) { this.phase = null; this.rack = false; }

    this.ads = ease(this.ads, s.ads && !s.sprint && s.reload < 0 && !this.phase ? 1 : 0, 12);
    this.sprint = ease(this.sprint, s.sprint && s.reload < 0 ? 1 : 0, 8);
    if (s.shotAt !== this.lastShot && !this.current) {   // empty hands: a jab, left and right in turn
      this.lastShot = s.shotAt;
      this.jab = { side: this.jab?.side === 'R' ? 'L' : 'R', t: 0 };
    }
    if (this.jab) { this.jab.t += dt; if (this.jab.t > 0.35) this.jab = null; }
    if (s.shotAt !== this.lastShot) {
      this.lastShot = s.shotAt;
      const heavy = this.current?.def.cat === 'sr' || this.current?.def.cat === 'sg';
      this.kick = Math.min(this.kick + (heavy ? 0.07 : 0.025), 0.09);
      this.kickRot = Math.min(this.kickRot + (heavy ? 0.18 : 0.05), 0.32);
      this.flash.visible = true; this.flash.rotation.z = Math.random() * 6.28; this.flashT = 0.05;
    }
    this.kick = ease(this.kick, 0, 14); this.kickRot = ease(this.kickRot, 0, 10);
    this.flashT = (this.flashT || 0) - dt;
    if (this.flashT <= 0) this.flash.visible = false;
    this.flashLight.intensity = this.flash.visible ? 3 : 0;
    this.sway.x = ease(this.sway.x, -s.lookDX * 0.0009, 10); this.sway.y = ease(this.sway.y, s.lookDY * 0.0009, 10);
    this.bob += dt * (s.sprint ? 13 : 9) * s.moving;

    // ---- where the weapon is this frame (camera space)
    const g = this.current, cat = g?.def.cat || 'none';
    const pos = new THREE.Vector3(), rot = new THREE.Euler();
    let rackK = 0;          // 0..1: support hand pulling the charging handle / slide
    let magOut = 0;         // 0..1: the support hand carries the magazine away
    if (g) {
      pos.lerpVectors(HIP[cat], V(0, -g.sightY, ADS_Z[cat]), this.ads);
      const bobK = (1 - this.ads * 0.85) * s.moving;
      pos.x += Math.cos(this.bob) * 0.008 * bobK + this.sway.x;
      pos.y += -Math.abs(Math.sin(this.bob)) * 0.012 * bobK + this.sway.y + Math.sin(this.t * 1.6) * 0.0015 * (1 - this.ads);
      pos.z += this.kick;
      rot.set(this.kickRot * (1 - this.ads * 0.5) + this.sway.y * 3, 0.03 * (1 - this.ads) + this.sway.x * 4, -0.04 * (1 - this.ads));
      // sprinting: the gun swings down and across the chest
      pos.add(V(-0.07, -0.07, 0.05).multiplyScalar(this.sprint));
      rot.x -= 0.5 * this.sprint; rot.y += 0.8 * this.sprint; rot.z += 0.35 * this.sprint;
      // holster / draw: rolled down and out of frame, then up with a little overshoot
      if (this.phase === 'holster') {
        const k = win(this.phaseT, 0, 0.22);
        pos.y -= 0.32 * k; pos.x += 0.04 * k; rot.x -= 0.9 * k; rot.z += 0.5 * k;
      } else if (this.phase === 'draw') {
        const up = win(this.phaseT, 0, 0.4), over = Math.sin(Math.min(1, this.phaseT / 0.4) * Math.PI) * 0.06;
        pos.y -= 0.32 * (1 - up); pos.x += 0.04 * (1 - up); rot.x -= 0.9 * (1 - up) - over; rot.z += 0.5 * (1 - up);
        if (this.rack) {   // a fresh weapon gets its action worked once
          const t = this.phaseT - 0.4;
          rackK = win(t, 0.05, 0.2) * (1 - win(t, 0.25, 0.4));
          rot.z += 0.35 * win(t, 0, 0.1) * (1 - win(t, 0.35, 0.45)); rot.y -= 0.2 * win(t, 0, 0.1) * (1 - win(t, 0.35, 0.45));
          pos.z += 0.012 * rackK;
        }
      }
      // reload: tilt, mag out and away, fresh mag in with a push, work the action if it ran dry
      if (s.reload >= 0) {
        const p = s.reload, tilt = win(p, 0, 0.12) * (1 - win(p, 0.88, 1));
        rot.z += 0.6 * tilt; rot.x += 0.15 * tilt; pos.x -= 0.03 * tilt; pos.y += 0.02 * tilt;
        magOut = win(p, 0.15, 0.3) * (1 - win(p, 0.5, 0.65));
        const seat = Math.max(0, 1 - Math.abs(p - 0.68) / 0.04);   // the push that seats the mag
        pos.y += 0.012 * seat;
        if (s.reloadEmpty) rackK = Math.max(rackK, win(p, 0.74, 0.8) * (1 - win(p, 0.84, 0.9)));
      }
      if (s.busy) { pos.y -= 0.3; rot.x -= 0.6; }
    }
    this.gunHolder.position.copy(pos);
    this.gunHolder.rotation.copy(rot);
    this.gunHolder.updateMatrixWorld(true);

    // ---- arms onto the weapon
    const R = this.arms.R, L = this.arms.L;
    R.reset(); L.reset();
    const q = this.gunHolder.quaternion;
    const dir = (x, y, z) => V(x, y, z).normalize().applyQuaternion(q);
    const at = (p) => this.rig.worldToLocal(this.gunHolder.localToWorld(p.clone()));
    // shoulders sit a little forward of the real ones: the arms reach the gun without the chest showing
    const pistol = cat === 'pistol';
    const shoulderR = pistol ? V(0.16, -0.25, -0.24) : V(0.2, -0.26, -0.2), shoulderL = pistol ? V(-0.12, -0.25, -0.26) : V(-0.1, -0.26, -0.36);
    if (g) {
      // firing hand: palm against the right side of the grip, fingers round its front, thumb over the left
      const FR = dir(0, -0.3, -0.95), PR = dir(-1, 0, 0);
      const grip = at(V(0, -0.025, 0.02));
      R.solve(grip.addScaledVector(PR, -0.028).addScaledVector(FR, -0.08), FR, PR, V(1, -0.5, 0.3), 1.1, shoulderR, 0.8);

      // support hand: clamps the handguard from below-left, fingers over the right side;
      // on a pistol it wraps the firing hand
      let FL, PL, c;
      if (cat === 'pistol') { FL = dir(0.25, -0.45, -0.86); PL = dir(1, 0, 0.15); c = at(V(-0.012, -0.045, 0.0)); }
      else { FL = dir(0.5, -0.05, -0.86); PL = dir(0.05, 1, 0); c = at(g.support.clone().setY(g.support.y + 0.028)); }
      let wristL = c.clone().addScaledVector(PL, -0.028).addScaledVector(FL, -0.075), curlL = 1.15;
      if (magOut > 0 || (s.reload >= 0 && s.reload < 0.72)) {
        // to the magazine well, down and out of frame, then back with a fresh one
        const well = at(g.mag ? g.mag.position.clone().add(V(-0.03, -0.04, 0)) : V(0, -0.1, -0.08));
        const reach = win(s.reload, 0.05, 0.15) * (1 - win(s.reload, 0.68, 0.76));
        const away = V(-0.08, -0.42, -0.1);
        const target = well.clone().lerp(away, magOut);
        wristL = wristL.lerp(target, reach);
        FL = FL.clone().lerp(dir(0.1, 0.9, -0.3), reach).normalize();
        PL = PL.clone().lerp(dir(0.9, 0, 0.3), reach).normalize();
        curlL = 1.25 - 0.4 * reach;
      }
      if (rackK > 0) {   // charging handle on top of the receiver, or the pistol's slide
        const handle = at(cat === 'pistol' ? V(0, 0.065, -0.02 + 0.05 * rackK) : V(-0.03, 0.09, 0.02 + 0.07 * rackK));
        const FK = dir(0.6, -0.2, -0.75), PK = dir(0.3, -0.9, 0.2);
        const wk = handle.addScaledVector(PK, -0.04).addScaledVector(FK, -0.07);
        const k = Math.min(1, rackK * 3);
        wristL = wristL.lerp(wk, k); FL = FL.clone().lerp(FK, k).normalize(); PL = PL.clone().lerp(PK, k).normalize();
      }
      L.solve(wristL, FL, PL, V(-0.6, -1, 0.1), curlL, shoulderL, 0.8);
      if (g.mag) g.mag.visible = !(s.reload > 0.2 && s.reload < 0.66);
      this.handMag.visible = !!g.mag && s.reload > 0.2 && s.reload < 0.66;
      if (this.handMag.visible) {   // the magazine rides in the support hand
        if (this.handMag.userData.src !== g.mag) {
          this.handMag.geometry = g.mag.geometry; this.handMag.material = g.mag.material; this.handMag.userData.src = g.mag;
        }
        L.hand.updateWorldMatrix(true, false);
        this.handMag.position.copy(this.rig.worldToLocal(L.hand.getWorldPosition(new THREE.Vector3()))).addScaledVector(FL, 0.06).addScaledVector(PL, 0.04);
        this.handMag.quaternion.copy(q);
      }
    } else {
      // no weapon: both fists up, swaying with the step; a jab shoots one out to the centre and back
      const b = Math.sin(this.bob) * 0.015 * s.moving;
      const k = (side) => (this.jab?.side === side ? Math.sin(Math.min(1, this.jab.t / 0.35) * Math.PI) : 0);
      const kR = k('R'), kL = k('L');
      R.solve(V(0.2 - 0.14 * kR, -0.3 + b + 0.08 * kR, -0.4 - 0.22 * kR), V(-0.15 - 0.2 * kR, 0.25, -0.95), V(-0.95, 0, 0), V(1, -0.6, 0.3), 1.6, shoulderR, 1);
      L.solve(V(-0.2 + 0.14 * kL, -0.3 - b + 0.08 * kL, -0.42 - 0.22 * kL), V(0.15 + 0.2 * kL, 0.25, -0.95), V(0.95, 0, 0), V(-1, -0.6, 0.3), 1.6, shoulderL, 1);
      this.handMag.visible = false;
    }

    // the sun keeps its world direction as the view turns
    if (s.sunView) { this.sun.position.copy(s.sunView).multiplyScalar(5); this.sun.target.position.set(0, 0, 0); }
  }

  mount(id) {
    this.gunHolder.clear();
    this.current = id ? this.gun(id) : null;
    if (this.current) { this.gunHolder.add(this.current.group); this.current.group.add(this.flash); this.flash.position.copy(this.current.muzzle); }
    this.rack = !!id && !this.seen.has(id);
    if (id) this.seen.add(id);
  }

  render(renderer, aspect, hidden) {
    if (hidden || !this.body) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
