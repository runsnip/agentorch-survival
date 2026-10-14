// The arena island: terrain, water, sky, villages, trees and rocks, plus the
// queries the match needs (ground height, collisions, line of sight).
//
// Everything is generated from one seed. Distances are in metres; y is up,
// the island is centred on the origin and the sea level is y = 0.

import * as THREE from 'three';
import { buildFlora, seeded } from '/flora.js';   // shared with the office's street trees

// the island's own ground photographs (tex/SOURCES.md)
const TEX = new URL('./tex/', import.meta.url).href;
function photo(name, { srgb = true } = {}) {
  const t = new THREE.TextureLoader().load(TEX + name);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export const SIZE = 640;          // terrain square, metres
const N = 192;                    // terrain grid cells per side
const CELL = SIZE / N;

// The maps to choose from in the lobby. Names are made up for this game.
export const MAPS = [
  { id: 'lam-chau', name: 'Lam Châu', desc: 'Rừng thông xen cây lá rộng, đồi thoải, năm ngôi làng.',
    radius: 255, hills: 1, forest: 1, pine: 0, villages: 5, sand: 2.3, leaf: 0xffffff, grass: 0xffffff,
    sky: [0x3d78c2, 0xc9dbe6], art: ['#3f6f4a', '#7fb0d8'] },
  { id: 'con-ha', name: 'Cồn Hạ', desc: 'Đảo nhỏ, bãi cát dài và đồng trống: đấu súng tầm xa.',
    radius: 205, hills: 0.5, forest: 0.4, pine: 0.5, villages: 4, sand: 3.4, leaf: 0xeef7d6, grass: 0xf4ecc8,
    sky: [0x2f7fd0, 0xe6e2d2], art: ['#c9b27a', '#69a9d9'] },
  { id: 'rung-phong', name: 'Rừng Phong', desc: 'Đồi cao, rừng lá rộng mùa thu rậm rạp: đánh nhau cự ly gần.',
    radius: 240, hills: 1.6, forest: 1.5, pine: 0.75, villages: 3, sand: 2, leaf: 0xffae6a, grass: 0xf0d79a,
    sky: [0x5a7fae, 0xe3cdb0], art: ['#b8642e', '#e0b38a'] },
];
const GRID = 8;                   // spatial hash cell for obstacles

// ---------------------------------------------------------------- noise

function makeNoise(seed) {
  const r = seeded(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i).sort(() => r() - 0.5);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => ((h & 1) ? x : -x) + ((h & 2) ? y : -y);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const noise = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    const l1 = grad(perm[a], x, y) + u * (grad(perm[b], x - 1, y) - grad(perm[a], x, y));
    const l2 = grad(perm[a + 1], x, y - 1) + u * (grad(perm[b + 1], x - 1, y - 1) - grad(perm[a + 1], x, y - 1));
    return l1 + v * (l2 - l1);
  };
  return (x, y, oct = 4) => {
    let s = 0, a = 1, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  };
}

// ---------------------------------------------------------------- island

export class Island {
  constructor(seed = 1, map = MAPS[0]) {
    this.seed = seed; this.map = map; this.radius = map.radius;
    this.group = new THREE.Group();
    this.boxes = [];        // house walls etc: {min: Vector3, max: Vector3}
    this.circles = new Map(); // spatial hash → [{x, z, r, h, kind}]
    this.lootSpots = [];    // [{x, y, z, indoor}]
    this.villages = [];
  }

  async build(renderer) {
    const fbm = makeNoise(this.seed), detail = makeNoise(this.seed + 7), rnd = seeded(this.seed * 31 + 5);
    this.rnd = rnd;
    // villages first: the ground under them is flattened
    for (let i = 0; i < this.map.villages; i++) {
      for (let t = 0; t < 40; t++) {
        const a = rnd() * 6.283, d = 40 + rnd() * (this.radius - 95);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (this.villages.every((v) => Math.hypot(v.x - x, v.z - z) > 95)) { this.villages.push({ x, z, r: 30 + rnd() * 8 }); break; }
      }
    }
    // heights on the grid
    const H = this.H = new Float32Array((N + 1) * (N + 1));
    const shoreWobble = (a) => 1 + 0.12 * Math.sin(a * 3 + this.seed) + 0.07 * Math.sin(a * 7 + this.seed * 2) + 0.04 * Math.sin(a * 13);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = -SIZE / 2 + i * CELL, z = -SIZE / 2 + j * CELL;
      const d = Math.hypot(x, z) / (this.radius * shoreWobble(Math.atan2(z, x)));
      const mask = 1 - THREE.MathUtils.smoothstep(d, 0.78, 1.08);
      const hills = ((fbm(x / 140, z / 140, 4) * 0.5 + 0.5) * 14 + Math.max(0, fbm(x / 60 + 9, z / 60, 3)) * 7) * this.map.hills;
      let h = 1.6 + hills * mask - (1 - mask) * 9;
      for (const v of this.villages) {  // flatten village plots
        const k = 1 - THREE.MathUtils.smoothstep(Math.hypot(x - v.x, z - v.z), v.r * 0.85, v.r * 1.5);
        if (k > 0) { v.h ??= h; h = h * (1 - k) + v.h * k; }
      }
      H[j * (N + 1) + i] = h;
    }
    for (const v of this.villages) v.h = this.heightAt(v.x, v.z);

    this.flora = await buildFlora(this.map.leaf, this.map.grass);
    this.buildTerrain(detail);
    this.buildWater();
    this.buildSky();
    this.buildVillages();
    this.scatter(fbm);
    this.grass = new GrassField(this);
    this.group.add(this.grass.mesh);
    return this;
  }

  // bilinear height on the terrain grid; matches the mesh closely enough to stand on
  heightAt(x, z) {
    const fx = (x + SIZE / 2) / CELL, fz = (z + SIZE / 2) / CELL;
    const i = Math.max(0, Math.min(N - 1, Math.floor(fx))), j = Math.max(0, Math.min(N - 1, Math.floor(fz)));
    const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fz - j));
    const H = this.H, W = N + 1;
    const a = H[j * W + i], b = H[j * W + i + 1], c = H[(j + 1) * W + i], d = H[(j + 1) * W + i + 1];
    // match the triangle split of the mesh (a-c-b / b-c-d)
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
  isLand(x, z) { return this.heightAt(x, z) > 0.4; }

  buildTerrain(detail) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, N, N);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, W = N + 1;
    const wts = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const i = k % W, j = Math.floor(k / W);
      const h = this.H[j * W + i];
      pos.setY(k, h);
      const x = pos.getX(k), z = pos.getZ(k);
      const sand = 1 - THREE.MathUtils.smoothstep(h, 1.2, this.map.sand);
      let dirt = THREE.MathUtils.smoothstep(detail(x / 45, z / 45, 3), 0.18, 0.42) * 0.8;
      for (const v of this.villages) dirt = Math.max(dirt, 1 - THREE.MathUtils.smoothstep(Math.hypot(x - v.x, z - v.z), v.r * 0.5, v.r * 1.05));
      dirt *= 1 - sand;
      wts[k * 3] = Math.max(0, 1 - sand - dirt); wts[k * 3 + 1] = dirt; wts[k * 3 + 2] = sand;
    }
    geo.setAttribute('wts', new THREE.BufferAttribute(wts, 3));
    geo.computeVertexNormals();
    const grass = photo('ground_grass.jpg'), dirt = photo('ground_dirt.jpg'), sand = photo('ground_sand.jpg');
    const mat = new THREE.MeshStandardMaterial({ map: grass, normalMap: photo('ground_grass_n.jpg', { srgb: false }), roughness: 0.95 });
    mat.normalScale.set(0.6, 0.6);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.tDirt = { value: dirt }; sh.uniforms.tSand = { value: sand };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 wts;\nvarying vec3 vW;\nvarying vec2 vWorldXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = wts;\nvWorldXZ = position.xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tDirt, tSand;\nvarying vec3 vW;\nvarying vec2 vWorldXZ;')
        .replace('#include <map_fragment>', `
          // world-space tiling: no seams; a second, sparse tiling breaks up repetition from afar
          vec2 uvA = vWorldXZ / 5.0, uvB = vWorldXZ / 23.0;
          vec3 g = mix(texture2D(map, uvA).rgb, texture2D(map, uvB).rgb, 0.35);
          vec3 d = mix(texture2D(tDirt, uvA * 0.8).rgb, texture2D(tDirt, uvB).rgb, 0.3);
          vec3 s = texture2D(tSand, uvA * 0.7).rgb;
          float macro = 0.85 + 0.3 * texture2D(map, vWorldXZ / 180.0).g;
          vec3 W = vW / max(0.001, vW.x + vW.y + vW.z);
          diffuseColor.rgb *= (g * W.x + d * W.y + s * W.z) * macro;`)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>'.replace('', ''));
      // the normal map samples with vNormalMapUv; feed it the same world tiling
      sh.fragmentShader = sh.fragmentShader.replace('texture2D( normalMap, vNormalMapUv )', 'texture2D( normalMap, vWorldXZ / 5.0 )');
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrain = mesh;
    this.group.add(mesh);
  }

  buildWater() {
    const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2d6f86, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.86 });
    this.waterTime = { value: 0 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.waterTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWP;')
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          float w1 = sin(vWP.x * 0.35 + uTime * 1.1) * cos(vWP.z * 0.27 - uTime * 0.8);
          float w2 = sin(vWP.x * 0.9 - vWP.z * 0.7 + uTime * 1.9);
          normal = normalize(normal + vec3(w1 * 0.06 + w2 * 0.03, 0.0, w2 * 0.05));`);
    };
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = 0;
    this.group.add(this.water);
  }

  buildSky() {
    const top = new THREE.Color(this.map.sky[0]), horizon = new THREE.Color(this.map.sky[1]);
    this.fogColor = horizon;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { cTop: { value: top }, cHor: { value: horizon }, sunDir: { value: new THREE.Vector3(0.45, 0.62, 0.35).normalize() } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 cTop, cHor, sunDir; varying vec3 vD;
        void main(){
          float t = pow(clamp(vD.y, 0.0, 1.0), 0.55);
          vec3 c = mix(cHor, cTop, t);
          float s = max(0.0, dot(normalize(vD), sunDir));
          c += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.sky = sky;
    this.sunDir = sky.material.uniforms.sunDir.value;
    this.group.add(sky);
  }

  // ---- villages: concrete houses with a door, windows and a flat roof
  buildVillages() {
    const rnd = this.rnd;
    const plaster = new THREE.MeshStandardMaterial({ color: 0xd9d3c7, roughness: 0.92 });
    const plaster2 = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.92 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8d8b86, roughness: 0.95 });
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x9c8a74, roughness: 0.85 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.6, metalness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fb7c4, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.25 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const add = (mat, x0, y0, z0, x1, y1, z1, solid = true) => {
      const m = new THREE.Mesh(box, mat);
      m.scale.set(x1 - x0, y1 - y0, z1 - z0);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      if (solid) this.boxes.push({ min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1) });
    };
    const T = 0.25, WH = 3.1;
    // one wall from (ax, az) to (bx, bz) with openings [{at, w, y0, y1}] along it
    const wall = (ax, az, bx, bz, y, openings, mat) => {
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
      const seg = (s0, s1, y0, y1) => {
        if (s1 - s0 < 0.01 || y1 - y0 < 0.01) return;
        const x0 = ax + ux * s0, z0 = az + uz * s0, x1 = ax + ux * s1, z1 = az + uz * s1;
        add(mat, Math.min(x0, x1) - (uz ? T / 2 : 0), y + y0, Math.min(z0, z1) - (ux ? T / 2 : 0),
          Math.max(x0, x1) + (uz ? T / 2 : 0), y + y1, Math.max(z0, z1) + (ux ? T / 2 : 0));
      };
      let s = 0;
      for (const o of openings.sort((a, b) => a.at - b.at)) {
        seg(s, o.at - o.w / 2, 0, WH);
        seg(o.at - o.w / 2, o.at + o.w / 2, 0, o.y0);
        seg(o.at - o.w / 2, o.at + o.w / 2, o.y1, WH);
        if (o.y0 > 0.1) {  // a window: thin frame and glass that doesn't block
          const cx = ax + ux * o.at, cz = az + uz * o.at;
          const g = new THREE.Mesh(box, glass);
          g.scale.set(ux ? o.w : 0.03, o.y1 - o.y0, uz ? o.w : 0.03);
          g.position.set(cx, y + (o.y0 + o.y1) / 2, cz);
          this.group.add(g);
          const f = new THREE.Mesh(box, frame);
          f.scale.set(ux ? o.w + 0.08 : T + 0.04, 0.06, uz ? o.w + 0.08 : T + 0.04);
          f.position.set(cx, y + o.y0, cz);
          this.group.add(f);
        }
        s = o.at + o.w / 2;
      }
      seg(s, len, 0, WH);
    };
    for (const v of this.villages) {
      const count = 3 + Math.floor(rnd() * 3);
      const placed = [];
      for (let n = 0; n < count; n++) {
        for (let t = 0; t < 30; t++) {
          const w = 7 + Math.floor(rnd() * 4), d = 6 + Math.floor(rnd() * 3);
          const a = rnd() * 6.283, rr = rnd() * v.r * 0.6;
          const cx = v.x + Math.cos(a) * rr, cz = v.z + Math.sin(a) * rr;
          if (placed.some((p) => Math.abs(p.cx - cx) < (p.w + w) / 2 + 5 && Math.abs(p.cz - cz) < (p.d + d) / 2 + 5)) continue;
          placed.push({ cx, cz, w, d });
          const y = v.h, x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
          const mat = rnd() < 0.5 ? plaster : plaster2;
          add(concrete, x0 - 0.2, y - 0.6, z0 - 0.2, x1 + 0.2, y + 0.12, z1 + 0.2, false);   // plinth (walkable)
          add(floorMat, x0, y + 0.12, z0, x1, y + 0.14, z1, false);
          const doorSide = Math.floor(rnd() * 4);
          const win = (len) => {
            const o = [];
            for (let s = 1.8; s < len - 1.2; s += 2.6) o.push({ at: s, w: 1.3, y0: 1.0, y1: 2.2 });
            return o;
          };
          const door = (len) => [{ at: len / 2, w: 1.3, y0: 0, y1: 2.3 }];
          const sides = [[x0, z0, x1, z0, w], [x1, z0, x1, z1, d], [x1, z1, x0, z1, w], [x0, z1, x0, z0, d]];
          sides.forEach(([ax, az, bx, bz, len], i) => {
            let ops = i === doorSide ? door(len) : win(len);
            if (i === doorSide && len > 8) ops = ops.concat([{ at: 1.6, w: 1.2, y0: 1.0, y1: 2.2 }]);
            wall(ax, az, bx, bz, y + 0.12, ops, mat);
          });
          // flat roof with a low parapet
          add(concrete, x0 - 0.35, y + 0.12 + WH, z0 - 0.35, x1 + 0.35, y + 0.42 + WH, z1 + 0.35);
          add(mat, x0 - 0.35, y + 0.42 + WH, z0 - 0.35, x1 + 0.35, y + 0.8 + WH, z0 - 0.1);
          add(mat, x0 - 0.35, y + 0.42 + WH, z1 + 0.1, x1 + 0.35, y + 0.8 + WH, z1 + 0.35);
          // loot inside
          const spots = 2 + Math.floor(rnd() * 3);
          for (let k = 0; k < spots; k++) this.lootSpots.push({ x: x0 + 1 + rnd() * (w - 2), y: y + 0.14, z: z0 + 1 + rnd() * (d - 2), indoor: true });
          this.houses = (this.houses || []).concat([{ x0, z0, x1, z1, y }]);
          break;
        }
      }
    }
  }

  insideHouse(x, z) { return (this.houses || []).some((h) => x > h.x0 - 1 && x < h.x1 + 1 && z > h.z0 - 1 && z < h.z1 + 1); }

  // ---- trees, bushes and rocks, instanced per kind
  scatter(fbm) {
    const rnd = this.rnd, f = this.flora;
    const place = { };
    const kinds = Object.keys(f.kinds);
    for (const k of kinds) place[k] = [];
    const rocks = f.rocks.map(() => []);
    const ok = (x, z, clear) => {
      const h = this.heightAt(x, z);
      if (h < 2.1) return false;
      if (this.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r * 0.95 + clear)) return false;
      return true;
    };
    const R = this.radius * 1.05;
    for (let n = 0; n < 9000; n++) {
      const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
      const forest = fbm(x / 90 + 40, z / 90, 3);   // dense woods and open meadows
      const pick = rnd();
      if (pick < 0.62) {          // a tree, mostly where the forest mask is high
        if (rnd() > (THREE.MathUtils.smoothstep(forest, -0.15, 0.25) * 0.75 + 0.03) * this.map.forest) continue;
        if (!ok(x, z, 4)) continue;
        const pine = fbm(x / 120, z / 120 + 30, 2) > this.map.pine * 0.5;
        const k = (pine ? ['pine_a', 'pine_b', 'pine_c'] : ['oak_a', 'oak_b', 'oak_c'])[Math.floor(rnd() * 3)];
        const s = 0.8 + rnd() * 0.45;
        if (this.blockedBy(x, z, f.kinds[k].trunkR * s + 1.4)) continue;
        place[k].push([x, z, s]);
        this.addCircle({ x, z, r: f.kinds[k].trunkR * s, h: f.kinds[k].height * s, kind: 'tree' });
      } else if (pick < 0.86) {
        if (!ok(x, z, 1)) continue;
        place[rnd() < 0.5 ? 'bush_a' : 'bush_b'].push([x, z, 0.8 + rnd() * 0.5]);
      } else if (pick < 0.9) {
        if (this.heightAt(x, z) < 0.8 || this.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r)) continue;
        const i = Math.floor(rnd() * f.rocks.length), s = 0.7 + rnd() * 0.6;
        if (this.blockedBy(x, z, f.rocks[i].size * s + 0.5)) continue;
        rocks[i].push([x, z, s]);
        this.addCircle({ x, z, r: f.rocks[i].size * s * 0.85, h: f.rocks[i].size * s * 0.9, kind: 'rock' });
      }
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const inst = (geo, mat, list, shadow = true, sink = 0.1) => {
      if (!geo || !list.length) return;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(([x, z, s], i) => {
        q.setFromAxisAngle(up, ((x * 13.1 + z * 7.7) % 6.283));
        m4.compose(new THREE.Vector3(x, this.heightAt(x, z) - sink * s, z), q, new THREE.Vector3(s, s, s));
        m.setMatrixAt(i, m4);
      });
      m.castShadow = shadow; m.receiveShadow = true;
      m.computeBoundingSphere();
      this.group.add(m);
    };
    for (const k of kinds) {
      const d = f.kinds[k];
      inst(d.trunk, d.trunkMat, place[k]);
      inst(d.leaves, d.leafMat, place[k]);
    }
    f.rocks.forEach((r, i) => inst(r.geo, f.rockMat, rocks[i], true, 0.25));
    // a few loot spots out in the open too
    for (let n = 0; n < 60; n++) {
      const x = (rnd() * 2 - 1) * this.radius * 0.85, z = (rnd() * 2 - 1) * this.radius * 0.85;
      if (this.heightAt(x, z) > 1.5 && !this.blockedBy(x, z, 1.2)) this.lootSpots.push({ x, y: this.heightAt(x, z), z, indoor: false });
    }
  }

  // ---- obstacles
  key(i, j) { return i * 100000 + j; }
  addCircle(c) {
    const k = this.key(Math.floor(c.x / GRID), Math.floor(c.z / GRID));
    if (!this.circles.has(k)) this.circles.set(k, []);
    this.circles.get(k).push(c);
  }
  *circlesNear(x, z, rad) {
    const i0 = Math.floor((x - rad) / GRID), i1 = Math.floor((x + rad) / GRID), j0 = Math.floor((z - rad) / GRID), j1 = Math.floor((z + rad) / GRID);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const l = this.circles.get(this.key(i, j)); if (l) yield* l; }
  }
  blockedBy(x, z, r) {
    for (const c of this.circlesNear(x, z, r + 4)) if (Math.hypot(c.x - x, c.z - z) < c.r + r) return true;
    return this.insideHouse(x, z);
  }

  // Push a body (feet at y, radius r, height bh) out of trunks, rocks and walls.
  collide(p, r, bh = 1.7) {
    for (const c of this.circlesNear(p.x, p.z, r + 4)) {
      if (c.kind === 'rock' && p.y > this.heightAt(c.x, c.z) + c.h - 0.4) continue;  // standing on top of it
      const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), min = c.r + r;
      if (d < min && d > 1e-6) { p.x = c.x + dx / d * min; p.z = c.z + dz / d * min; }
    }
    for (const b of this.boxes) {
      if (p.y + bh < b.min.y || p.y + 0.35 > b.max.y) continue;   // low steps and overhead slabs don't block
      const cx = Math.max(b.min.x, Math.min(p.x, b.max.x)), cz = Math.max(b.min.z, Math.min(p.z, b.max.z));
      const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d > 1e-6) { p.x = cx + dx / d * r; p.z = cz + dz / d * r; }
      else {  // centre inside the box: leave by the nearest face
        const ex = [b.min.x - r - p.x, b.max.x + r - p.x], ez = [b.min.z - r - p.z, b.max.z + r - p.z];
        const bx = Math.abs(ex[0]) < Math.abs(ex[1]) ? ex[0] : ex[1], bz = Math.abs(ez[0]) < Math.abs(ez[1]) ? ez[0] : ez[1];
        if (Math.abs(bx) < Math.abs(bz)) p.x += bx; else p.z += bz;
      }
    }
  }

  // Floor under a point: terrain, or a house floor / roof the point stands on.
  floorAt(x, y, z) {
    let f = this.heightAt(x, z);
    for (const h of this.houses || []) if (x > h.x0 - 0.2 && x < h.x1 + 0.2 && z > h.z0 - 0.2 && z < h.z1 + 0.2 && y > h.y - 0.3) f = Math.max(f, h.y + 0.14);
    return f;
  }

  // Distance along a ray to the first solid thing (terrain, wall, trunk, rock), or Infinity.
  raycast(o, d, max) {
    let best = max;
    for (const b of this.boxes) {
      let t0 = 0, t1 = best;
      for (const ax of ['x', 'y', 'z']) {
        if (Math.abs(d[ax]) < 1e-9) { if (o[ax] < b.min[ax] || o[ax] > b.max[ax]) { t0 = Infinity; break; } continue; }
        let a = (b.min[ax] - o[ax]) / d[ax], c = (b.max[ax] - o[ax]) / d[ax];
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        if (t0 > t1) break;
      }
      if (t0 <= t1 && t0 < best) best = t0;
    }
    // trunks and rocks: walk the hash cells along the ray
    const step = GRID * 0.5;
    for (let s = 0; s < best; s += step) {
      const x = o.x + d.x * s, z = o.z + d.z * s;
      for (const c of this.circlesNear(x, z, 1)) {
        const fx = o.x - c.x, fz = o.z - c.z, a = d.x * d.x + d.z * d.z;
        if (a < 1e-9) continue;
        const b = fx * d.x + fz * d.z, cc = fx * fx + fz * fz - c.r * c.r, disc = b * b - a * cc;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / a;
        if (t < 0 || t >= best) continue;
        const y = o.y + d.y * t, base = this.heightAt(c.x, c.z);
        if (y > base - 0.2 && y < base + (c.kind === 'tree' ? Math.min(c.h * 0.55, 7) : c.h)) best = t;
      }
    }
    // terrain: march, then refine
    for (let s = 0.5; s < best; s += 1.5) {
      if (o.y + d.y * s < this.heightAt(o.x + d.x * s, o.z + d.z * s)) {
        let lo = Math.max(0, s - 1.5), hi = s;
        for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (o.y + d.y * m < this.heightAt(o.x + d.x * m, o.z + d.z * m)) hi = m; else lo = m; }
        best = Math.min(best, hi);
        break;
      }
    }
    return best;
  }

  // free the GPU side when another map replaces this one
  dispose() {
    const seen = new Set();
    this.group.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      for (const m of [].concat(o.material || [])) {
        if (seen.has(m)) continue;
        seen.add(m);
        for (const v of Object.values(m)) if (v?.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
        m.dispose();
      }
    });
  }

  update(dt, viewer) {
    this.flora.wind.value += dt;
    this.waterTime.value += dt;
    this.sky.position.copy(viewer);
    this.grass.follow(viewer);
  }
}

// ---------------------------------------------------------------- grass around the viewer
//
// Grass only grows near the viewer: a fixed pool of clumps re-planted on a grid
// whose cells hash to stable positions, so walking doesn't make it jump.
class GrassField {
  constructor(island) {
    this.island = island;
    this.R = 42; this.cell = 1.1;
    const max = Math.ceil(Math.PI * (this.R / this.cell) ** 2);
    this.mesh = new THREE.InstancedMesh(island.flora.grass, island.flora.grassMat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.at = new THREE.Vector3(1e9, 0, 0);
  }
  follow(p) {
    if (Math.hypot(p.x - this.at.x, p.z - this.at.z) < 3) return;
    this.at.copy(p);
    const I = this.island, c = this.cell, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3();
    const i0 = Math.floor((p.x - this.R) / c), i1 = Math.floor((p.x + this.R) / c), j0 = Math.floor((p.z - this.R) / c), j1 = Math.floor((p.z + this.R) / c);
    let n = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      const r1 = ((h >>> 0) % 1000) / 1000, r2 = ((h >>> 10) % 1000) / 1000, r3 = ((h >>> 20) % 1000) / 1000;
      const x = (i + r1) * c, z = (j + r2) * c;
      if ((x - p.x) ** 2 + (z - p.z) ** 2 > this.R * this.R) continue;
      const y = I.heightAt(x, z);
      if (y < 2.2 || r3 < 0.25 || I.insideHouse(x, z)) continue;
      if (I.villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.r * 0.75)) continue;
      q.setFromAxisAngle(up, r3 * 6.283);
      const k = 0.7 + r1 * 0.7;
      m4.compose(new THREE.Vector3(x, y - 0.03, z), q, s.set(k, k * (0.8 + r2 * 0.5), k));
      this.mesh.setMatrixAt(n++, m4);
      if (n >= this.mesh.instanceMatrix.count) break;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
