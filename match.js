// One match on the island: the player, bots (one of them may be steered by an
// AI agent), weapons, loot, death boxes and the shrinking safe zone.
//
// Shots are hitscan: a ray against bodies (head sphere + torso capsule) and
// the island's solids, nearest hit wins.

import * as THREE from 'three';
import { WEAPONS, AMMO, buildGun } from './weapons.js';
import { makeBody, ArmRig, BODY_H } from './actors.js';
import { t as tr } from '/i18n.js';

export const EYE = 1.62, EYE_CROUCH = 1.12, RADIUS = 0.35;
const GRAVITY = 15, JUMP = 4.8;
const SPEED = { walk: 4.6, sprint: 7.0, crouch: 2.3, ads: 2.6 };
const AMMO_PACK = { '9mm': 30, '556': 30, '762': 20, '12g': 12 };
const MEDS = { bandage: { name: tr('Băng gạc'), heal: 15, cap: 75, time: 3 }, medkit: { name: tr('Bộ cứu thương'), heal: 100, cap: 100, time: 6 } };
export const PHASES = [
  { wait: 70, shrink: 45, r: 175, dps: 1 },
  { wait: 50, shrink: 35, r: 105, dps: 2 },
  { wait: 40, shrink: 30, r: 60, dps: 4 },
  { wait: 35, shrink: 25, r: 30, dps: 7 },
  { wait: 25, shrink: 20, r: 10, dps: 10 },
  { wait: 20, shrink: 15, r: 0, dps: 15 },
];
// Callsigns are made up for this game.
const PLAYER_NAMES = ['Kestan', 'Morvi', 'Tarel', 'Ondra', 'Velis', 'Saru'];
const BOT_NAMES = ['Arvik', 'Belka', 'Corin', 'Davro', 'Elsin', 'Fenro', 'Harun', 'Iska', 'Jorvi', 'Kelmo', 'Lirra', 'Marek', 'Nessa', 'Orlo',
  'Pavka', 'Quinto', 'Rusan', 'Selka', 'Tavon', 'Ulrik', 'Vesna', 'Wendo', 'Xilo', 'Yarra', 'Zoran', 'Ambry', 'Brenn', 'Calvo', 'Dessa',
  'Emrik', 'Falka', 'Gorin', 'Halsa', 'Ivor', 'Jensa', 'Kovar', 'Lenka', 'Mirko', 'Nerin', 'Osko', 'Pella', 'Ravik', 'Sorin', 'Talia',
  'Uvan', 'Velko', 'Wrenna', 'Yuri', 'Zeno'];

// How well the agent's bot plays, picked in the lobby. Other bots sit between Newbie and Talent.
export const AGENT_LEVELS = {
  newbie: { name: 'Newbie', skill: 0.15, sight: 70, reaction: 1.1, turn: 0.6 },
  talent: { name: 'Talent', skill: 0.5, sight: 100, reaction: 0.7, turn: 1 },
  pro: { name: 'Professional', skill: 0.85, sight: 130, reaction: 0.4, turn: 1.4 },
};
const FOV_COS = 0.5;      // a 120° field of view
const AWARE = 15;         // closer than this, someone is noticed even behind you

const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
export const forward = (yaw, pitch = 0) => new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

// closest approach of a ray (o, unit d) to a segment a-b; returns {t, dist}
function raySegment(o, d, a, b) {
  const u = b.clone().sub(a), w = o.clone().sub(a);
  const A = 1, B = d.dot(u), C = u.dot(u), D = d.dot(w), E = u.dot(w);
  const den = A * C - B * B;
  let t = den > 1e-9 ? (B * E - C * D) / den : 0, s = den > 1e-9 ? (A * E - B * D) / den : 0;
  s = Math.max(0, Math.min(1, s));
  t = Math.max(0, d.dot(a.clone().addScaledVector(u, s).sub(o)));
  const p = o.clone().addScaledVector(d, t), q = a.clone().addScaledVector(u, s);
  return { t, dist: p.distanceTo(q) };
}

// ---------------------------------------------------------------- units

export class Unit {
  constructor(match, { id, name, isPlayer = false, asset = null, agent = null }) {
    Object.assign(this, { match, id, name, isPlayer, asset, agent });
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.onGround = true;
    this.hp = 100; this.armor = 0; this.alive = true; this.kills = 0;
    this.slots = [null, null, null]; this.cur = -1;
    this.ammo = { '9mm': 0, '556': 0, '762': 0, '12g': 0 };
    this.meds = { bandage: 0, medkit: 0 };
    this.reloadT = 0; this.reloadTotal = 0; this.reloadEmpty = false; this.fireCd = 0; this.action = null;
    this.crouch = false; this.sprint = false; this.ads = false; this.shotAt = -1;
    this.moveSpeed = 0;
  }
  get weapon() { return this.cur >= 0 ? this.slots[this.cur] : null; }
  get def() { return this.weapon ? WEAPONS[this.weapon.id] : null; }
  eye() { return this.pos.clone().setY(this.pos.y + (this.crouch ? EYE_CROUCH : EYE)); }
  chest() { return this.pos.clone().setY(this.pos.y + (this.crouch ? 0.85 : 1.25)); }

  give(id, extraMags = 1) {
    const d = WEAPONS[id];
    const slot = d.cat === 'pistol' ? 2 : !this.slots[0] ? 0 : !this.slots[1] ? 1 : (this.cur === 1 ? 1 : 0);
    const old = this.slots[slot];
    this.slots[slot] = { id, mag: d.mag };
    this.ammo[d.ammo] += AMMO_PACK[d.ammo] * extraMags;
    this.switchTo(slot);
    return old;
  }
  switchTo(slot) {
    if (!this.slots[slot] || slot === this.cur) return;
    this.cur = slot; this.reloadT = 0; this.action = null;
    this.fireCd = Math.max(this.fireCd, 0.65);    // holster + draw
  }
  startReload() {
    const w = this.weapon, d = this.def;
    if (!w || this.reloadT > 0 || w.mag >= d.mag || this.ammo[d.ammo] <= 0) return;
    this.reloadEmpty = w.mag === 0;
    this.reloadTotal = this.reloadT = d.reload * (this.reloadEmpty ? 1.15 : 1);
    this.action = null;
  }
  useMed(kind) {
    const m = MEDS[kind];
    if (!this.meds[kind] || this.hp >= m.cap || this.action) return false;
    this.action = { kind, t: m.time, total: m.time };
    this.reloadT = 0;
    return true;
  }
  tick(dt) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.bloom = Math.max(0, (this.bloom || 0) - dt * 0.03);
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const w = this.weapon, d = this.def;
        if (w) { const n = Math.min(d.mag - w.mag, this.ammo[d.ammo]); w.mag += n; this.ammo[d.ammo] -= n; }
        this.reloadT = 0;
      }
    }
    if (this.action) {
      if (this.moveSpeed > SPEED.crouch + 0.5) { this.action = null; return; }  // running cancels healing
      this.action.t -= dt;
      if (this.action.t <= 0) {
        const m = MEDS[this.action.kind];
        this.meds[this.action.kind]--;
        this.hp = Math.max(this.hp, Math.min(m.cap, this.hp + m.heal));
        this.action = null;
      }
    }
  }
}

// ---------------------------------------------------------------- match

export class Match {
  // opts: { island, scene, playerName, playerAsset, botAssets[], bots, agent: {name, slug, asset} | null, events }
  constructor(opts) {
    this.island = opts.island; this.scene = opts.scene; this.events = opts.events || {};
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.units = []; this.items = []; this.noises = []; this.time = 0; this.over = false;
    this.tracers = new Tracers(this.group);
    this.puffs = new Puffs(this.group);
    const I = this.island;

    // spawn points: on land, clear of trunks and houses, spread out
    const spots = [];
    const spot = (minGap) => {
      for (let t = 0; t < 400; t++) {
        const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * I.radius * 0.9;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (I.heightAt(x, z) < 1.6 || I.blockedBy(x, z, 1)) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < minGap) && t < 300) continue;
        const p = new THREE.Vector3(x, I.heightAt(x, z), z);
        spots.push(p);
        return p;
      }
      return new THREE.Vector3(0, I.heightAt(0, 0), 0);
    };
    const player = this.player = new Unit(this, { id: 0, name: opts.playerName || PLAYER_NAMES[Math.floor(Math.random() * PLAYER_NAMES.length)], isPlayer: true, asset: opts.playerAsset });
    player.pos.copy(spot(60)); player.yaw = Math.atan2(player.pos.x, player.pos.z);   // facing the island's centre
    this.units.push(player);
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < opts.bots; i++) {
      const isAgent = i === 0 && opts.agent;
      const u = new Unit(this, {
        id: i + 1, name: isAgent ? opts.agent.name : names[i % names.length] + (i >= names.length ? i : ''),
        asset: isAgent && opts.agent.asset ? opts.agent.asset : opts.botAssets[i % opts.botAssets.length], agent: isAgent ? opts.agent : null,
      });
      do u.pos.copy(spot(45)); while (u.pos.distanceTo(player.pos) < 90 && spots.length < 400);
      u.yaw = Math.random() * 6.283;
      u.ai = new BotBrain(u);
      this.units.push(u);
    }
    // everyone lands empty-handed: weapons are found on the island

    // loot
    for (const s of I.lootSpots) if (Math.random() < 0.8) this.spawnLoot(s);

    // safe zone
    const c = (() => { for (let t = 0; t < 200; t++) { const a = Math.random() * 6.283, r = Math.random() * 110; const x = Math.cos(a) * r, z = Math.sin(a) * r; if (I.heightAt(x, z) > 1.5) return [x, z]; } return [0, 0]; })();
    this.zone = { phase: -1, state: 'wait', t: 40, cx: 0, cz: 0, r: 330, from: null, next: { cx: c[0], cz: c[1], r: PHASES[0].r }, dps: 0.5 };
    this.zoneMesh = makeZoneWall();
    this.group.add(this.zoneMesh);
    this.alive = this.units.length;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const u of this.units) if (u.body) this.scene.remove(u.body.group);
  }

  // ---- loot
  spawnLoot(s) {
    const r = Math.random();
    let item;
    if (r < 0.5) {
      const pool = ['kestrix', 'kestrix', 'vantor', 'vantor', 'draxis', 'bruhn', 'bruhn', 'selvar', 'tharn', 'orvel', 'orvel', 'orvel'];
      item = { kind: 'weapon', id: pool[Math.floor(Math.random() * pool.length)] };
    } else if (r < 0.72) item = { kind: 'ammo', ammo: ['9mm', '556', '762', '12g'][Math.floor(Math.random() * 4)] };
    else if (r < 0.9) item = { kind: 'med', med: Math.random() < 0.7 ? 'bandage' : 'medkit', n: 1 };
    else item = { kind: 'armor', value: Math.random() < 0.6 ? 50 : 75 };
    if (item.kind === 'med' && item.med === 'bandage') item.n = 3;
    this.addItem(item, new THREE.Vector3(s.x, s.y, s.z));
  }
  addItem(item, pos) {
    item.pos = pos.clone();
    item.mesh = lootMesh(item);
    item.mesh.position.copy(pos).add(new THREE.Vector3(0, 0.03, 0));
    item.mesh.rotation.y = Math.random() * 6.283;
    this.group.add(item.mesh);
    this.items.push(item);
    return item;
  }
  removeItem(item) {
    this.group.remove(item.mesh);
    this.items.splice(this.items.indexOf(item), 1);
  }
  itemLabel(it) {
    if (it.kind === 'weapon') return `${WEAPONS[it.id].name}`;
    if (it.kind === 'ammo') return tr('Đạn {ammo} ×{n}', { ammo: AMMO[it.ammo], n: it.n || AMMO_PACK[it.ammo] });
    if (it.kind === 'med') return `${MEDS[it.med].name}${it.n > 1 ? ` ×${it.n}` : ''}`;
    if (it.kind === 'armor') return tr('Áo giáp ({value})', { value: it.value });
    return tr('Hòm đồ của {owner}', { owner: it.owner });
  }
  // within a hand's reach: the same side of the walls, nothing solid (wall, glass) in between
  canReach(u, it, reach = 2.8) {
    return it.pos.distanceTo(u.pos) < reach && this.island.canReach(u.chest(), it.pos.clone().setY(it.pos.y + 0.25));
  }
  // what a unit can pick up within reach (the player: the one under the crosshair if any)
  nearestItem(u, reach = 2.2, dir = null) {
    let best = null, bestScore = Infinity;
    for (const it of this.items) {
      const d = it.pos.distanceTo(u.pos);
      if (d > reach || !this.canReach(u, it)) continue;
      let score = d;
      if (dir) { const to = it.pos.clone().sub(u.eye()).normalize(); score -= to.dot(dir) * 2; }
      if (score < bestScore) { bestScore = score; best = it; }
    }
    return best;
  }
  // entries of a death box, one row each in the loot panel
  boxEntries(box) {
    return [
      ...box.weapons.map((w, i) => ({ kind: 'weapon', id: w.id, i, label: WEAPONS[w.id].name })),
      ...Object.entries(box.ammo).filter(([, n]) => n > 0).map(([k, n]) => ({ kind: 'ammo', ammo: k, n, label: tr('Đạn {ammo} ×{n}', { ammo: AMMO[k], n }) })),
      ...Object.entries(box.meds).filter(([, n]) => n > 0).map(([k, n]) => ({ kind: 'med', med: k, n, label: `${MEDS[k].name} ×${n}` })),
      ...(box.armor > 0 ? [{ kind: 'armor', value: Math.round(box.armor), label: tr('Áo giáp ({value})', { value: Math.round(box.armor) }) }] : []),
    ];
  }
  takeFromBox(u, box, e) {
    if (!this.items.includes(box) || !this.canReach(u, box)) return;
    if (e.kind === 'weapon') {
      const w = box.weapons.splice(e.i, 1)[0];
      if (!w) return;
      const old = u.give(w.id, 0);
      u.slots[u.cur].mag = w.mag;
      if (old) box.weapons.push(old);
    } else if (e.kind === 'ammo') { u.ammo[e.ammo] += box.ammo[e.ammo]; box.ammo[e.ammo] = 0; }
    else if (e.kind === 'med') { u.meds[e.med] += box.meds[e.med]; box.meds[e.med] = 0; }
    else if (e.kind === 'armor') { if (e.value > u.armor) { const was = u.armor; u.armor = e.value; box.armor = was; } }
    if (!this.boxEntries(box).length) this.removeItem(box);
    if (u.isPlayer) this.events.sound?.('pickup');
  }
  // drop something carried onto the ground in front
  drop(u, what) {
    const at = u.pos.clone().add(forward(u.yaw).setY(0).normalize().multiplyScalar(0.8)).add(new THREE.Vector3(rand(-0.3, 0.3), 0.02, rand(-0.3, 0.3)));
    at.y = this.island.floorAt(at.x, u.pos.y + 0.5, at.z);
    if (what.slot != null) {
      const w = u.slots[what.slot];
      if (!w) return;
      u.slots[what.slot] = null;
      if (u.cur === what.slot) { u.cur = -1; u.reloadT = 0; const next = [0, 1, 2].find((i) => u.slots[i]); if (next != null) u.switchTo(next); }
      const it = this.addItem({ kind: 'weapon', id: w.id }, at);
      it.mag = w.mag;
    } else if (what.ammo && u.ammo[what.ammo] > 0) {
      const n = Math.min(u.ammo[what.ammo], AMMO_PACK[what.ammo]);
      u.ammo[what.ammo] -= n;
      this.addItem({ kind: 'ammo', ammo: what.ammo, n }, at);
    } else if (what.med && u.meds[what.med] > 0) {
      u.meds[what.med]--;
      this.addItem({ kind: 'med', med: what.med, n: 1 }, at);
    }
  }
  pickup(u, it) {
    if (!it || !this.items.includes(it) || !this.canReach(u, it)) return false;
    if (it.kind === 'weapon') {
      const old = u.give(it.id, it.mag != null ? 0 : 1);
      if (it.mag != null) u.slots[u.cur].mag = it.mag;
      if (old) this.addItem({ kind: 'weapon', id: old.id }, u.pos.clone().add(new THREE.Vector3(rand(-0.5, 0.5), 0.02, rand(-0.5, 0.5))));
    } else if (it.kind === 'ammo') u.ammo[it.ammo] += it.n || AMMO_PACK[it.ammo];
    else if (it.kind === 'med') u.meds[it.med] += it.n;
    else if (it.kind === 'armor') { if (it.value <= u.armor) return false; u.armor = it.value; }
    else if (it.kind === 'box') {
      for (const w of it.weapons) if (!u.slots.some((s) => s?.id === w.id)) { const d = WEAPONS[w.id]; if (d.cat === 'pistol' ? !u.slots[2] : (!u.slots[0] || !u.slots[1] || d.tier > Math.min(...[0, 1].map((i) => (u.slots[i] ? WEAPONS[u.slots[i].id].tier : 0))))) u.give(w.id, 0); }
      for (const k in it.ammo) u.ammo[k] += it.ammo[k];
      for (const k in it.meds) u.meds[k] += it.meds[k];
      u.armor = Math.max(u.armor, it.armor || 0);
    }
    this.removeItem(it);
    if (u.isPlayer) this.events.sound?.('pickup');
    return true;
  }

  // ---- combat
  fire(u) {
    const w = u.weapon, d = u.def;
    if (!w) return this.punch(u);
    if (u.fireCd > 0 || u.reloadT > 0 || u.action || !u.alive) return false;
    if (w.mag <= 0) { u.startReload(); return false; }
    w.mag--; u.fireCd = d.rate; u.shotAt = this.time; u.sprint = false;
    const eye = u.eye();
    // The shot leaves the eye along the view, so it lands under the crosshair; only the
    // weapon's own cone (see WEAPONS) and, for bots, their aim error move it off.
    let spread = this.spreadOf(u);
    u.bloom = Math.min((u.bloom || 0) + d.bloom, d.spread * 1.5);
    if (u.ai) spread += u.ai.aimError();
    for (let i = 0; i < (d.pellets || 1); i++) {
      const dir = forward(u.yaw + gauss() * spread, u.pitch + gauss() * spread);
      this.shoot(u, eye, dir, d);
    }
    this.events.shot?.(u, d);
    this.noises.push({ u, x: u.pos.x, z: u.pos.z, t: this.time });
    if (w.mag === 0 && u.ammo[d.ammo] > 0) u.startReload();
    return true;
  }
  // empty-handed: a jab at whoever is right in front
  punch(u) {
    if (u.fireCd > 0 || u.action || !u.alive) return false;
    u.fireCd = 0.45; u.shotAt = this.time;
    const f = forward(u.yaw).setY(0).normalize();
    for (const t of this.units) {
      if (t === u || !t.alive) continue;
      const to = t.pos.clone().sub(u.pos).setY(0), d = to.length();
      if (d < 1.9 && to.normalize().dot(f) > 0.6 && Math.abs(t.pos.y - u.pos.y) < 1) { this.damage(t, 18, u, false, 'fists'); break; }
    }
    this.events.punch?.(u);
    return true;
  }
  // current cone of fire, also drawn by the crosshair
  spreadOf(u) {
    const d = u.def;
    if (!d) return 0;
    return (d.spread * (u.ads ? d.ads : 1) + (u.bloom || 0)) * (u.moveSpeed > 1.5 ? 1.5 : 1) * (u.crouch ? 0.85 : 1) * (u.onGround ? 1 : 2.5);
  }
  shoot(u, o, dir, d) {
    let best = d.range, hit = null, head = false;
    const solid = this.island.raycast(o, dir, d.range);
    best = Math.min(best, solid);
    for (const t of this.units) {
      if (t === u || !t.alive) continue;
      if (t.pos.distanceTo(o) > best + 2) continue;
      const h = t.crouch ? 1.25 : BODY_H;
      const hc = t.pos.clone().setY(t.pos.y + h - 0.13);
      const rs = raySegment(o, dir, hc, hc);
      if (rs.dist < 0.14 && rs.t < best) { best = rs.t; hit = t; head = true; continue; }
      const rb = raySegment(o, dir, t.pos.clone().setY(t.pos.y + 0.15), t.pos.clone().setY(t.pos.y + h - 0.32));
      if (rb.dist < 0.3 && rb.t < best) { best = rb.t; hit = t; head = false; }
    }
    const end = o.clone().addScaledVector(dir, best);
    this.tracers.add(u.isPlayer ? o.clone().add(new THREE.Vector3(0, -0.12, 0)).addScaledVector(dir, 0.6) : o, end);
    if (hit) {
      const fall = Math.max(0.5, 1 - Math.max(0, best - d.range * 0.5) / d.range);
      this.damage(hit, d.dmg * (head ? (d.cat === 'sr' ? 2.5 : 1.8) : 1) * fall, u, head, d.name);
      this.puffs.add(end, 0x8a1010);
    } else if (best < d.range) this.puffs.add(end, 0x9a8a70);
  }
  damage(t, amount, by, head, how) {
    if (!t.alive) return;
    if (t.armor > 0 && !head) { const absorb = amount * 0.4; const used = Math.min(t.armor, absorb); t.armor -= used; amount -= used; }
    t.hp -= amount;
    t.lastHitBy = by; t.lastHitAt = this.time;
    if (by && by !== t) t.ai?.hurtBy(by);
    if (t.isPlayer) this.events.hurt?.(by ? Math.atan2(by.pos.x - t.pos.x, by.pos.z - t.pos.z) : null, amount);
    if (by?.isPlayer) this.events.hitmark?.(t.hp <= 0, head);
    if (t.hp <= 0) this.kill(t, by, head, how);
  }
  kill(t, by, head, how) {
    t.alive = false; t.hp = 0; t.diedAt = this.time;
    if (by && by !== t) by.kills++;
    this.alive = this.units.filter((u) => u.alive).length;
    this.events.feed?.(by && by !== t ? `${by.name} ${head ? '⌖' : '▸'} ${t.name}` : tr('{name} gục ngoài vùng an toàn', { name: t.name }), by, t);
    // what they carried drops as a box
    const box = { kind: 'box', owner: t.name, weapons: t.slots.filter(Boolean), ammo: { ...t.ammo }, meds: { ...t.meds }, armor: t.armor };
    this.addItem(box, t.pos.clone());
    if (t.isPlayer || this.alive <= 1) this.finish();
  }
  finish() {
    if (this.over) return;
    this.over = true;
    const p = this.player;
    const rank = p.alive ? 1 : this.units.filter((u) => u.alive || u.diedAt > p.diedAt).length + 1;
    this.events.end?.({ win: p.alive, rank, kills: p.kills, total: this.units.length, killer: p.alive ? null : p.lastHitBy?.name, time: this.time });
  }

  // ---- per frame
  update(dt) {
    if (this.over && !this.player.alive) { this.updateBodies(dt); this.tracers.update(dt); this.puffs.update(dt); return; }
    this.time += dt;
    this.noises = this.noises.filter((n) => this.time - n.t < 4);
    this.updateZone(dt);
    for (const u of this.units) {
      if (!u.alive) continue;
      u.tick(dt);
      if (u.ai) u.ai.update(dt);
      this.physics(u, dt);
      const z = this.zone;
      if (Math.hypot(u.pos.x - z.cx, u.pos.z - z.cz) > z.r) {
        u.zoneTick = (u.zoneTick || 0) + dt;
        if (u.zoneTick >= 1) { u.zoneTick -= 1; this.damage(u, z.dps, null, false, 'zone'); }
      }
    }
    this.updateBodies(dt);
    this.tracers.update(dt);
    this.puffs.update(dt);
  }

  // movement: u.wish (x, z unit-ish vector in world), u.jump
  physics(u, dt) {
    const I = this.island;
    const wish = u.wish || new THREE.Vector3();
    // climbing over a sill: up, across, down, along a fixed arc; nothing else moves the body meanwhile
    if (u.vault) {
      const v = u.vault;
      v.t = Math.min(1, v.t + dt / v.dur);
      const k = v.t, e = k * k * (3 - 2 * k);
      u.pos.x = v.from.x + (v.land.x - v.from.x) * e;
      u.pos.z = v.from.z + (v.land.z - v.from.z) * e;
      const lift = Math.sin(Math.min(1, k * 1.25) * Math.PI / 2);   // up early, then across and down
      u.pos.y = k < 0.7 ? v.from.y + (v.top + 0.05 - v.from.y) * lift : v.top + 0.05 + (v.land.y - v.top - 0.05) * ((k - 0.7) / 0.3) ** 2;
      u.vel.set(0, 0, 0);
      u.moveSpeed = 0;
      if (k >= 1) { u.vault = null; u.pos.copy(v.land); u.onGround = true; I.collide(u.pos, RADIUS, 1.75); }
      return;
    }
    // Space at a low sill climbs it (in the direction of travel, else where the unit faces);
    // a bot walking into one climbs it too
    const going = wish.lengthSq() > 0.04 ? wish.clone().setY(0).normalize() : forward(u.yaw).setY(0).normalize();
    if (u.onGround && !u.action && (u.jump || (!u.isPlayer && wish.lengthSq() > 0.25 && u.moveSpeed < 0.3))) {
      const v = I.vaultAt(u.pos, going);
      if (v) {
        u.vault = { t: 0, dur: 0.55 + (v.top - u.pos.y) * 0.2, from: u.pos.clone(), top: v.top, land: v.land };
        u.jump = false; u.crouch = false;
        if (u.isPlayer) this.events.sound?.('vault');
        return;
      }
    }
    const speed = u.crouch ? SPEED.crouch : u.ads ? SPEED.ads : u.sprint ? SPEED.sprint : SPEED.walk;
    const ground = I.floorAt(u.pos.x, u.pos.y + 0.5, u.pos.z);
    const wade = ground < 0 ? Math.max(0.45, 1 + ground * 0.4) : 1;
    const target = wish.clone().multiplyScalar(speed * wade * (u.action ? 0.4 : 1));
    const k = Math.min(1, dt * (u.onGround ? 12 : 2));
    u.vel.x += (target.x - u.vel.x) * k; u.vel.z += (target.z - u.vel.z) * k;
    if (u.jump && u.onGround && !u.crouch) { u.vel.y = JUMP; u.onGround = false; }
    u.jump = false;
    u.vel.y -= GRAVITY * dt;
    const prev = u.pos.clone();
    u.pos.x += u.vel.x * dt; u.pos.z += u.vel.z * dt; u.pos.y += u.vel.y * dt;
    I.collide(u.pos, RADIUS, u.crouch ? 1.3 : 1.75);
    // deep water and the map edge are walls
    if (I.heightAt(u.pos.x, u.pos.z) < -1.4 || Math.abs(u.pos.x) > 300 || Math.abs(u.pos.z) > 300) { u.pos.x = prev.x; u.pos.z = prev.z; }
    const floor = I.floorAt(u.pos.x, u.pos.y + 0.45, u.pos.z);
    const stand = Math.max(floor, -1.0);
    if (u.pos.y <= stand + 0.02 || (u.onGround && u.pos.y - stand < 0.45 && u.vel.y <= 0)) {
      u.pos.y = stand; u.vel.y = 0; u.onGround = true;
    } else u.onGround = false;
    u.moveSpeed = Math.hypot(u.pos.x - prev.x, u.pos.z - prev.z) / Math.max(dt, 1e-4);
  }

  updateZone(dt) {
    const z = this.zone;
    z.t -= dt;
    if (z.state === 'wait' && z.t <= 0) {
      z.state = 'shrink'; z.phase = Math.min(z.phase + 1, PHASES.length - 1);
      const ph = PHASES[z.phase];
      z.t = ph.shrink; z.from = { cx: z.cx, cz: z.cz, r: z.r }; z.dps = ph.dps;
      this.events.message?.(tr('Vùng an toàn đang thu hẹp!'));
    } else if (z.state === 'shrink') {
      const ph = PHASES[z.phase], k = 1 - Math.max(0, z.t) / ph.shrink;
      z.cx = z.from.cx + (z.next.cx - z.from.cx) * k; z.cz = z.from.cz + (z.next.cz - z.from.cz) * k; z.r = z.from.r + (z.next.r - z.from.r) * k;
      if (z.t <= 0) {
        z.state = 'wait';
        const np = PHASES[Math.min(z.phase + 1, PHASES.length - 1)];
        z.t = np.wait;
        for (let t = 0; t < 40; t++) {   // the next circle sits inside this one, on land if possible
          const a = Math.random() * 6.283, d = Math.random() * Math.max(0, z.r - np.r) * 0.85;
          const x = z.cx + Math.cos(a) * d, zz = z.cz + Math.sin(a) * d;
          z.next = { cx: x, cz: zz, r: np.r };
          if (this.island.heightAt(x, zz) > 1.5) break;
        }
      }
    }
    this.zoneMesh.position.set(z.cx, -20, z.cz);
    this.zoneMesh.scale.set(Math.max(0.01, z.r), 1, Math.max(0.01, z.r));
    this.zoneMesh.material.uniforms.uTime.value = this.time;
  }

  // ---- bodies of the other units: animated, holding their gun, only when near
  updateBodies(dt) {
    const p = this.player;
    for (const u of this.units) {
      if (u.isPlayer) continue;
      const near = u.pos.distanceTo(p.pos) < 170;
      if (!u.body && near && u.asset) this.makeBody(u);
      if (!u.body) continue;
      u.body.group.visible = near;
      if (!near) continue;
      const g = u.body.group;
      g.position.copy(u.pos);
      if (!u.alive) {   // falls and stays down, then fades with the box left behind
        const k = Math.min(1, (this.time - u.diedAt) / 0.6);
        g.rotation.set(-Math.PI / 2 * k * k, u.yaw + Math.PI, 0);
        g.position.y = u.pos.y + 0.15 * k;
        if (u.gun) u.gun.group.visible = false;
        if (this.time - u.diedAt > 12) { g.visible = false; }
        u.mixer.update(0);
        continue;
      }
      g.rotation.set(0, u.yaw + Math.PI, 0);
      const v = u.moveSpeed;
      const clip = u.crouch && v < 1 ? 'crouch' : v < 0.4 ? 'idle' : v > 5.5 ? 'run' : 'walk';
      u.play(clip);
      if (u.actions[clip]) u.actions[clip].timeScale = clip === 'run' ? v / 6 : clip === 'walk' ? Math.max(0.6, v / 2.4) : 1;
      u.mixer.update(dt);
      // the gun at the chest, arms on it (close bots only: it costs a little)
      const def = u.def;
      if (u.gunId !== u.weapon?.id) {
        u.gunId = u.weapon?.id;
        if (u.gun) g.remove(u.gun.group);
        u.gun = u.gunId ? buildGun(u.gunId) : null;
        if (u.gun) g.add(u.gun.group);
      }
      if (u.gun) {
        const crouchDrop = u.crouch ? 0.45 : 0;
        const sprint = u.sprint && v > 5;
        u.gun.group.position.set(def.cat === 'pistol' ? 0.12 : 0.16, 1.3 - crouchDrop - (sprint ? 0.15 : 0), def.cat === 'pistol' ? 0.38 : 0.28);
        u.gun.group.rotation.set(sprint ? -0.6 : -u.pitch, Math.PI + (sprint ? 0.7 : 0.04), 0);
        u.gun.group.updateMatrixWorld(true);
        if (u.pos.distanceTo(p.pos) < 45 && u.arms) {
          const q = u.gun.group.quaternion;
          const dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize().applyQuaternion(q);
          const at = (v3) => g.worldToLocal(u.gun.group.localToWorld(v3.clone()));
          u.arms.R.reset(); u.arms.L.reset();
          const FR = dir(0, -0.3, -0.95), PR = dir(-1, 0, 0);
          u.arms.R.solve(at(new THREE.Vector3(0, -0.025, 0.02)).addScaledVector(PR, -0.045).addScaledVector(FR, -0.075), FR, PR, new THREE.Vector3(-1, -0.6, -0.3), 1.3);
          const FL = dir(0.5, -0.05, -0.86), PL = dir(0.05, 1, 0);
          const sup = def.cat === 'pistol' ? new THREE.Vector3(-0.03, -0.035, 0) : u.gun.support.clone().setY(u.gun.support.y + 0.028);
          u.arms.L.solve(at(sup).addScaledVector(PL, -0.03).addScaledVector(FL, -0.07), FL, PL, new THREE.Vector3(1, -1, -0.2), 1.25);
        }
      }
    }
  }
  makeBody(u) {
    const body = makeBody(u.asset);
    u.body = body;
    body.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(body.group);
    u.mixer = new THREE.AnimationMixer(body.model);
    u.actions = {};
    for (const [k, c] of Object.entries(u.asset.clips)) if (c) u.actions[k] = u.mixer.clipAction(c);
    u.play = (name) => {
      const a = u.actions[name] || u.actions.idle;
      if (!a || u.playing === a) return;
      a.reset().play();
      if (u.playing) u.playing.crossFadeTo(a, 0.2, false);
      u.playing = a;
    };
    u.play('idle');
    u.arms = { R: new ArmRig(body.group, body.bones, 'R'), L: new ArmRig(body.group, body.bones, 'L') };
  }

  // ---- what the agent's bot sees and hears, as data: its "camera" (see agentorch/arena_agent.py).
  // Only what a player in its shoes could know: enemies and items in its field
  // of view with nothing in between, gunshots within earshot, cover close by.
  // Terse keys and whole metres: every byte is billed.
  agentView(u) {
    const r = Math.round, z = this.zone, ai = u.ai, eye = u.eye();
    const short = (it) => it.kind === 'weapon' ? WEAPONS[it.id].name : it.kind === 'ammo' ? `ammo${it.ammo}` : it.kind === 'med' ? it.med
      : it.kind === 'armor' ? `armor${it.value}` : 'box';
    const seesItem = (it) => {
      if (!ai.inView(it.pos, 4)) return false;
      const to = it.pos.clone().setY(it.pos.y + 0.3).sub(eye), d = to.length();
      return this.island.raycast(eye, to.normalize(), d) >= d - 0.3;
    };
    const heading = (THREE.MathUtils.radToDeg(Math.atan2(-Math.sin(u.yaw), Math.cos(u.yaw))) + 360) % 360;   // clockwise from north (−z)
    const cover = [];
    for (const c of this.island.circlesNear(u.pos.x, u.pos.z, 20)) {
      const d = Math.hypot(c.x - u.pos.x, c.z - u.pos.z);
      if (d < 20) cover.push([d, c.kind, r(c.x), r(c.z)]);
    }
    for (const h of this.island.houses || []) {
      const cx = (h.x0 + h.x1) / 2, cz = (h.z0 + h.z1) / 2, d = Math.hypot(cx - u.pos.x, cz - u.pos.z);
      if (d < 25) cover.push([d, 'house', r(cx), r(cz)]);
    }
    return {
      hp: r(u.hp), ar: r(u.armor), p: [r(u.pos.x), r(u.pos.z)], f: r(heading),
      w: u.slots.filter(Boolean).map((w) => `${WEAPONS[w.id].name} ${w.mag}/${u.ammo[WEAPONS[w.id].ammo]}`),
      m: [u.meds.bandage, u.meds.medkit],
      z: [r(z.cx), r(z.cz), r(z.r)], nz: [r(z.next.cx), r(z.next.cz), r(z.next.r)],
      t: z.state === 'wait' ? Math.ceil(z.t) : 0, in: Math.hypot(u.pos.x - z.cx, u.pos.z - z.cz) < z.r ? 1 : 0, a: this.alive,
      e: this.units.filter((t) => t !== u && t.alive && ai.perceives(t))
        .sort((p, q) => p.pos.distanceTo(u.pos) - q.pos.distanceTo(u.pos)).slice(0, 4).map((t) => [t.name, r(t.pos.x), r(t.pos.z), r(t.hp)]),
      i: this.items.filter((it) => it.pos.distanceTo(u.pos) < 50 && ai.wants(it) && seesItem(it))
        .sort((p, q) => p.pos.distanceTo(u.pos) - q.pos.distanceTo(u.pos)).slice(0, 5).map((it) => [short(it), r(it.pos.x), r(it.pos.z)]),
      s: this.noises.filter((n) => n.u !== u && Math.hypot(n.x - u.pos.x, n.z - u.pos.z) < 150)
        .slice(-3).map((n) => [r(n.x / 5) * 5, r(n.z / 5) * 5]),
      c: cover.sort((p, q) => p[0] - q[0]).slice(0, 3).map(([, k, x, zz]) => [k, x, zz]),
    };
  }
}

// ---------------------------------------------------------------- bot brain
//
// Looks around a few times a second; fights what it sees, otherwise loots,
// heals or heads for the safe zone. A bot steered by an AI agent follows the
// agent's latest order instead of picking its own goal, but still aims and
// shoots by itself.
class BotBrain {
  constructor(u) {
    this.u = u; this.think = Math.random() * 0.3; this.target = null; this.goal = null; this.goalKind = null;
    this.track = 0; this.strafe = 1; this.strafeT = 0; this.burst = 0; this.pauseT = 0; this.stuckT = 0; this.detour = null;
    this.lastPos = u.pos.clone(); this.reaction = 0; this.order = null;
    const lv = u.agent && (AGENT_LEVELS[u.agent.level] || AGENT_LEVELS.talent);
    this.skill = lv ? lv.skill : rand(0.35, 0.7);
    this.sight = lv ? lv.sight : 110;
    this.react = lv ? lv.reaction : 0.5 + (1 - this.skill) * 0.6;
    this.turnK = lv ? lv.turn : 1;
  }
  // what this unit's eyes take in: in front (or very close), in range, nothing in between
  inView(p, near = AWARE) {
    const u = this.u, to = p.clone().sub(u.pos).setY(0), d = to.length();
    return d < near || (d <= this.sight && to.normalize().dot(forward(u.yaw).setY(0).normalize()) > FOV_COS);
  }
  perceives(t) { return this.inView(t.pos) && this.canSee(t); }
  hurtBy(by) { if (!this.target || !this.target.alive) { this.target = by; this.reaction = 0.25; } }
  canSee(t) {
    const u = this.u, I = u.match.island;
    const o = u.eye(), to = t.chest().sub(o), d = to.length();
    if (d > this.sight) return false;
    if (t.crouch && d > this.sight * 0.6) return false;
    return I.raycast(o, to.normalize(), d) >= d - 0.5;
  }
  // misses more at range, and at first: it settles as it keeps tracking the same target
  aimError() {
    const d = this.target ? this.target.pos.distanceTo(this.u.pos) : 20;
    const pistolish = ['pistol', 'smg', 'sg'].includes(this.u.def?.cat) ? 1.6 : 1;
    return (0.075 - this.skill * 0.04) * Math.max(0.35, 1.2 - this.track * 0.35) * (0.7 + d / 60) * pistolish;
  }

  update(dt) {
    const u = this.u, M = u.match;
    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.25 + Math.random() * 0.1;
      // eyes: the nearest visible enemy within its field of view, or anyone very close
      let best = null, bd = Infinity;
      for (const t of M.units) {
        if (t === u || !t.alive || M.time < 15) continue;   // everyone gets a moment to get bearings after landing
        const d = t.pos.distanceTo(u.pos);
        if (d > bd || !this.perceives(t)) continue;
        best = t; bd = d;
      }
      // empty-handed, only fight what is already in arm's reach; otherwise go find a gun
      if (best && !u.weapon && bd > 3.5) best = null;
      if (best && best !== this.target) { this.target = best; this.reaction = this.react; this.track = 0; }
      if (this.target && !u.weapon && this.target.pos.distanceTo(u.pos) > 3.5) this.target = null;
      if (this.target && (!this.target.alive || (!best && this.target.pos.distanceTo(u.pos) > 60))) this.target = null;
      if (!this.target) this.pickGoal();
    }
    const t = this.target;
    u.wish = new THREE.Vector3();
    u.sprint = false; u.ads = false;
    if (t && t.alive) this.fight(dt, t);
    else this.travel(dt);
    // heal when safe
    if (!t && u.hp < 70 && !u.action) { if (!u.useMed('medkit')) u.useMed('bandage'); }
    // pick up what's underfoot
    const it = M.nearestItem(u, 1.6);
    if (it && this.wants(it)) M.pickup(u, it);
    if (u.weapon && u.weapon.mag === 0) u.startReload();
    // best weapon in hand when not fighting
    if (!t && u.reloadT <= 0) {
      const slots = [0, 1, 2].filter((i) => u.slots[i] && (u.slots[i].mag > 0 || u.ammo[WEAPONS[u.slots[i].id].ammo] > 0));
      slots.sort((a, b) => WEAPONS[u.slots[b].id].tier - WEAPONS[u.slots[a].id].tier);
      if (slots.length && slots[0] !== u.cur) u.switchTo(slots[0]);
    }
  }

  wants(it) {
    const u = this.u;
    if (it.kind === 'weapon') {
      const d = WEAPONS[it.id];
      if (u.slots.some((s) => s?.id === it.id)) return false;
      if (d.cat === 'pistol') return !u.slots[2];
      const worst = Math.min(...[0, 1].map((i) => (u.slots[i] ? WEAPONS[u.slots[i].id].tier : 0)));
      return d.tier > worst;
    }
    if (it.kind === 'ammo') return u.slots.some((s) => s && WEAPONS[s.id].ammo === it.ammo);
    if (it.kind === 'box') return it.weapons.length > 0 || u.slots.some(Boolean);
    if (it.kind === 'armor') return it.value > u.armor;
    return true;
  }

  pickGoal() {
    const u = this.u, M = u.match, z = M.zone;
    const order = this.order;
    if (order?.type === 'move') { this.goal = new THREE.Vector3(order.x, 0, order.z); this.goalKind = 'order'; return; }
    if (order?.type === 'hold') { this.goal = null; this.goalKind = 'hold'; return; }
    const outside = Math.hypot(u.pos.x - z.next.cx, u.pos.z - z.next.cz) > z.next.r * 0.85;
    const urgent = outside && (z.state === 'shrink' || z.t < 25 || Math.hypot(u.pos.x - z.cx, u.pos.z - z.cz) > z.r * 0.9);
    if (urgent || order?.type === 'zone') { this.goal = new THREE.Vector3(z.next.cx, 0, z.next.cz); this.goalKind = 'zone'; return; }
    if (this.goalKind === 'loot' && this.goalItem && M.items.includes(this.goalItem)) return;
    const armed = u.slots.some(Boolean);
    let best = null, bd = !armed ? 250 : order?.type === 'loot' ? 120 : 70;
    for (const it of M.items) {
      const d = it.pos.distanceTo(u.pos);
      if (!armed && it.kind !== 'weapon' && it.kind !== 'box') continue;   // a gun first
      if (d < bd && this.wants(it)) { bd = d; best = it; }
    }
    if (best) { this.goalItem = best; this.goal = best.pos.clone(); this.goalKind = 'loot'; return; }
    if (!this.goal || this.goal.distanceTo(u.pos) < 4 || this.goalKind !== 'roam') {
      const a = Math.random() * 6.283, r = Math.random() * z.next.r * 0.8;
      this.goal = new THREE.Vector3(z.next.cx + Math.cos(a) * r, 0, z.next.cz + Math.sin(a) * r);
      this.goalKind = 'roam';
    }
  }

  travel(dt) {
    const u = this.u;
    if (!this.goal) return;
    let to = this.goal.clone().sub(u.pos).setY(0);
    if (to.length() < 0.6) { this.goal = null; return; }
    if (this.detour && this.detour.t > 0) { this.detour.t -= dt; to = this.detour.dir.clone(); }
    to.normalize();
    // avoid trunks ahead by steering round them
    for (const c of u.match.island.circlesNear(u.pos.x + to.x * 2, u.pos.z + to.z * 2, 2)) {
      const off = new THREE.Vector3(c.x - u.pos.x, 0, c.z - u.pos.z), d = off.length();
      if (d < c.r + 1.6 && off.dot(to) > 0) { const side = new THREE.Vector3(-to.z, 0, to.x); to.addScaledVector(side, off.dot(side) > 0 ? -1.2 : 1.2).normalize(); }
    }
    u.wish = to;
    u.yaw += angDiff(u.yaw, Math.atan2(-to.x, -to.z)) * Math.min(1, dt * 6);
    u.pitch *= 0.9;
    u.sprint = this.goalKind === 'zone' || this.goal.distanceTo(u.pos) > 25;
    u.crouch = false;
    // stuck against a wall: take a sideways detour for a moment
    this.stuckT += dt;
    if (this.stuckT > 1.2) {
      if (u.pos.distanceTo(this.lastPos) < 0.8) {
        const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(Math.random() < 0.5 ? 1 : -1);
        this.detour = { dir: side.add(to.clone().multiplyScalar(-0.3)).normalize(), t: 0.9 };
      }
      this.stuckT = 0; this.lastPos.copy(u.pos);
    }
  }

  fight(dt, t) {
    const u = this.u, M = u.match;
    const to = t.chest().sub(u.eye()), d = to.length();
    const wantYaw = Math.atan2(-to.x, -to.z), wantPitch = Math.asin(THREE.MathUtils.clamp(to.y / d, -1, 1));
    const turn = Math.min(1, dt * (3 + this.skill * 6) * this.turnK);
    u.yaw += angDiff(u.yaw, wantYaw) * turn;
    u.pitch += (wantPitch - u.pitch) * turn;
    this.track += dt;
    // keep a distance that suits the gun, strafing side to side
    const def = u.def;
    if (!def) {   // fists: close in and swing
      u.wish = new THREE.Vector3(to.x, 0, to.z).normalize();
      u.sprint = d > 3;
      if (this.reaction > 0) { this.reaction -= dt; return; }
      if (d < 1.8 && Math.abs(angDiff(u.yaw, wantYaw)) < 0.4) M.fire(u);
      return;
    }
    const ideal = def.cat === 'sg' ? 8 : def.cat === 'smg' || def.cat === 'pistol' ? 18 : def.cat === 'sr' || def.cat === 'dmr' ? 70 : 35;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe = -this.strafe; this.strafeT = rand(0.6, 1.6); }
    const flat = new THREE.Vector3(to.x, 0, to.z).normalize(), side = new THREE.Vector3(-flat.z, 0, flat.x);
    u.wish = side.multiplyScalar(this.strafe * 0.8).addScaledVector(flat, d > ideal * 1.3 ? 0.8 : d < ideal * 0.6 ? -0.6 : 0);
    if (u.wish.lengthSq() > 1) u.wish.normalize();
    u.crouch = def && (def.cat === 'sr' || def.cat === 'dmr') && d > 40 && this.strafeT > 0.5;
    u.ads = def && d > 25;
    if (this.reaction > 0) { this.reaction -= dt; return; }
    if (!def || u.reloadT > 0) return;
    if (d > def.range * 1.1) { u.wish.addScaledVector(flat, 1); return; }
    const err = Math.abs(angDiff(u.yaw, wantYaw)) + Math.abs(u.pitch - wantPitch);
    this.pauseT -= dt;
    if (err < 0.08 && this.pauseT <= 0 && this.canSee(t)) {
      if (M.fire(u) && def.auto) {
        this.burst++;
        if (this.burst > 3 + Math.random() * 5) { this.burst = 0; this.pauseT = rand(0.3, 0.7); }
      } else if (!def.auto) this.pauseT = rand(0.15, 0.45) + def.rate;
    }
  }
}

// ---------------------------------------------------------------- visuals

function makeZoneWall() {
  const geo = new THREE.CylinderGeometry(1, 1, 400, 96, 1, true);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; varying vec3 vP; void main(){ vUv = uv; vP = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP,1.0); }',
    fragmentShader: `uniform float uTime; varying vec2 vUv; varying vec3 vP;
      void main(){
        float bands = 0.5 + 0.5 * sin(vP.y * 0.6 - uTime * 2.0);
        float a = 0.16 + 0.12 * bands;
        a *= smoothstep(0.0, 0.02, vUv.y) * (1.0 - smoothstep(0.35, 0.6, vUv.y));
        gl_FragColor = vec4(0.25, 0.55, 1.0, a);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = -20;
  m.frustumCulled = false;
  m.renderOrder = 5;
  return m;
}

const lootGeo = {};
function lootMesh(it) {
  const g = new THREE.Group();
  const M = (c, r = 0.7, m = 0.05) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  if (it.kind === 'weapon') {
    const gun = buildGun(it.id).group;
    gun.rotation.set(0, 0, Math.PI / 2);   // lying on its side
    gun.position.y = 0.03;
    g.add(gun);
  } else if (it.kind === 'ammo') {
    lootGeo.ammo ??= new THREE.BoxGeometry(0.26, 0.14, 0.16);
    const b = new THREE.Mesh(lootGeo.ammo, M(0x4a5236));
    b.position.y = 0.07; g.add(b);
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.262, 0.03, 0.162), M(0xc49a3a, 0.5, 0.6)); s.position.y = 0.1; g.add(s);
  } else if (it.kind === 'med') {
    if (it.med === 'medkit') {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.26), M(0xe8e4dc, 0.5)); b.position.y = 0.06; g.add(b);
      for (const [w, d] of [[0.16, 0.05], [0.05, 0.16]]) { const c = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), M(0xc8242a)); c.position.y = 0.125; g.add(c); }
    } else {
      for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 16), M(0xf2efe6, 0.9)); r.position.set(i * 0.09 - 0.09, 0.04, 0); g.add(r); }
    }
  } else if (it.kind === 'armor') {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.5), M(0x2e3a2a, 0.85)); v.position.y = 0.04; g.add(v);
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.34), M(0x1f241d, 0.6)); p.position.y = 0.095; g.add(p);
  } else {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.45), M(0x5a4630, 0.8)); b.position.y = 0.2; g.add(b);
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.06, 0.47), M(0x3a2d20, 0.8)); l.position.y = 0.38; g.add(l);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

class Tracers {
  constructor(group) {
    this.max = 64; this.list = [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 6), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.max * 6), 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    group.add(this.lines);
  }
  add(a, b) { this.list.push({ a: a.clone(), b: b.clone(), t: 0.07 }); if (this.list.length > this.max) this.list.shift(); }
  update(dt) {
    const P = this.lines.geometry.attributes.position, C = this.lines.geometry.attributes.color;
    this.list = this.list.filter((l) => (l.t -= dt) > 0);
    for (let i = 0; i < this.max; i++) {
      const l = this.list[i];
      if (!l) { P.setXYZ(i * 2, 0, -999, 0); P.setXYZ(i * 2 + 1, 0, -999, 0); continue; }
      // a short streak travelling along the shot
      const k = 1 - l.t / 0.07, s = l.a.clone().lerp(l.b, Math.max(0, k - 0.25)), e = l.a.clone().lerp(l.b, k);
      P.setXYZ(i * 2, s.x, s.y, s.z); P.setXYZ(i * 2 + 1, e.x, e.y, e.z);
      C.setXYZ(i * 2, 0.4, 0.3, 0.1); C.setXYZ(i * 2 + 1, 1, 0.85, 0.5);
    }
    P.needsUpdate = true; C.needsUpdate = true;
  }
}

class Puffs {
  constructor(group) {
    this.group = group; this.list = [];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), rg = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,.9)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 64, 64);
    this.tex = new THREE.CanvasTexture(c);
  }
  add(p, color) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color, transparent: true, depthWrite: false }));
    s.position.copy(p); s.scale.setScalar(0.25);
    this.group.add(s);
    this.list.push({ s, t: 0.5 });
  }
  update(dt) {
    this.list = this.list.filter((p) => {
      p.t -= dt;
      p.s.scale.setScalar(0.25 + (0.5 - p.t) * 1.4);
      p.s.material.opacity = Math.max(0, p.t * 2);
      if (p.t <= 0) { this.group.remove(p.s); p.s.material.dispose(); return false; }
      return true;
    });
  }
}
