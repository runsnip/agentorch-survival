// In-match HUD: health and armour, weapon and ammo, slots, compass, minimap,
// kill feed, hit markers, damage direction, the pick-up prompt and the scope.

import { WEAPONS, AMMO } from './weapons.js';
import { SIZE } from './island.js';
import { t } from '/i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createHud(root, island) {
  const el = document.createElement('div');
  el.className = 'ar-hud';
  el.innerHTML = `
    <div class="ar-top"><div class="ar-compass"><div class="ar-compass-strip"></div><i></i></div>
      <div class="ar-counts"><span class="ar-alive"></span><span class="ar-kills"></span></div></div>
    <div class="ar-zone"></div>
    <canvas class="ar-map" width="200" height="200"></canvas>
    <div class="ar-feed"></div>
    <div class="ar-msg"></div>
    <div class="ar-cross"><i></i><i></i><i></i><i></i></div>
    <div class="ar-hit"><i></i><i></i><i></i><i></i></div>
    <div class="ar-dmg"></div>
    <div class="ar-scope"><div class="ar-scope-ring"></div></div>
    <div class="ar-prompt"></div>
    <div class="ar-action"><b></b><div class="ar-action-bar"><i></i></div></div>
    <div class="ar-vitals"><div class="ar-armor"><i></i></div><div class="ar-hp"><i></i><span></span></div></div>
    <div class="ar-weapon"><div class="ar-ammo"><b></b><small></small></div><div class="ar-wname"></div><div class="ar-slots"></div>
      <div class="ar-meds"></div></div>`;
  root.append(el);
  const $ = (s) => el.querySelector(s);
  const map = $('.ar-map'), mctx = map.getContext('2d');

  // the island seen from above, once
  const base = document.createElement('canvas');
  base.width = base.height = 200;
  {
    const g = base.getContext('2d'), img = g.createImageData(200, 200);
    for (let j = 0; j < 200; j++) for (let i = 0; i < 200; i++) {
      const x = (i / 200 - 0.5) * SIZE, z = (j / 200 - 0.5) * SIZE, h = island.heightAt(x, z), k = (j * 200 + i) * 4;
      const c = h < 0.2 ? [38, 82, 104] : h < 2.2 ? [196, 182, 140] : [78 + h * 2, 104 + h * 2.5, 58 + h];
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = 'rgba(70,60,52,.9)';
    for (const h of island.houses || []) {
      const p = (v) => (v / SIZE + 0.5) * 200;
      g.fillRect(p(h.x0), p(h.z0), Math.max(1.5, p(h.x1) - p(h.x0)), Math.max(1.5, p(h.z1) - p(h.z0)));
    }
  }

  // compass strip: N E S W with ticks every 15°
  {
    const strip = $('.ar-compass-strip');
    let html = '';
    for (let a = -360; a <= 720; a += 15) {
      const n = ((a % 360) + 360) % 360;
      const label = { 0: t('B'), 90: t('Đ'), 180: t('N'), 270: t('T') }[n];
      html += `<span style="left:${(a + 360) * 2}px" class="${label ? 'big' : ''}">${label || (n % 45 ? '' : n)}</span>`;
    }
    strip.innerHTML = html;
  }

  let hitT = 0, msgT = 0, lastHud = 0;
  const hud = {
    el,
    feed(text, cls = '') {
      const line = document.createElement('div');
      line.className = 'ar-feedline ' + cls;
      line.innerHTML = text;
      $('.ar-feed').prepend(line);
      setTimeout(() => line.classList.add('out'), 5500);
      setTimeout(() => line.remove(), 6200);
      while ($('.ar-feed').children.length > 6) $('.ar-feed').lastChild.remove();
    },
    message(text, secs = 3) { $('.ar-msg').textContent = text; $('.ar-msg').classList.add('on'); msgT = secs; },
    hitmark(kill, head) { const h = $('.ar-hit'); h.className = 'ar-hit on' + (kill ? ' kill' : head ? ' head' : ''); hitT = kill ? 0.35 : 0.18; },
    hurt(angle, camYaw) {
      const d = $('.ar-dmg');
      d.classList.remove('on'); void d.offsetWidth; d.classList.add('on');
      if (angle != null) d.style.setProperty('--a', `${(-(angle - camYaw - Math.PI)) * 180 / Math.PI}deg`);
    },
    // per frame
    update(dt, m, cam) {
      const p = m.player;
      hitT -= dt; if (hitT <= 0) $('.ar-hit').classList.remove('on');
      msgT -= dt; if (msgT <= 0) $('.ar-msg').classList.remove('on');
      // compass follows the view (0° = north = −z)
      const deg = ((-cam.yaw * 180 / Math.PI) % 360 + 360) % 360;
      $('.ar-compass-strip').style.transform = `translateX(${-(deg + 360) * 2 + 150}px)`;
      const scoped = p.ads && p.def?.scope && cam.adsK > 0.85;
      el.classList.toggle('scoped', !!scoped);
      // the gap shows the real cone of fire: tan(spread) at the screen's focal length (2 sigma)
      const focal = innerHeight / 2 / Math.tan((cam.fov || 60) * Math.PI / 360);
      $('.ar-cross').style.setProperty('--gap', `${4 + Math.tan(m.spreadOf(p) * 2) * focal}px`);
      $('.ar-cross').classList.toggle('hide', !!(p.ads && !p.def?.scope) || p.sprint);
      const now = performance.now();
      if (now - lastHud < 90) return;
      lastHud = now;
      $('.ar-hp i').style.width = `${Math.max(0, p.hp)}%`;
      $('.ar-hp').classList.toggle('low', p.hp < 30);
      $('.ar-hp span').textContent = Math.ceil(Math.max(0, p.hp));
      $('.ar-armor i').style.width = `${p.armor}%`;
      $('.ar-armor').classList.toggle('none', !p.armor);
      $('.ar-alive').innerHTML = t('{n} CÒN SỐNG', { n: `<b>${m.alive}</b>` });
      $('.ar-kills').innerHTML = t('{n} HẠ GỤC', { n: `<b>${p.kills}</b>` });
      const w = p.weapon, d = p.def;
      $('.ar-ammo b').textContent = w ? w.mag : '–';
      $('.ar-ammo small').textContent = w ? p.ammo[d.ammo] : '';
      $('.ar-ammo').classList.toggle('low', !!w && w.mag <= Math.ceil(d.mag * 0.2));
      $('.ar-wname').textContent = d ? `${d.name} · ${AMMO[d.ammo]}${d.auto ? ' · AUTO' : ''}` : t('Tay không');
      $('.ar-slots').innerHTML = [0, 1, 2].map((i) => `<span class="${p.cur === i ? 'on' : ''}${p.slots[i] ? '' : ' empty'}"><kbd>${i + 1}</kbd>${p.slots[i] ? esc(WEAPONS[p.slots[i].id].name) : '—'}</span>`).join('');
      $('.ar-meds').innerHTML = `<span><kbd>4</kbd>${t('Băng gạc ×{n}', { n: p.meds.bandage })}</span><span><kbd>5</kbd>${t('Cứu thương ×{n}', { n: p.meds.medkit })}</span>`;
      // action bar: reload / healing
      const act = p.action ? { label: p.action.kind === 'medkit' ? t('Đang dùng bộ cứu thương') : t('Đang băng bó'), k: 1 - p.action.t / p.action.total }
        : p.reloadT > 0 ? { label: t('Nạp đạn'), k: 1 - p.reloadT / p.reloadTotal } : null;
      $('.ar-action').classList.toggle('on', !!act);
      if (act) { $('.ar-action b').textContent = act.label; $('.ar-action-bar i').style.width = `${act.k * 100}%`; }
      // pick-up prompt
      const it = cam.lookItem;
      $('.ar-prompt').classList.toggle('on', !!it);
      if (it) $('.ar-prompt').innerHTML = `<kbd>F</kbd> ${t('Nhặt {item}', { item: `<b>${esc(m.itemLabel(it))}</b>` })}`;
      // zone
      const z = m.zone, outside = Math.hypot(p.pos.x - z.cx, p.pos.z - z.cz) > z.r;
      $('.ar-zone').innerHTML = (z.state === 'wait' ? t('Vùng an toàn thu hẹp sau {s}', { s: `<b>${Math.ceil(z.t)}s</b>` }) : `<b>${t('Vùng an toàn đang thu hẹp')}</b>`) + (outside ? ` · <em>${t('BẠN Ở NGOÀI VÙNG')}</em>` : '');
      $('.ar-zone').classList.toggle('danger', outside);
      this.drawMap(m, cam);
    },
    drawMap(m, cam) {
      const g = mctx, S = 200, px = (v) => (v / SIZE + 0.5) * S;
      g.drawImage(base, 0, 0);
      const z = m.zone;
      g.fillStyle = 'rgba(30,60,140,.28)';
      g.beginPath(); g.rect(0, 0, S, S); g.arc(px(z.cx), px(z.cz), z.r / SIZE * S, 0, 7, true); g.fill();
      g.strokeStyle = 'rgba(80,160,255,.95)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(px(z.cx), px(z.cz), z.r / SIZE * S, 0, 7); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.9)'; g.setLineDash([4, 3]);
      g.beginPath(); g.arc(px(z.next.cx), px(z.next.cz), z.next.r / SIZE * S, 0, 7); g.stroke();
      g.setLineDash([]);
      const p = m.player;
      g.save(); g.translate(px(p.pos.x), px(p.pos.z)); g.rotate(-cam.yaw);
      g.fillStyle = '#ffd34d'; g.strokeStyle = '#000'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, -6); g.lineTo(4, 4); g.lineTo(0, 2); g.lineTo(-4, 4); g.closePath(); g.fill(); g.stroke();
      g.restore();
    },
  };
  return hud;
}
