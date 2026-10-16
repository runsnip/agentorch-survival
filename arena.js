// The arena: AgentOrch's downloadable first-person game.
//
// The office loads this module only once the pack is installed, and opens it
// from the CEO's desk. Everything lives in one full-screen layer with its own
// renderer: the lobby (outfits bought with the company's token coins, the bot
// count, an optional bot steered by one of the company's agents), then the
// match on the island.
//
// createArena({ call, agents, onExit }) → { open(), close(), onMessage(msg), active }

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Island, MAPS } from './island.js';
import { loadAvatar, makeBody, ArmRig } from './actors.js';
import { Viewmodel } from './viewmodel.js';
import { Match, forward, AGENT_LEVELS } from './match.js';
import { WEAPONS, AMMO, buildGun } from './weapons.js';
import { createHud } from './hud.js';
import { dress, SLOTS, SLOT_NAMES } from './accessories.js';
import { t, lang } from '/i18n.js';
import { audio } from '/audio.js';   // the app's music and shared sounds (host API 2)

const LOCALE = lang === 'vi' ? 'vi-VN' : lang;
const BASE = new URL('./', import.meta.url).href;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('arena.' + k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem('arena.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

export function createArena({ call, agents: agentSource = [], onExit }) {
  const agentsNow = () => (typeof agentSource === 'function' ? agentSource() : agentSource) || [];
  let manifest = null, skins = [], wallet = { coins: 0, owned: [], tokens: 0, rate: 1000 };
  let renderer, scene, camera, env, island, vm, hud, match, sound;
  let state = 'closed';             // closed → loading → lobby → match (→ paused / ended)
  let raf = 0, last = 0;
  const sel = { gear: store.get('gear', {}), starter: '', skin: store.get('skin', ''), bots: store.get('bots', 15), agentOn: store.get('agentOn', false), agent: store.get('agent', ''), level: store.get('level', 'talent'), map: store.get('map', MAPS[0].id) };

  // ---------------------------------------------------------------- DOM
  const root = document.createElement('div');
  root.className = 'arena hidden';
  root.innerHTML = `
    <canvas class="ar-canvas"></canvas>
    <div class="ar-loading"><div class="ar-spinner"></div><b>${t('Đang dựng hòn đảo…')}</b><small></small></div>
    <div class="ar-lobby">
      <header><div><h1>${t('PHÒNG CHỜ')}</h1><p>${t('Chọn trang phục và số BOT, rồi vào trận.')}</p></div>
        <div class="ar-wallet"><b class="ar-coins">0</b><span>${t('coin')}</span><small class="ar-earn"></small></div></header>
      <aside class="ar-skins"><h3>${t('TRANG PHỤC')}</h3><div class="ar-skin-grid"></div>
        <h3 class="ar-gear-h">${t('PHỤ KIỆN')}</h3><div class="ar-gear"></div></aside>
      <section class="ar-stage"><div class="ar-skin-name"></div><div class="ar-maps"></div></section>
      <aside class="ar-setup">
        <h3>${t('TRẬN ĐẤU')}</h3>
        <label class="ar-field">${t('Số BOT')} <b class="ar-bots-val"></b><input type="range" class="ar-bots" min="1" max="49"></label>
        <div class="ar-field ar-agent">
          <label class="ar-switch"><input type="checkbox" class="ar-agent-on"><span></span>${t('BOT do Agent điều khiển')}</label>
          <select class="ar-agent-pick"></select>
          <div class="ar-levels"></div>
          <small>${t('Agent vào trận như một đấu thủ độc lập: mọi nhân vật khác đều là đối thủ, không có đồng minh. Vài giây một lần agent nhận tình hình rút gọn và chỉ trả về một lệnh ngắn, nên tốn rất ít token (tính vào bảng token của agent đó).')}</small>
        </div>
        <div class="ar-field ar-starters"><b>${t('MANG VÀO TRẬN')}</b><div class="ar-starter-list"></div>
          <small>${t('Đồ trong Kho đồ của công ty, dùng một lần. Kiếm thêm bằng nhiệm vụ thành phố.')}</small></div>
        <div class="ar-keys"><b>${t('Phím')}</b>
          <span><kbd>W A S D</kbd> ${t('di chuyển')} · <kbd>Shift</kbd> ${t('chạy')} · <kbd>C</kbd> ${t('ngồi')} · <kbd>Space</kbd> ${t('nhảy')}</span>
          <span><kbd>${t('Chuột trái')}</kbd> ${t('bắn')} · <kbd>${t('Chuột phải')}</kbd> ${t('ngắm')} · <kbd>R</kbd> ${t('nạp đạn')} · <kbd>F</kbd> ${t('nhặt')}</span>
          <span><kbd>Tab</kbd> ${t('bảng nhặt đồ')} · <kbd>1 2 3</kbd> ${t('đổi súng')} · <kbd>4</kbd> ${t('băng gạc')} · <kbd>5</kbd> ${t('cứu thương')} · <kbd>Esc</kbd> ${t('tạm dừng')}</span></div>
        <div class="ar-stakes"><b>${t('LUẬT TRẬN')}</b><small>${t('Vào trận mất phí coin. Hết trận được trả lại theo cách chơi: hạng, hạ gục, giao tranh, di chuyển. Thắng được thưởng thêm. Có BOT do Agent điều khiển trong trận thì thưởng tính cao hơn. Nấp một chỗ đến cuối gần như không được gì. Bỏ trận giữa chừng là mất phí.')}</small></div>
        <button class="ar-play">${t('VÀO TRẬN')}</button>
        <button class="ar-leave">${t('VỀ VĂN PHÒNG')}</button>
      </aside>
    </div>
    <div class="ar-loot"><div class="ar-loot-col"><h3>${t('XUNG QUANH')}</h3><div class="ar-near"></div></div>
      <div class="ar-loot-col"><h3>${t('TRÊN NGƯỜI')}</h3><div class="ar-mine"></div></div>
      <div class="ar-loot-keys"><kbd>${t('Chuột trái')}</kbd> ${t('nhặt / dùng')} · <kbd>${t('Chuột phải')}</kbd> ${t('vứt xuống')} · <kbd>Tab</kbd> ${t('đóng')}</div></div>
    <div class="ar-pause"><div class="ar-panel"><h2>${t('TẠM DỪNG')}</h2>
      <button data-act="resume">${t('TIẾP TỤC')}</button><button data-act="lobby">${t('VỀ PHÒNG CHỜ')}</button><button data-act="office">${t('VỀ VĂN PHÒNG')}</button></div></div>
    <div class="ar-end"><div class="ar-panel"><h2 class="ar-end-title"></h2><p class="ar-end-sub"></p><div class="ar-pay"></div>
      <button data-act="again">${t('CHƠI LẠI')}</button><button data-act="lobby">${t('VỀ PHÒNG CHỜ')}</button><button data-act="office">${t('VỀ VĂN PHÒNG')}</button></div></div>`;
  document.body.append(root);
  if (!document.querySelector('link[data-arena]')) {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: BASE + 'arena.css' });
    css.dataset.arena = '1';
    document.head.append(css);
  }
  const $ = (s) => root.querySelector(s);
  const canvas = $('.ar-canvas');

  // ---------------------------------------------------------------- setup
  async function boot() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
    renderer.autoClear = false;
    env = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene = new THREE.Scene();
    scene.environment = env;
    scene.environmentIntensity = 0.25;   // reflections for metal and water; the sun and sky do the lighting
    camera = new THREE.PerspectiveCamera(70, 1, 0.08, 1200);
    loading(t('Đang tải danh mục trang phục…'));
    manifest = await (await fetch(BASE + 'manifest.json', { cache: 'no-store' })).json();
    skins = manifest.skins || [];
    if (!skins.some((s) => s.id === sel.skin)) sel.skin = skins.find((s) => !s.price)?.id || skins[0]?.id;
    const hemi = new THREE.HemisphereLight(0xbcd4ec, 0x4a4a32, 0.85);
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 400 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    scene.add(hemi, sun, sun.target);
    scene.userData.sun = sun;
    vm = new Viewmodel(env);
    sound = new Sound();
    resize();
    addEventListener('resize', resize);
  }
  // The island of the chosen map, built when a match starts (and kept for the next one on it).
  async function ensureIsland() {
    const map = MAPS.find((m) => m.id === sel.map) || MAPS[0];
    if (island?.map.id === map.id) return;
    if (island) { scene.remove(island.group); island.dispose(); }
    loading(t('Đang dựng {map}: địa hình, cây cối, làng mạc…', { map: t(map.name) }));
    island = new Island(1 + Math.floor(Math.random() * 9999), map);
    await island.build(renderer);
    scene.add(island.group);
    scene.fog = new THREE.Fog(island.fogColor, 70, 340);
    scene.background = island.fogColor;
  }
  function renderMaps() {
    $('.ar-maps').innerHTML = MAPS.map((m) => `<button class="ar-map-card${m.id === sel.map ? ' on' : ''}" data-map="${m.id}"
      style="--a:${m.art[0]};--b:${m.art[1]}"><b>${esc(t(m.name))}</b><small>${esc(t(m.desc))}</small></button>`).join('');
    root.querySelectorAll('[data-map]').forEach((b) => { b.onclick = () => { sel.map = b.dataset.map; store.set('map', sel.map); renderMaps(); }; });
  }
  function loading(text) { $('.ar-loading small').textContent = text; }
  function resize() {
    if (!renderer) return;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    preview?.resize();
  }

  // ---------------------------------------------------------------- lobby
  let preview = null;
  function renderSkins() {
    const owned = new Set(wallet.owned);
    $('.ar-skin-grid').innerHTML = skins.map((s) => {
      const has = owned.has(s.id) || !s.price;
      return `<button class="ar-skin${s.id === sel.skin ? ' on' : ''}${has ? '' : ' locked'}" data-id="${s.id}">
        <span class="ar-thumb" style="background-image:url('${BASE}skins/${encodeURIComponent(s.thumb)}')"></span>
        <b>${esc(t(s.name))}</b><small>${has ? (s.id === sel.skin ? t('Đang mặc') : t('Đã có')) : t('{n} coin', { n: s.price })}</small></button>`;
    }).join('');
    root.querySelectorAll('.ar-skin').forEach((b) => {
      b.onclick = () => {
        const s = skins.find((x) => x.id === b.dataset.id);
        if (!owned.has(s.id) && s.price) {
          if (b.classList.contains('confirm')) { call('arenaBuy', s.id); track('outfit_bought', { price: s.price }); b.classList.remove('confirm'); return; }
          root.querySelectorAll('.ar-skin.confirm').forEach((x) => x.classList.remove('confirm'));
          b.classList.add('confirm');
          b.querySelector('small').textContent = wallet.coins >= s.price ? t('Bấm lần nữa để mua ({n} coin)', { n: s.price }) : t('Thiếu {n} coin', { n: s.price - wallet.coins });
          showSkin(s);
          return;
        }
        sel.skin = s.id; store.set('skin', s.id); call('arenaSkin', s.id);
        renderSkins(); showSkin(s);
      };
    });
    $('.ar-coins').textContent = wallet.coins.toLocaleString(LOCALE);
    $('.ar-earn').textContent = t('{tokens} token · {rate} token = 1 coin', { tokens: wallet.tokens.toLocaleString(LOCALE), rate: wallet.rate.toLocaleString(LOCALE) });
  }
  // gear over the outfit, slot by slot (accessories.js); the preview wears it at once
  function renderGear() {
    $('.ar-gear').innerHTML = Object.entries(SLOTS).map(([slot, opts]) => `<div class="ar-gear-row"><small>${SLOT_NAMES[slot]}</small>
      <div>${opts.map(([id, name]) => `<button class="${(sel.gear[slot] || '') === id ? 'on' : ''}" data-gear="${slot}" data-gv="${id}">${name}</button>`).join('')}</div></div>`).join('');
    root.querySelectorAll('[data-gear]').forEach((b) => { b.onclick = () => {
      sel.gear = { ...sel.gear, [b.dataset.gear]: b.dataset.gv }; store.set('gear', sel.gear);
      renderGear(); if (preview?.body) dress(preview.body, sel.gear);
    }; });
  }
  async function showSkin(s) {
    $('.ar-skin-name').textContent = t(s.name);
    preview ||= new Preview($('.ar-stage'), env);
    preview.show(await loadAvatar(BASE + 'skins/' + s.file), sel.gear);
  }
  // starters from the company's inventory (they work in this game): pick one to bring into the next match
  function renderStarters() {
    const list = (wallet.inventory || []).filter((it) => it.kind === 'starter' && it.count > 0 && (it.games || []).some((g) => g === 'arena' || g === '*'));
    if (sel.starter && !list.some((it) => it.id === sel.starter)) sel.starter = '';
    $('.ar-starters').classList.toggle('off', !list.length);
    $('.ar-starter-list').innerHTML = list.length ? list.map((it) => `<button class="ar-starter r-${it.rarity}${sel.starter === it.id ? ' on' : ''}" data-starter="${it.id}">
      <b>${esc(t(it.name))}</b><small>${esc(t(it.desc))}</small><em>×${it.count}</em></button>`).join('')
      : `<small>${t('Kho đồ chưa có món nào dùng được trong game này.')}</small>`;
    root.querySelectorAll('[data-starter]').forEach((b) => { b.onclick = () => { sel.starter = sel.starter === b.dataset.starter ? '' : b.dataset.starter; renderStarters(); }; });
  }
  function renderSetup() {
    renderPlay();
    const agents = agentsNow();
    $('.ar-bots').value = sel.bots; $('.ar-bots-val').textContent = sel.bots;
    $('.ar-agent-on').checked = sel.agentOn;
    $('.ar-agent-pick').innerHTML = agents.map((a) => `<option value="${esc(a.slug)}"${a.slug === sel.agent ? ' selected' : ''}>${esc(a.name)}${a.title ? ' — ' + esc(a.title) : ''}</option>`).join('');
    $('.ar-agent-pick').disabled = !sel.agentOn || !agents.length;
    $('.ar-levels').innerHTML = Object.entries(AGENT_LEVELS).map(([id, lv]) =>
      `<button class="${id === sel.level ? 'on' : ''}" data-level="${id}"${sel.agentOn ? '' : ' disabled'}>${lv.name}</button>`).join('');
    root.querySelectorAll('[data-level]').forEach((b) => { b.onclick = () => { sel.level = b.dataset.level; store.set('level', sel.level); renderSetup(); }; });
    $('.ar-agent').classList.toggle('off', !agents.length);
  }
  $('.ar-bots').oninput = (e) => { sel.bots = +e.target.value; store.set('bots', sel.bots); $('.ar-bots-val').textContent = sel.bots; };
  $('.ar-agent-on').onchange = (e) => { sel.agentOn = e.target.checked; store.set('agentOn', sel.agentOn); renderSetup(); };
  $('.ar-agent-pick').onchange = (e) => { sel.agent = e.target.value; store.set('agent', sel.agent); };
  $('.ar-play').onclick = () => enterMatch();
  $('.ar-leave').onclick = () => arena.close();
  root.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => ({ resume: () => resume(), lobby: () => toLobby(), office: () => arena.close(), again: () => enterMatch() })[b.dataset.act]();
  });

  function toLobby() {
    endMatch();
    state = 'lobby';
    root.className = 'arena lobby';
    document.exitPointerLock?.();
    call('arenaWallet');
    renderSkins(); renderSetup(); renderMaps(); renderGear();
    audio.music('lobby');
    const s = skins.find((x) => x.id === sel.skin);
    if (s) showSkin(s);
  }

  // ---------------------------------------------------------------- match
  // anonymous usage (the app keeps only event names and properties it knows, see agentorch/telemetry.py)
  const track = (event, props) => call('track', event, JSON.stringify(props));
  let matchAt = 0, shotHeat = 0, stepT = 0;
  // ---- the stakes (agentorch/inventory.py): the app takes the fee before the match and pays back after it, by how
  // it was played. This side only asks and reports; an app too old to answer lets the match start without stakes.
  let matchId = null, entering = 0;
  const feeNow = () => (sel.agentOn && agentsNow().length ? wallet?.fee_agent ?? 300 : wallet?.fee ?? 200);   // the app's figures
  function renderPlay() {
    const b = $('.ar-play');
    if (b) b.innerHTML = `${t('VÀO TRẬN')} <small>· ${t('{n} coin', { n: feeNow() })}</small>`;
  }
  function enterMatch() {
    if (entering) return;
    $('.ar-play').disabled = true;
    entering = setTimeout(() => { entering = 0; $('.ar-play').disabled = false; matchId = null; startMatch(); }, 4000);
    call('arenaEnter', JSON.stringify({ bots: sel.bots, agent: !!(sel.agentOn && agentsNow().length) }));
  }
  function entered(msg) {
    if (!entering) return;
    clearTimeout(entering); entering = 0;
    $('.ar-play').disabled = false;
    if (!msg.ok) {
      if (state !== 'lobby') toLobby();
      $('.ar-earn').textContent = t('Thiếu coin: vào trận cần {fee}, công ty đang có {coins}. Làm nhiệm vụ thành phố hoặc giao việc cho Agent để có thêm.', { fee: msg.fee, coins: msg.coins });
      return;
    }
    matchId = msg.match;
    if (wallet) wallet.coins = msg.coins;
    startMatch();
  }
  function paid(msg) {
    const box = $('.ar-pay');
    if (!box) return;
    if (!msg.ok) { box.innerHTML = ''; return; }
    const pct = (x) => `${Math.round((x || 0) * 100)}%`;
    const bonus = msg.bonus || {}, parts = msg.parts || {};
    const rows = [[t('Hạng'), pct(parts.placement)], [t('Hạ gục'), pct(parts.kills)], [t('Giao tranh'), pct(parts.fight)], [t('Di chuyển'), pct(parts.move)]];
    box.innerHTML = msg.short ? `<p>${t('Trận quá ngắn: không được trả lại.')}</p>` : `
      <div class="ar-pay-parts">${rows.map(([k, v]) => `<span><small>${k}</small><b>${v}</b></span>`).join('')}</div>
      ${msg.gate < 1 ? `<p class="ar-pay-warn">${t('Ít giao tranh và di chuyển: phần trả lại bị giảm, không có thưởng thắng.')}</p>` : ''}
      <div class="ar-pay-sum"><span>${t('Phí vào trận')} <b>-${msg.fee}</b></span><span>${t('Trả lại')} <i>${[bonus.win && t('gồm thưởng thắng'), msg.rate > 1 && t('Agent ×{r}', { r: msg.rate }), bonus.agent_down && t('hạ Agent')].filter(Boolean).map((x) => `<em>${x}</em>`).join(' · ')} <b>+${msg.back}</b></i></span>
        <span class="${msg.net >= 0 ? 'up' : 'down'}">${msg.net >= 0 ? t('Lời') : t('Lỗ')} <b>${msg.net >= 0 ? '+' : ''}${msg.net} coin</b></span><span>${t('Kinh nghiệm')} <b>+${msg.xp} XP</b></span></div>
      ${msg.up ? `<p class="ar-pay-up">${t('LÊN CẤP {n}!', { n: msg.level.level })}</p>` : ''}`;
  }
  async function startMatch() {
    endMatch();
    root.className = 'arena loading';
    loading(t('Đang vào trận…'));
    await ensureIsland();
    loading(t('Đang vào trận…'));
    const skin = skins.find((s) => s.id === sel.skin) || skins[0];
    const loaded = await Promise.allSettled(skins.map((s) => loadAvatar(BASE + 'skins/' + s.file)));
    const assets = loaded.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const playerAsset = loaded[skins.indexOf(skin)]?.value || assets[0];
    vm.setBody(playerAsset, sel.gear);
    const agents = agentsNow();
    const agent = sel.agentOn && agents.length ? (agents.find((a) => a.slug === sel.agent) || agents[0]) : null;
    match = new Match({
      island, scene, playerAsset, playerGear: sel.gear, botAssets: assets, bots: sel.bots,
      agent: agent && { ...agent, level: sel.level, asset: assets[Math.abs([...agent.slug].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % assets.length] },
      events: {
        feed: (text, by, t) => hud.feed(esc(text), by?.isPlayer ? 'mine' : t?.isPlayer ? 'me' : ''),
        hitmark: (kill, head) => { hud.hitmark(kill, head); sound.play(kill ? 'kill' : 'hit'); },
        hurt: (angle) => { hud.hurt(angle, look.yaw); sound.play('hurt'); },
        message: (t) => hud.message(t),
        shot: (u, d) => { const dist = u.isPlayer ? 0 : u.pos.distanceTo(match.player.pos); sound.shot(d.cat, dist); if (dist < 60) shotHeat = Math.min(0.45, shotHeat + 0.06); },
        sound: (k) => sound.play(k),
        end: (r) => showEnd(r),
      },
    });
    agentBot = match.units.find((u) => u.agent) || null;
    agentWait = false; agentT = 3; agentSig = ''; agentQuiet = 0;
    if (agentBot) call('arenaAgentStart', agentBot.agent.slug, agentBot.name);
    hud?.el.remove();
    hud = createHud(root, island);
    look.yaw = match.player.yaw; look.pitch = 0;
    state = 'match';
    root.className = 'arena playing';
    hud.message(t('Vào trận! Nhặt vũ khí, ở trong vùng an toàn và sống sót.'), 4);
    canvas.requestPointerLock?.();
    // the starter chosen in the lobby: the app takes it out of the inventory and says what it does
    audio.music('battle'); audio.setTension(0.1);
    track('game_start', { map: sel.map, bots: sel.bots, agent_bot: !!agentBot, agent_level: agentBot ? sel.level : 'none', starter: sel.starter || 'none' });
    matchAt = performance.now();
    if (sel.starter) { call('arenaStarter', sel.starter); sel.starter = ''; }
  }
  function applyStarter(msg) {
    const p = match?.player, e = msg.effect;
    if (!p?.alive || !e) return;
    if (e.armor) p.armor = Math.max(p.armor, e.armor);
    for (const [k, n] of Object.entries(e.meds || {})) p.meds[k] = (p.meds[k] || 0) + n;
    if (e.weapon && WEAPONS[e.weapon]) p.give(e.weapon, 1);
    const it = (wallet.inventory || []).find((x) => x.id === msg.id);
    hud?.message(t('Mang theo: {item}', { item: it ? t(it.name) : msg.id }), 3);
    call('arenaWallet');   // the inventory count went down
  }
  function endMatch() {
    if (match && !match.over) matchId = null;   // left before the end: the fee stays spent
    if (lootOpen) toggleLoot(false);
    if (agentBot) call('arenaAgentStop');
    agentBot = null;
    match?.dispose();
    match = null;
    hud?.el.remove(); hud = null;
  }
  function showEnd(r) {
    $('.ar-pay').innerHTML = matchId ? `<p>${t('Đang tính phần trả lại…')}</p>` : '';
    if (matchId) { call('arenaResult', JSON.stringify({ match: matchId, stats: r.stats })); matchId = null; }
    audio.music(null); audio.sting(r.win ? 'victory' : 'defeat');
    track('game_end', { place: r.win ? 1 : r.rank, kills: match?.player.kills || 0, minutes: Math.round((performance.now() - matchAt) / 60000) });
    setTimeout(() => {
      if (!match) return;
      state = 'ended';
      document.exitPointerLock?.();
      root.className = 'arena playing ended';
      $('.ar-end-title').textContent = r.win ? t('CHIẾN THẮNG!') : t('HẠNG #{rank}', { rank: r.rank });
      $('.ar-end-sub').textContent = r.win ? t('Bạn là người cuối cùng trên đảo · {kills} hạ gục', { kills: r.kills })
        : t('{cause} · {kills} hạ gục · còn {alive}/{total} người', { cause: r.killer ? t('Bị {killer} hạ gục', { killer: r.killer }) : t('Gục ngoài vùng an toàn'), kills: r.kills, alive: match.alive, total: r.total });
    }, r.win ? 600 : 1800);
  }
  function pause() { if (state !== 'match') return; state = 'paused'; root.classList.add('paused'); }
  function resume() { if (state !== 'paused') return; state = 'match'; root.classList.remove('paused'); canvas.requestPointerLock?.(); }

  // ---------------------------------------------------------------- input
  const keys = new Set();
  const look = { yaw: 0, pitch: 0, dx: 0, dy: 0, adsK: 0, lookItem: null };
  let mouse = { l: false, r: false, lJust: false };
  const onKey = (e) => {
    if (state === 'closed') return;
    e.stopImmediatePropagation();       // the office underneath must not react
    if (e.target?.tagName === 'SELECT' || e.target?.tagName === 'INPUT') return;
    if (e.type === 'keyup') { keys.delete(e.code); return; }
    if (['Tab', 'Space', 'KeyF'].includes(e.code) || e.code.startsWith('Digit')) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (state === 'lobby' && e.code === 'Escape') { arena.close(); return; }
    if (state === 'paused' && e.code === 'Escape') { resume(); return; }
    if (state !== 'match' || !match) return;
    const p = match.player;
    if (!p.alive) return;
    if (e.code === 'Tab') { toggleLoot(); return; }
    if (e.code === 'Escape' && lootOpen) { toggleLoot(false); return; }
    if (e.code === 'KeyR') p.startReload();
    else if (e.code === 'KeyF') { if (look.lookItem) match.pickup(p, look.lookItem); }
    else if (e.code === 'KeyC' || e.code === 'ControlLeft') p.crouch = !p.crouch;
    else if (e.code === 'Space') { p.jump = true; p.crouch = false; }
    else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') p.switchTo(+e.code.slice(5) - 1);
    else if (e.code === 'Digit4') p.useMed('bandage');
    else if (e.code === 'Digit5') p.useMed('medkit');
  };
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  canvas.addEventListener('mousedown', (e) => {
    if (state !== 'match') return;
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); return; }
    if (e.button === 0) { mouse.l = true; mouse.lJust = true; }
    if (e.button === 2) mouse.r = true;
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    if (state !== 'match' || !match) return;
    const p = match.player, have = [0, 1, 2].filter((i) => p.slots[i]);
    if (have.length > 1) p.switchTo(have[(have.indexOf(p.cur) + Math.sign(e.deltaY) + have.length) % have.length]);
  }, { passive: true });
  addEventListener('mousemove', (e) => {
    if (state !== 'match' || document.pointerLockElement !== canvas) return;
    const zoom = match?.player.ads ? (match.player.def?.scope || 1.25) : 1;
    look.yaw -= e.movementX * 0.0022 / zoom;
    look.pitch = THREE.MathUtils.clamp(look.pitch - e.movementY * 0.0022 / zoom, -1.45, 1.45);
    look.dx += e.movementX; look.dy += e.movementY;
  });
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== canvas && state === 'match' && match?.player.alive && !lootOpen) pause(); });

  // ---------------------------------------------------------------- loot panel (Tab)
  //
  // Left: what lies within reach, a dead player's box opened item by item.
  // Right: what you carry. Click takes or uses, right-click drops.
  let lootOpen = false, lootT = 0, lootRows = [];
  function toggleLoot(on = !lootOpen) {
    lootOpen = on;
    root.classList.toggle('looting', on);
    if (on) { document.exitPointerLock?.(); renderLoot(); }
    else canvas.requestPointerLock?.();
  }
  function renderLoot() {
    const p = match.player, near = match.items.filter((it) => match.canReach(p, it)).sort((a, b) => a.pos.distanceTo(p.pos) - b.pos.distanceTo(p.pos));
    lootRows = [];
    const row = (label, act, cls = '') => { lootRows.push(act); return `<button class="ar-row ${cls}" data-row="${lootRows.length - 1}">${label}</button>`; };
    let html = '';
    for (const it of near) {
      if (it.kind === 'box') {
        html += `<div class="ar-box">${t('Hòm đồ của {owner}', { owner: esc(it.owner) })}</div>`;
        for (const e of match.boxEntries(it)) html += row(esc(e.label), { take: () => match.takeFromBox(p, it, e) }, 'in-box');
      } else html += row(esc(match.itemLabel(it)), { take: () => match.pickup(p, it) });
    }
    $('.ar-near').innerHTML = html || `<div class="ar-empty">${t('Không có gì trong tầm tay')}</div>`;
    const slots = [0, 1, 2].map((i) => {
      const w = p.slots[i];
      return w ? row(`<kbd>${i + 1}</kbd><b>${esc(WEAPONS[w.id].name)}</b><small>${w.mag} / ${p.ammo[WEAPONS[w.id].ammo]}</small>`, { take: () => p.switchTo(i), drop: () => match.drop(p, { slot: i }) }, p.cur === i ? 'on' : '')
        : `<div class="ar-row empty"><kbd>${i + 1}</kbd>${t('{slot} — trống', { slot: i === 2 ? t('Súng lục') : t('Súng chính') })}</div>`;
    }).join('');
    const ammo = Object.entries(p.ammo).filter(([, n]) => n > 0).map(([k, n]) => row(`${t('Đạn {ammo}', { ammo: AMMO[k] })}<small>×${n}</small>`, { drop: () => match.drop(p, { ammo: k }) })).join('');
    const meds = Object.entries(p.meds).filter(([, n]) => n > 0).map(([k, n]) => row(`${k === 'medkit' ? t('Bộ cứu thương') : t('Băng gạc')}<small>×${n}</small>`, { take: () => p.useMed(k), drop: () => match.drop(p, { med: k }) })).join('');
    $('.ar-mine').innerHTML = slots + `<div class="ar-row static">${t('Áo giáp')}<small>${Math.round(p.armor)}</small></div>` + ammo + meds;
  }
  root.querySelector('.ar-loot').addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-row]');
    if (!b || !match) return;
    const act = lootRows[+b.dataset.row];
    (e.button === 2 ? act.drop : act.take)?.();
    renderLoot();
  });
  root.querySelector('.ar-loot').addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------- the agent's bot
  // The agent is asked only when its situation has changed (or after a quiet
  // spell): every question costs the company tokens.
  let agentBot = null, agentWait = false, agentT = 0, agentSig = '', agentQuiet = 0;
  function agentTick(dt) {
    if (!agentBot || !agentBot.alive || agentWait) return;
    agentT -= dt; agentQuiet += dt;
    if (agentT > 0) return;
    agentT = 1;   // look again in a second
    const view = match.agentView(agentBot);
    const sig = [Math.floor(view.hp / 25), view.ar > 0, view.w.map((w) => w.split(' ')[0]).join(), view.m.join(), view.in, view.t > 0,
      view.nz.join(), view.e.map((e) => e[0]).join(), view.i.map((i) => i[0]).join(), agentBot.ai.goal ? 1 : 0].join('|');
    if (sig === agentSig && agentQuiet < 15) return;
    agentSig = sig; agentQuiet = 0; agentWait = true;
    call('arenaAgentTick', JSON.stringify(view));
  }
  function agentOrder(msg) {
    agentWait = false; agentT = 2;
    if (!agentBot || !match) return;
    const o = msg.order || {};
    if (o.type === 'attack' && o.target) {
      const t = match.units.find((u) => u.alive && u !== agentBot && u.name.toLowerCase() === String(o.target).toLowerCase());
      if (t && match.time >= 15) agentBot.ai.target = t;   // the same opening grace as everyone
    }
    if (o.type === 'heal') { if (!agentBot.useMed('medkit')) agentBot.useMed('bandage'); }
    if (['move', 'hold', 'loot', 'zone'].includes(o.type)) { agentBot.ai.order = o; agentBot.ai.think = 0; }
  }

  // ---------------------------------------------------------------- frame
  const tmp = new THREE.Vector3();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
    if (state === 'lobby') { preview?.render(renderer, dt); return; }
    if (!match || state === 'loading') return;
    const p = match.player;
    if (state === 'match') {
      // controls → the player's unit
      p.yaw = look.yaw; p.pitch = look.pitch;
      const f = forward(look.yaw), r = new THREE.Vector3(-f.z, 0, f.x);
      const wish = new THREE.Vector3();
      if (keys.has('KeyW')) wish.add(f.clone().setY(0)); if (keys.has('KeyS')) wish.sub(f.clone().setY(0));
      if (keys.has('KeyD')) wish.add(r); if (keys.has('KeyA')) wish.sub(r);
      if (wish.lengthSq()) wish.normalize();
      p.wish = wish;
      p.sprint = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && keys.has('KeyW') && !mouse.r && !p.action;
      if (p.sprint) p.crouch = false;
      p.ads = mouse.r && !lootOpen && !!p.weapon && !p.sprint && p.reloadT <= 0;
      if (p.alive && !lootOpen && (mouse.l && (p.def?.auto || mouse.lJust)) && !p.sprint) match.fire(p);
      if (lootOpen && (lootT -= dt) <= 0) { lootT = 0.2; renderLoot(); }
      mouse.lJust = false;
      match.update(dt);
      agentTick(dt);
    } else if (state === 'ended') match.update(dt);
    // camera at the eyes
    const eye = p.eye();
    p.eyeY = (p.eyeY ?? eye.y) + (eye.y - (p.eyeY ?? eye.y)) * Math.min(1, dt * 12);   // smooth crouch / steps
    camera.position.set(eye.x, p.eyeY, eye.z);
    camera.lookAt(tmp.copy(camera.position).add(forward(look.yaw, look.pitch)));
    look.adsK += ((p.ads ? 1 : 0) - look.adsK) * Math.min(1, dt * 12);
    const zoom = 1 + ((p.def?.scope || 1.25) - 1) * look.adsK;
    const fov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(72) / 2) / zoom) * 180 / Math.PI;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    // the sun's shadow box follows the player, snapped to its texels so shadows don't shimmer
    const sun = scene.userData.sun;
    const snap = 110 / 2048;
    const cx = Math.round(eye.x / snap) * snap, cz = Math.round(eye.z / snap) * snap;
    sun.position.set(cx + island.sunDir.x * 200, island.sunDir.y * 200, cz + island.sunDir.z * 200);
    sun.target.position.set(cx, 0, cz);
    island.update(dt, camera.position);
    // music: the battle theme grows with the danger — the zone closing in, few left, shots nearby
    if (state === 'match') {
      const z = match.zone, alive = match.alive / Math.max(1, match.units.length);
      shotHeat = Math.max(0, shotHeat - dt * 0.12);
      const outside = Math.hypot(p.pos.x - z.cx, p.pos.z - z.cz) > z.r;
      audio.setTension(Math.min(1, 0.1 + Math.max(0, z.phase) * 0.12 + (1 - alive) * 0.35 + shotHeat + (outside ? 0.25 : 0) + (z.state === 'shrink' ? 0.1 : 0)));
      // footsteps on the island
      if (p.alive && p.onGround && p.moveSpeed > 0.6) {
        stepT -= dt;
        if (stepT <= 0) { stepT = p.moveSpeed > 4.5 ? 0.3 : 0.48; audio.sfx('step', { run: p.moveSpeed > 4.5, surface: match.island.houseAt(p.pos) >= 0 ? 'floor' : 'grass' }); }
      } else stepT = 0.05;
    }
    // what's under the crosshair to pick up
    look.lookItem = p.alive ? match.nearestItem(p, 2.4, forward(look.yaw, look.pitch)) : null;
    // a low sill right ahead: Space climbs it
    look.vault = p.alive && !p.vault && !look.lookItem && p.onGround ? !!match.island.vaultAt(p.pos, forward(look.yaw, 0).setY(0).normalize()) : false;
    // arms and weapon
    vm.update(dt, {
      weapon: p.alive ? p.weapon?.id || null : null, ads: p.ads, sprint: p.sprint && p.moveSpeed > 4, moving: Math.min(1, p.moveSpeed / 6),
      reload: p.reloadT > 0 ? 1 - p.reloadT / p.reloadTotal : -1, reloadEmpty: p.reloadEmpty, shotAt: p.shotAt,
      lookDX: look.dx, lookDY: look.dy, busy: !!p.action,
      sunView: island.sunDir.clone().transformDirection(camera.matrixWorldInverse),
    });
    look.dx *= 0.5; look.dy *= 0.5;
    hud?.update(dt, match, look);
    renderer.clear();
    renderer.render(scene, camera);
    const scoped = p.ads && p.def?.scope && look.adsK > 0.85;
    vm.render(renderer, camera.aspect, !p.alive || scoped);
  }

  // ---------------------------------------------------------------- API
  const arena = {
    get active() { return state !== 'closed'; },
    debug: () => ({ match, look, keys, mouse, state, vm, start: startMatch }),
    async open() {
      if (state !== 'closed') return;
      state = 'loading';
      root.className = 'arena loading';
      last = performance.now();
      raf = requestAnimationFrame(frame);
      try {
        if (!renderer) await boot();
        toLobby();
      } catch (e) {
        console.error(e);
        loading(t('Không mở được game: {error}', { error: e.message }));
      }
    },
    close() {
      endMatch();
      audio.music(null);   // the office takes its own music back
      state = 'closed';
      root.className = 'arena hidden';
      cancelAnimationFrame(raf);
      document.exitPointerLock?.();
      keys.clear();
      onExit?.();
    },
    onMessage(msg) {
      if (msg.type === 'arena_wallet') {
        wallet = msg;
        if (msg.skin && skins.some((s) => s.id === msg.skin) && !store.get('skin', '')) sel.skin = msg.skin;
        // the finish equipped in the inventory, on every gun in the player's hands
        vm?.setFinish((msg.inventory || []).find((it) => it.id === msg.equipped?.finish && it.count > 0) || null);
        if (state === 'lobby') { renderSkins(); renderStarters(); renderGear(); renderPlay(); if (msg.error) $('.ar-earn').textContent = msg.error; }
      } else if (msg.type === 'arena_enter') entered(msg);
      else if (msg.type === 'arena_result') paid(msg);
      else if (msg.type === 'arena_agent') agentOrder(msg);
      else if (msg.type === 'arena_starter') applyStarter(msg);
    },
  };
  return arena;
}

// ---------------------------------------------------------------- lobby preview
//
// The chosen outfit on a turntable, rifle in hand.
class Preview {
  // Drawn full-screen by the arena's own renderer behind the lobby panels.
  constructor(host, env) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.scene.environment = env;
    this.scene.background = new THREE.Color(0x0d131c);
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 60);
    const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(2, 4, 3);
    const rim = new THREE.DirectionalLight(0x8fb8ff, 2.2); rim.position.set(-3, 2.5, -3);
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.9), key, rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.2, 64), new THREE.MeshStandardMaterial({ color: 0x182130, roughness: 0.35, metalness: 0.3 }));
    floor.rotation.x = -Math.PI / 2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.18, 1.24, 64), new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.6 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002;
    this.scene.add(floor, ring);
    this.spin = 0.5;
    let drag = null;
    host.addEventListener('pointerdown', (e) => { drag = e.clientX; });
    addEventListener('pointermove', (e) => { if (drag != null) { this.spin += (e.clientX - drag) * 0.01; drag = e.clientX; } });
    addEventListener('pointerup', () => { drag = null; });
    this.resize();
  }
  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 1.15, 6.2);
    this.camera.lookAt(0, 0.92, 0);
  }
  show(asset, gear = {}) {
    if (this.body) this.scene.remove(this.body.group);
    const body = dress(makeBody(asset), gear);
    this.body = body;
    this.scene.add(body.group);
    this.mixer = new THREE.AnimationMixer(body.model);
    if (asset.clips.idle) this.mixer.clipAction(asset.clips.idle).play();
    const gun = buildGun('vantor');
    body.group.add(gun.group);
    this.gun = gun;
    this.arms = { R: new ArmRig(body.group, body.bones, 'R'), L: new ArmRig(body.group, body.bones, 'L') };
  }
  render(renderer, dt) {
    if (!this.body) return;
    this.spin += dt * 0.35;
    this.body.group.rotation.y = this.spin;
    this.mixer.update(dt);
    // rifle held low and ready
    const g = this.gun.group, B = this.body.group;
    g.position.set(0.12, 1.12, 0.3); g.rotation.set(0.5, Math.PI + 0.5, 0.1);
    g.updateMatrixWorld(true);
    const q = g.quaternion, dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize().applyQuaternion(q);
    const at = (v) => B.worldToLocal(g.localToWorld(v.clone()));
    this.arms.R.reset(); this.arms.L.reset();
    const FR = dir(0, -0.3, -0.95), PR = dir(-1, 0, 0);
    this.arms.R.solve(at(new THREE.Vector3(0, -0.025, 0.02)).addScaledVector(PR, -0.028).addScaledVector(FR, -0.08), FR, PR, new THREE.Vector3(-1, -0.6, -0.3), 1.1);
    const FL = dir(0.5, -0.05, -0.86), PL = dir(0.05, 1, 0);
    this.arms.L.solve(at(this.gun.support.clone().setY(this.gun.support.y + 0.028)).addScaledVector(PL, -0.028).addScaledVector(FL, -0.075), FL, PL, new THREE.Vector3(1, -1, -0.2), 1.15);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------- sound
//
// Synthesised: a gunshot is a burst of filtered noise with a low thump.
class Sound {
  constructor() {
    try { this.ctx = new AudioContext(); } catch { this.ctx = null; }
    if (!this.ctx) return;
    const n = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.master = this.ctx.createGain(); this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
  }
  // browsers only start audio after a click or key press; until then stay silent
  ready() { const c = this.ctx; if (!c) return false; this.master.gain.value = audio.muted ? 0 : 0.55 * audio.volumes.sfx * audio.volumes.master; if (c.state !== 'running') { if (navigator.userActivation?.hasBeenActive) c.resume(); return false; } return true; }
  shot(cat, dist) {
    const c = this.ctx; if (!this.ready()) return;
    const vol = Math.max(0, 1 - dist / 260) ** 1.6;
    if (vol < 0.01) return;
    const t = c.currentTime, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise;
    const heavy = cat === 'sr' || cat === 'sg', light = cat === 'pistol' || cat === 'smg';
    f.type = 'lowpass'; f.frequency.setValueAtTime(dist > 40 ? 1200 : light ? 4200 : 3000, t);
    f.frequency.exponentialRampToValueAtTime(300, t + (heavy ? 0.35 : 0.18));
    g.gain.setValueAtTime(vol * (heavy ? 1 : 0.8), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.5 : 0.25));
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, 0.6);
    // the thump
    const o = c.createOscillator(), og = c.createGain();
    o.frequency.setValueAtTime(heavy ? 110 : 150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    og.gain.setValueAtTime(vol * 0.6, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.2);
  }
  play(kind) {
    const c = this.ctx; if (!this.ready()) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    const spec = { hit: [1800, 0.05, 0.12], kill: [900, 0.18, 0.2], hurt: [140, 0.2, 0.3], pickup: [660, 0.08, 0.12], vault: [220, 0.12, 0.18] }[kind] || [440, 0.05, 0.1];
    o.type = kind === 'hurt' ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(spec[0], t);
    if (kind === 'kill') o.frequency.exponentialRampToValueAtTime(1800, t + 0.15);
    g.gain.setValueAtTime(spec[2], t); g.gain.exponentialRampToValueAtTime(0.001, t + spec[1]);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + spec[1] + 0.02);
  }
}
