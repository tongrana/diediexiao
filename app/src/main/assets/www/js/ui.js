/* ============================================================================
 * 叠叠消 · ui.js
 * 界面渲染 / 输入 / 动画 / 屏幕路由。所有玩法逻辑都来自 shared/core.js。
 * ==========================================================================*/
(function () {
  'use strict';

  const Levels = window.TQLevels;
  const Core = window.TQCore;
  const P = window.TQPlatform;
  const A = window.TQAudio;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  const app = $('#app');
  const LEVEL_COUNT = Levels.mainLevelCount();

  const DEFAULT_PROGRESS = { unlocked: 1, levels: {} };
  const DEFAULT_SETTINGS = { sfx: true, music: true, haptics: true, motion: true, fontScale: 1, volume: 1.15, debug: false };
  const DEFAULT_STATS = { plays: 0, wins: 0, totalClearMs: 0, bestCombo: 0 };
  const DEFAULT_WALLET = {
    coins: 0,
    items: { undo: 0, shuffle: 0, hint: 0, addTime: 0 },
    // 调试模式下用「调试金币」买的道具，关闭调试即清空
    debugItems: { undo: 0, shuffle: 0, hint: 0, addTime: 0 }
  };

  const S = {
    screen: 'home',
    progress: Object.assign({}, DEFAULT_PROGRESS, P.get('progress', {})),
    settings: Object.assign({}, DEFAULT_SETTINGS, P.get('settings', {})),
    stats: Object.assign({}, DEFAULT_STATS, P.get('stats', {})),
    wallet: Object.assign({}, DEFAULT_WALLET, P.get('wallet', {})),
    custom: P.get('custom', []),
    game: null,
    meta: null,
    tileEls: null,
    raf: 0,
    lastT: 0,
    hudCache: {},
    lastTickSec: -1,
    result: null,
    instant: false,       // 自检/截图模式下关掉入场与过场动画
    boardBox: null,
    settingsFrom: null    // 从暂停面板进来的设置，返回时要回到游戏
  };

  // wallet.items 可能缺字段（老存档），补齐
  S.wallet.items = Object.assign({ undo: 0, shuffle: 0, hint: 0, addTime: 0 }, S.wallet.items || {});
  S.wallet.debugItems = Object.assign({ undo: 0, shuffle: 0, hint: 0, addTime: 0 }, S.wallet.debugItems || {});

  function persistWallet() {
    P.set('wallet', S.wallet);
  }

  /** 本局可用的库存 = 真实库存 (+ 调试库存) */
  function stockForGame() {
    const base = S.wallet.items || {};
    const extra = S.settings.debug ? (S.wallet.debugItems || {}) : {};
    return {
      undo: (base.undo || 0) + (extra.undo || 0),
      shuffle: (base.shuffle || 0) + (extra.shuffle || 0),
      hint: (base.hint || 0) + (extra.hint || 0),
      addTime: (base.addTime || 0) + (extra.addTime || 0)
    };
  }

  /** 金币文案：调试模式下追加「+∞」 */
  function coinsHtml() {
    const base = String(S.wallet.coins || 0);
    return S.settings.debug ? base + '<span class="coin-inf">+∞</span>' : base;
  }

  /* ═══════════════════════════ 基础工具 ═══════════════════════════ */
  function persist() {
    P.set('progress', S.progress);
    P.set('settings', S.settings);
    P.set('stats', S.stats);
  }
  function persistCustom() {
    P.set('custom', S.custom);
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1900);
  }

  function haptic(ms) {
    if (S.settings.haptics) P.vibrate(ms || 8);
  }

  function openOverlay(id) {
    const el = $('#' + id);
    el.classList.remove('closing');
    el.hidden = false;
  }
  function closeOverlay(id) {
    const el = $('#' + id);
    if (!el || el.hidden) return;
    if (S.instant || !S.settings.motion) { el.hidden = true; return; }
    if (el.classList.contains('closing')) return;
    el.classList.add('closing');
    setTimeout(function () {
      el.hidden = true;
      el.classList.remove('closing');
    }, 240);
  }
  function closeAllOverlays() {
    $$('.overlay').forEach(function (el) {
      el.classList.remove('closing');
      el.hidden = true;
    });
  }

  /* ═══════════════════════════ 字号尺度 ═══════════════════════════ */
  let lastFs = 0;
  function applyFontScale() {
    // 宽度按 8px 分桶：滚动条出现/消失、地址栏收起这类 1~7px 的抖动不该改变字号
    const raw = app.clientWidth || window.innerWidth;
    const w = Math.round(raw / 8) * 8;
    let fs = w < 360 ? 16 : w < 430 ? 17 : w < 620 ? 19 : 20;
    fs = Math.round(fs * (S.settings.fontScale || 1) * 10) / 10;
    if (fs === lastFs) return;
    lastFs = fs;
    document.documentElement.style.setProperty('--fs', fs + 'px');
  }

  /* ═══════════════════════════ 屏幕路由 ═══════════════════════════ */
  const SCREENS = ['home', 'levels', 'game', 'editor', 'stats', 'settings', 'shop'];

  function showScreen(name) {
    S.screen = name;
    SCREENS.forEach(function (n) {
      const el = $('#screen-' + n);
      if (el) el.hidden = (n !== name);
    });
    // 首页入场动画：重新触发一次
    const home = $('#screen-home');
    home.classList.remove('enter');
    if (name === 'home' && !S.instant && S.settings.motion) {
      void home.offsetWidth;
      home.classList.add('enter');
      // 保险：万一动画被系统/浏览器掐掉，1.5s 后强制结束入场状态
      setTimeout(function () { home.classList.remove('enter'); }, 1500);
    }
    if (name === 'game') fitSoon();
    if (name === 'home') renderHome();
    if (name === 'levels') renderLevels();
    if (name === 'stats') renderStats();
    if (name === 'settings') renderSettings();
    if (name === 'shop') renderShop();
    if (name === 'editor' && window.TQEditor) window.TQEditor.render();
  }

  /* ── 界面过场：镜头推近式交叉淡入（缩放缓动，纯 transform/opacity，不掉帧） ── */
  let switching = false;
  function goScreen(name) {
    if (name === S.screen) return;
    if (S.instant || !S.settings.motion || switching) {
      showScreen(name);
      return;
    }
    switching = true;
    const scrim = $('#scrim');
    scrim.classList.add('on');
    setTimeout(function () {
      showScreen(name);
      scrim.classList.remove('on');
      setTimeout(function () { switching = false; }, 130);
    }, 120);
  }

  /* ═══════════════════════════ 首页 ═══════════════════════════ */
  function nextLevel() {
    return Math.min(Math.max(1, S.progress.unlocked || 1), LEVEL_COUNT);
  }

  function renderHome() {
    $('#continue-note').textContent = '第 ' + nextLevel() + ' 关';
    const foot = $('#home-foot');
    foot.textContent = P.storageAvailable ? '进度自动保存在本机' : '当前环境无法保存进度（关闭后丢失）';
    $('#coin-amount').innerHTML = coinsHtml();
  }

  /* ═══════════════════════════ 商城 ═══════════════════════════ */
  function renderShop() {
    $('#shop-coins').innerHTML = coinsHtml();
    const list = $('#shop-list');
    if (!list) return;
    list.innerHTML = '';
    const debug = !!S.settings.debug;
    Levels.SHOP_ITEMS.forEach(function (item) {
      const owned = (S.wallet.items[item.id] || 0) + (debug ? (S.wallet.debugItems[item.id] || 0) : 0);
      const can = debug || (S.wallet.coins || 0) >= item.price;
      const row = document.createElement('div');
      row.className = 'shop-item';
      row.innerHTML =
        '<div class="shop-icon">' + item.icon + '</div>' +
        '<div class="shop-main">' +
        '<div class="shop-name">' + item.name +
        '<span class="shop-owned">已拥有 ' + owned + '</span></div>' +
        '<div class="shop-desc">' + item.desc + '</div>' +
        '</div>' +
        '<button class="btn btn-sm shop-buy"></button>';
      const btn = row.querySelector('.shop-buy');
      btn.innerHTML = debug ? '<span class="coin-icon">🪙</span>免费' : '<span class="coin-icon">🪙</span>' + item.price;
      btn.disabled = !can;
      btn.addEventListener('click', function () { buyItem(item); });
      list.appendChild(row);
    });
  }

  function buyItem(item) {
    const debug = !!S.settings.debug;
    if (!debug && (S.wallet.coins || 0) < item.price) {
      toast('金币不够，先去通关赚点');
      A.deny();
      return;
    }
    if (debug) {
      // 调试金币无限：不扣真钱，记到 debugItems（关闭调试后清空）
      S.wallet.debugItems[item.id] = (S.wallet.debugItems[item.id] || 0) + 1;
    } else {
      S.wallet.coins -= item.price;
      S.wallet.items[item.id] = (S.wallet.items[item.id] || 0) + 1;
    }
    persistWallet();
    A.prop();
    haptic(12);
    renderShop();
    toast('已购买「' + item.name + '」×1' + (debug ? '（调试）' : ''));
  }

  /* ═══════════════════════════ 选关 ═══════════════════════════ */
  function bestOf(rec) {
    let stars = 0, time = null, tier = null;
    Levels.TIER_IDS.forEach(function (id) {
      const r = rec[id];
      if (!r) return;
      if ((r.stars || 0) > stars) { stars = r.stars; tier = id; }
      if (r.best != null && (time == null || r.best < time)) time = r.best;
    });
    return { stars: stars, time: time, tier: tier };
  }

  function starsText(n) {
    if (!n) return '☆☆☆';
    return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n);
  }

  function renderLevels() {
    const grid = $('#level-grid');
    grid.innerHTML = '';
    const unlocked = S.settings.debug ? LEVEL_COUNT : (S.progress.unlocked || 1);
    $('#levels-progress').textContent = S.settings.debug
      ? '调试模式 · 全部解锁'
      : unlocked + ' / ' + LEVEL_COUNT;
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const lv = i + 1;
      const rec = S.progress.levels[String(lv)] || {};
      const best = bestOf(rec);
      const locked = lv > unlocked;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'level-cell' + (locked ? ' locked' : '') + (best.stars ? ' cleared' : '');
      cell.innerHTML =
        '<span class="lv-num">' + lv + '</span>' +
        '<span class="lv-stars">' + (locked ? '🔒' : starsText(best.stars)) + '</span>' +
        (best.time != null ? '<span class="lv-best">' + Levels.formatTime(best.time) + '</span>' : '');
      if (!locked) {
        cell.addEventListener('click', function () { openTier(lv); });
      }
      grid.appendChild(cell);
    }
  }

  /* ═══════════════════════════ 难度选择 ═══════════════════════════ */
  let pendingLevel = 1;
  function openTier(level) {
    pendingLevel = level;
    $('#tier-title').textContent = '第 ' + level + ' 关';
    const list = $('#tier-list');
    list.innerHTML = '';
    const rec = S.progress.levels[String(level)] || {};
    Levels.getTierList().forEach(function (t) {
      const cfg = Levels.mainLevelConfig(level - 1, t.id);
      const r = rec[t.id] || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tier-btn' + (t.id === 'normal' ? ' recommended' : '');
      btn.innerHTML =
        '<span>' +
        '<span class="tier-name">' + t.label + '</span>' +
        '<span class="tier-desc">' + t.desc + ' · ' + cfg.tiles + ' 张 · ' + Levels.formatTime(cfg.baseTime) + '</span>' +
        '</span>' +
        '<span class="tier-right"><span class="tier-best">' +
        (r.stars ? '★★★'.slice(0, r.stars) : '未通关') +
        '</span></span>';
      btn.addEventListener('click', function () {
        closeOverlay('ov-tier');
        startMain(level, t.id);
      });
      list.appendChild(btn);
    });
    openOverlay('ov-tier');
  }

  /* ═══════════════════════════ 开局 ═══════════════════════════ */
  function startMain(level, tier) {
    const cfg = Levels.mainLevelConfig(level - 1, tier);
    if (!cfg) { toast('关卡不存在'); return; }
    startGame(cfg, { mode: 'main', level: level, tier: tier });
  }

  function syncStock() {
    if (S.settings.debug) return;     // 调试库存不落账，关掉就消失
    if (S.game && S.game.props) {
      S.wallet.items = Object.assign({}, S.game.props.stock);
      persistWallet();
    }
  }

  function startGame(config, meta) {
    const seed = ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    syncStock();            // 上一局用掉的库存先落账
    let game;
    try {
      game = Core.createGame(config, seed, null, { stock: stockForGame() });
    } catch (e) {
      toast('生成牌局失败：' + e.message);
      return;
    }
    S.game = game;
    S.meta = meta || { mode: 'main', level: 1, tier: 'normal' };
    S.hudCache = {};
    S.lastTickSec = -1;
    S.result = null;
    S.boardBox = null;
    S.dropIn = true;          // 本次建牌要播「从上方掉落」的入场动画
    closeAllOverlays();
    showScreen('game');
    rebuildBoard();
    buildTray();
    updateHUD(true);
    fitSoon();
    startLoop();
  }

  /* ═══════════════════════════ 牌堆渲染 ═══════════════════════════ */
  /** 按实际牌的位置裁出最小外框：小关牌的排布空间更小，就能放大显示 */
  function computeBoardBox(g) {
    const tw = Core.GRID.tw;
    const th = Core.GRID.th;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    g.board.tiles.forEach(function (t) {
      if (t.x < minX) minX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.x > maxX) maxX = t.x;
      if (t.y > maxY) maxY = t.y;
    });
    const pad = 6;
    return {
      ox: minX - pad,
      oy: minY - pad,
      w: (maxX - minX) + tw + pad * 2,
      h: (maxY - minY) + th + pad * 2
    };
  }

  function rebuildBoard() {
    const g = S.game;
    const bd = $('#board');
    if (!S.boardBox) S.boardBox = computeBoardBox(g);
    const box = S.boardBox;
    bd.innerHTML = '';
    bd.style.setProperty('--bw', String(box.w));
    bd.style.setProperty('--bh', String(box.h));
    S.tileEls = {};

    const maxLayer = Math.max(1, g.board.layers - 1);
    const drop = !!S.dropIn && !S.instant && S.settings.motion;
    S.dropIn = false;
    let order = 0;
    g.board.tiles.forEach(function (t) {
      if (!g.isPresent(t.id)) return;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tile';
      el.style.left = (t.x - box.ox) + 'px';
      el.style.top = (t.y - box.oy) + 'px';
      el.style.zIndex = String(t.layer * 1000 + t.id);
      el.style.setProperty('--d', String(Math.round((t.layer / maxLayer) * 100) / 100));
      el.dataset.id = String(t.id);
      el.dataset.type = t.type;
      el.innerHTML = '<span class="glyph">' + t.type + '</span>';
      // 触摸设备用 pointerdown 立即响应，鼠标仍用 click
      el.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType === 'mouse') return;   // 鼠标交给 click
        if (ev.cancelable) ev.preventDefault();
        onTileClick(ev);
        el.dataset.tapped = '1';
        setTimeout(function () { delete el.dataset.tapped; }, 60);
      });
      el.addEventListener('click', function (ev) {
        if (el.dataset.tapped) return;            // pointerdown 已经处理过
        onTileClick(ev);
      });
      if (drop) {
        // 从上方落入：按 (列+行) 排序做波浪式错峰，慢一点、一张张落
        const delay = Math.min(760, (t.col + t.row * 1.5) * 34);
        el.classList.add('drop');
        el.style.animationDelay = delay + 'ms';
        order++;
      }
      bd.appendChild(el);
      S.tileEls[t.id] = el;
    });
    if (drop) {
      setTimeout(function () {
        Object.keys(S.tileEls).forEach(function (k) {
          if (S.tileEls[k]) S.tileEls[k].classList.remove('drop');
        });
      }, 1600);
    }
    updateBoard();
    fitBoard();
  }

  function updateBoard() {
    const g = S.game;
    if (!g || !S.tileEls) return;
    g.board.tiles.forEach(function (t) {
      const el = S.tileEls[t.id];
      if (!el) return;
      const present = g.isPresent(t.id);
      const covered = g.isCovered(t.id);
      el.classList.toggle('dim', covered);
      el.classList.toggle('free', present && !covered);
      if (present && el.dataset.type !== t.type) {
        el.dataset.type = t.type;
        const g = el.firstChild;
        if (g) g.textContent = t.type;
      }
    });
  }

  let lastFitW = 0;
  let lastFitH = 0;

  function fitBoard(force) {
    const g = S.game;
    if (!g) return;
    const wrap = $('#board-wrap');
    const bd = $('#board');
    if (!wrap || !bd) return;
    const bw = (S.boardBox || g.board.bounds).w;
    const bh = (S.boardBox || g.board.bounds).h;
    const availW = wrap.clientWidth - 6;
    const availH = wrap.clientHeight - 4;
    if (availW <= 0 || availH <= 0) return;
    // 边界固定：同一局内只在「进关」或窗口真的变了(>24px)时才重算缩放，
    // 消掉牌之后周围空白变大也不会让棋盘忽大忽小。
    if (!force && lastFitW && Math.abs(availW - lastFitW) < 24 && Math.abs(availH - lastFitH) < 24) return;
    lastFitW = availW;
    lastFitH = availH;
    let s = Math.min(availW / bw, availH / bh);
    s = Math.max(0.28, Math.min(s, 1.2));
    bd.style.setProperty('--s', String(Math.round(s * 1000) / 1000));
  }

  /** 布局稳定后多量几次，避免首帧拿到旧尺寸 */
  function fitSoon() {
    lastFitW = 0;
    lastFitH = 0;
    fitBoard(true);
    sizeTray();
    requestAnimationFrame(function () { fitBoard(true); sizeTray(); });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { fitBoard(true); sizeTray(); });
    });
    setTimeout(function () { fitBoard(true); sizeTray(); }, 140);
  }

  /* ═══════════════════════════ 卡槽 ═══════════════════════════ */
  function buildTray() {
    const g = S.game;
    const tray = $('#tray');
    tray.innerHTML = '';
    for (let i = 0; i < g.cfg.slot; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      tray.appendChild(slot);
    }
    renderTray();
  }

  function sizeTray() {
    const g = S.game;
    if (!g) return;
    const wrap = $('.tray-wrap');
    const tray = $('#tray');
    if (!wrap || !tray) return;
    const n = g.cfg.slot;
    const avail = wrap.clientWidth - 12;
    const gap = 6;
    let size = Math.max(24, Math.min((avail - gap * (n + 1)) / n, 56));
    size = Math.round(size * 2) / 2;
    tray.style.setProperty('--slot-size', size + 'px');
  }

  function renderTray() {
    const g = S.game;
    if (!g) return;
    renderTrayList(g.tray);
  }

  /** 按指定 tile id 数组渲染卡槽（三消动画需要先画出「消除前」的样子）
   *  带 FLIP：同一个 tileId 从左边的格子换到别的格子时，图案从原位置滑过去。 */
  function renderTrayList(ids) {
    const g = S.game;
    if (!g) return;
    const slots = $$('#tray .slot');

    // 1) 记录重排前每张牌所在的 x
    const oldX = {};
    slots.forEach(function (slot) {
      const tid = slot.dataset.tileId;
      if (tid != null) oldX[tid] = slot.getBoundingClientRect().left;
    });

    // 2) 重排内容（同时把所有临时状态清干净，避免格子“消失”）
    for (let i = 0; i < slots.length; i++) {
      const id = ids[i];
      const slot = slots[i];
      slot.classList.remove('clearing');
      if (id == null) {
        if (slot.className !== 'slot') slot.className = 'slot';
        delete slot.dataset.type;
        delete slot.dataset.tileId;
        if (slot.textContent !== '') slot.textContent = '';
        continue;
      }
      const type = g.tiles[id].type;
      slot.dataset.tileId = String(id);
      if (slot.dataset.type !== type) {
        slot.dataset.type = type;
        if (slot.className !== 'slot filled') slot.className = 'slot filled';
        slot.innerHTML = '<span class="face">' + type + '</span>';
      } else if (!slot.classList.contains('filled')) {
        slot.className = 'slot filled';
      }
    }

    // 3) FLIP：换格子的牌从左往右滑到位
    if (S.instant || !S.settings.motion) return;
    slots.forEach(function (slot) {
      const tid = slot.dataset.tileId;
      if (tid == null || oldX[tid] == null) return;
      const dx = oldX[tid] - slot.getBoundingClientRect().left;
      if (Math.abs(dx) < 2) return;
      const face = slot.firstChild;
      if (!face || !face.animate) return;
      try {
        face.animate([
          { transform: 'translateX(' + dx + 'px)' },
          { transform: 'translateX(0)' }
        ], { duration: 420, easing: 'cubic-bezier(0.34, 1.45, 0.5, 1)' });
      } catch (e) { /* ignore */ }
    });
  }

  /* ═══════════════════════════ 点击与事件 ═══════════════════════════ */
  function onTileClick(e) {
    const g = S.game;
    if (!g || g.status !== 'playing') return;
    const id = Number(e.currentTarget.dataset.id);
    const r = g.click(id);
    if (!r.ok) {
      if (r.reason === 'covered') { A.deny(); }
      return;
    }
    A.unlock();
    updateBoard();

    const events = r.events || [];
    const placedEv = events[0];
    const clearedEv = events.filter(function (ev) { return ev.type === 'cleared'; })[0];
    const flew = applyEvents(events, e.currentTarget);

    const showSlot = function () {
      if (clearedEv && placedEv && placedEv.tray) {
        // 先画出「三张都在槽里」的样子，再让它们汇合
        renderTrayList(placedEv.tray);
        setTimeout(function () {
          const fxMs = playClearFx(g.tiles[clearedEv.tiles[0]].type) || 300;
            setTimeout(function () { renderTray(); }, fxMs);
        }, 60);
      } else {
        renderTray();
      }
    };
    if (flew) setTimeout(showSlot, 236); else showSlot();
    updateHUD(true);
    if (g.status === 'won' || g.status === 'lost') finishGame();
  }

  function floatText(text, opts) {
    const o = opts || {};
    const layer = $('#floats');
    const el = document.createElement('div');
    el.className = 'float-text' + (o.combo ? ' combo' : '');
    el.textContent = text;
    const anchor = o.anchor || $('#tray');
    let x = window.innerWidth / 2, y = window.innerHeight * 0.7;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top - 8;
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (o.dy) el.style.marginTop = o.dy + 'px';
    layer.appendChild(el);
    setTimeout(function () { el.remove(); }, 1000);
  }

  /** 三消：三张牌向中间汇合、放大、闪一下再消失
   *  注意：动画跑在「临时幻影」上，真实槽位只是暂时隐藏——
   *  否则 fill: forwards 会把格子永久钉在 opacity 0，之后放进去的牌就看不见了。 */
  function makeGhost(type, r) {
    const g = document.createElement('div');
    g.className = 'slot-ghost';
    g.textContent = type;
    g.style.left = r.left + 'px';
    g.style.top = r.top + 'px';
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    g.style.fontSize = Math.round(r.height * 0.5) + 'px';
    g.style.borderRadius = Math.round(r.width * 0.2) + 'px';
    document.body.appendChild(g);
    return g;
  }

  /** 三消：后两张并进第一张那一格 → 合并后的那一格化成光点 */
  function playClearFx(type) {
    if (S.instant || !S.settings.motion) return;
    const slots = $$('#tray .slot').filter(function (s) { return s.dataset.type === type; }).slice(0, 3);
    if (slots.length < 3) return;

    const rects = slots.map(function (s) { return s.getBoundingClientRect(); });
    const base = rects[0];
    const cx = base.left + base.width / 2;
    const cy = base.top + base.height / 2;

    // 1) 第二、三张滑向第一张的位置，叠在一起
    [1, 2].forEach(function (i) {
      const r = rects[i];
      const g = makeGhost(type, r);
      const dx = cx - (r.left + r.width / 2);
      const dy = cy - (r.top + r.height / 2);
      slots[i].classList.add('clearing');
      try {
        const anim = g.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.94)', opacity: 0.35 }
        ], { duration: 190, delay: i * 26, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
        anim.onfinish = function () { if (g.parentNode) g.remove(); };
      } catch (e) { g.remove(); }
    });

    // 2) 等三张完全叠成一格、停稳之后再「化光」
    const merged = makeGhost(type, base);
    slots[0].classList.add('clearing');
    const TURN_AT = 280;      // 合拢结束(190+26*2≈242) 后再留一小段
    const TURN_DUR = 320;
    setTimeout(function () {
      merged.classList.add('turning');
      try {
        const anim = merged.animate([
          { transform: 'scale(1)', opacity: 1, filter: 'brightness(1.15)' },
          { transform: 'scale(1.16)', opacity: 1, filter: 'brightness(2.5) saturate(0.25)', offset: 0.45 },
          { transform: 'scale(0.07)', opacity: 0, filter: 'brightness(3) saturate(0)' }
        ], { duration: TURN_DUR, easing: 'cubic-bezier(0.3, 0, 0.4, 1)', fill: 'forwards' });
        anim.onfinish = function () { if (merged.parentNode) merged.remove(); };
      } catch (e) { merged.remove(); }
    }, TURN_AT);

    const total = TURN_AT + TURN_DUR + 40;
    setTimeout(function () {
      slots.forEach(function (s) { s.classList.remove('clearing'); });
      $$('.slot-ghost').forEach(function (g) { g.remove(); });
    }, total + 40);
    return total;
  }

  /** 牌落进卡槽的回弹：从它「飞来的方向」弹一下再定住（和补位动画同一套手感） */
  function bounceFace(slotEl, tileId, dx, dy) {
    if (S.instant || !S.settings.motion || !slotEl) return;
    if (slotEl.dataset.tileId !== String(tileId)) return;   // 格子已经换了别的牌就别乱弹
    const face = slotEl.firstChild;
    if (!face || !face.animate) return;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    try {
      face.animate([
        { transform: 'translate(' + (-nx * 4) + 'px,' + (-ny * 4) + 'px) scale(1.08)' },
        { transform: 'translate(' + (nx * 1) + 'px,' + (ny * 1) + 'px) scale(0.985)', offset: 0.62 },
        { transform: 'translate(0, 0) scale(1)' }
      ], { duration: 290, easing: 'cubic-bezier(0.34, 1.5, 0.5, 1)' });
    } catch (e) { /* ignore */ }
  }

  /** 牌从牌堆位置「飞」进卡槽：用 WAAPI 跑合成层动画，不影响布局 */
  function flyToSlot(tileEl, slotEl, tileId) {
    if (S.instant || !S.settings.motion || !tileEl || !slotEl) return false;
    const a = tileEl.getBoundingClientRect();
    const b = slotEl.getBoundingClientRect();
    if (!a.width || !b.width) return false;
    const ghost = document.createElement('div');
    ghost.className = 'fly-tile';
    ghost.textContent = tileEl.textContent;
    ghost.style.left = a.left + 'px';
    ghost.style.top = a.top + 'px';
    ghost.style.width = a.width + 'px';
    ghost.style.height = a.height + 'px';
    // 牌面在图板里被整体缩放过，字号/圆角按实际视觉尺寸换算，起手才不会「跳一下」
    ghost.style.fontSize = (a.width * 0.565) + 'px';
    ghost.style.borderRadius = Math.max(6, Math.round(a.width * 0.22)) + 'px';
    document.body.appendChild(ghost);

    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const scale = Math.max(0.34, b.width / a.width);
    const midScale = (1 + scale) / 2;

    // 等幻影牌消失之后（236ms），格子里的牌再从「飞来的方向」弹进来
    setTimeout(function () { bounceFace(slotEl, tileId, dx, dy); }, 236);

    try {
      const anim = ghost.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: 'translate(' + (dx * 0.5) + 'px,' + (dy * 0.5 - 22) + 'px) scale(' + midScale + ')', opacity: 1, offset: 0.5 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')', opacity: 0.85 }
      ], { duration: 230, easing: 'cubic-bezier(0.32, 0.72, 0.3, 1)' });
      anim.onfinish = function () { ghost.remove(); };
      anim.oncancel = function () { ghost.remove(); };
    } catch (e) {
      ghost.remove();
      return false;
    }
    return true;
  }

  function applyEvents(events, tileEl) {
    const g = S.game;
    let flewAny = false;
    (events || []).forEach(function (ev) {
      switch (ev.type) {
        case 'placed': {
          const slots = $$('#tray .slot');
          const slotIndex = (ev.slot != null) ? ev.slot : (ev.tray ? ev.tray.length - 1 : -1);
          const slot = slots[slotIndex];
          const flew = !!(tileEl && slot && !S.instant && S.settings.motion && flyToSlot(tileEl, slot, ev.tile));
          if (flew) flewAny = true;
          if (tileEl) {
            if (flew) {
              // 幻影牌已经飞走了，原地这张立刻消失，避免「停一下再缩掉」
              tileEl.style.transition = 'none';
              tileEl.style.opacity = '0';
            } else {
              tileEl.classList.add('taken');
            }
            setTimeout(function () { tileEl.remove(); }, flew ? 60 : 240);
          }
          A.click();
          haptic(8);
          break;
        }
        case 'cleared':
          A.clear(ev.combo);
          floatText('+' + ev.bonus + 's', { dy: -8 });
          if (ev.combo > 1) {
            A.combo(ev.combo);
            floatText('连击 ×' + ev.combo, { combo: true, dy: -46 });
            haptic([10, 30, 10]);
          } else {
            haptic(12);
          }
          break;
        case 'overflow':
          A.lose();
          haptic([20, 60, 20]);
          floatText('卡槽满了', { combo: true });
          break;
        case 'timeout':
          A.lose();
          haptic([20, 60, 20]);
          break;
        case 'win':
          A.win();
          break;
        default:
          break;
      }
    });
    return flewAny;
  }

  /* ═══════════════════════════ HUD ═══════════════════════════ */
  let lastHudAt = 0;
  function updateHUD(force) {
    const g = S.game;
    if (!g) return;
    const now = performance.now();
    if (!force && now - lastHudAt < 90) return;
    lastHudAt = now;
    const sec = Math.ceil(g.timeLeft);
    if (force || S.hudCache.time !== sec) {
      $('#hud-time').textContent = Levels.formatTime(sec);
      S.hudCache.time = sec;
      if (sec <= 10 && sec > 0 && sec !== S.lastTickSec && g.status === 'playing') {
        S.lastTickSec = sec;
        A.tick();
      }
    }
    const ratio = g.baseTime > 0 ? g.timeLeft / g.baseTime : 0;
    const pct = Math.max(0, Math.min(1, ratio)) * 100;
    $('#timebar-fill').style.width = pct + '%';
    const low = ratio < 0.2;
    $('#timebar').classList.toggle('low', low);
    $('#hud-time').classList.toggle('low', low);

    const rest = g.remainingCount();
    $('#hud-progress').textContent = '剩余 ' + Math.ceil(rest / 3) + ' 组 · ' + rest + ' 张';

    const combo = $('#hud-combo');
    if (g.comboActive()) {
      combo.hidden = false;
      combo.textContent = '连击 ×' + g.combo;
    } else {
      combo.hidden = true;
    }

    ['undo', 'shuffle', 'hint', 'addTime'].forEach(function (k) {
      const f = g.props.free[k];
      const s = g.props.stock[k];
      const total = f + s;
      const cnt = $('#cnt-' + k);
      if (cnt) {
        // 「2+1」= 本关免费 2 次 + 商城里买的 1 次
        if (s > 0) cnt.innerHTML = f + '<span class="p-plus">+' + s + '</span>';
        else cnt.textContent = String(f);
        cnt.classList.toggle('zero', total <= 0);
        cnt.classList.toggle('has-stock', s > 0);
      }
      const btn = $('.prop[data-prop="' + k + '"]');
      if (btn) btn.classList.toggle('disabled', total <= 0);
    });

    const title = $('#hud-level');
    const chip = $('#hud-tier');
    if (S.meta && S.meta.mode === 'custom') {
      title.textContent = g.cfg.name || '自定义';
      chip.textContent = '自定义';
    } else if (S.meta) {
      title.textContent = '第 ' + S.meta.level + ' 关';
      chip.textContent = Levels.getTier(S.meta.tier).label;
    }
  }

  /* ═══════════════════════════ 计时循环 ═══════════════════════════ */
  function startLoop() {
    stopLoop();
    S.lastT = performance.now();
    function step(now) {
      const g = S.game;
      if (!g) return;
      const dt = Math.min(0.3, Math.max(0, (now - S.lastT) / 1000));
      S.lastT = now;
      if (g.status === 'playing') {
        const ev = g.tick(dt);
        if (ev) {
          applyEvents([ev], null);
          updateHUD(true);
          finishGame();
          return;
        }
        updateHUD();
      }
      S.raf = requestAnimationFrame(step);
    }
    S.raf = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
  }

  /* ═══════════════════════════ 道具 ═══════════════════════════ */
  const PROP_FAIL = {
    'no-props': '道具次数用完了',
    'status': '现在不能用',
    'empty': '没有可以撤销的操作',
    'too-few': '剩下的牌太少了',
    'unsolvable': '这次洗牌无效，未消耗次数'
  };

  function useProp(name) {
    const g = S.game;
    if (!g || g.status !== 'playing') return;
    let r;
    if (name === 'undo') r = g.undo();
    else if (name === 'shuffle') r = g.shuffle();
    else if (name === 'hint') r = g.hint();
    else r = g.addTime();

    if (!r.ok) {
      A.deny();
      toast(PROP_FAIL[r.reason] || '暂时不可用');
      return;
    }

    A.prop();
    haptic(10);

    if (name === 'undo') {
      rebuildBoard();
      renderTray();
      floatText('已撤销');
    } else if (name === 'shuffle') {
      rebuildBoard();
      renderTray();
      floatText('重新洗牌');
    } else if (name === 'hint') {
      (r.tiles || []).forEach(function (id) {
        const el = S.tileEls[id];
        if (!el) return;
        el.classList.add('hint');
        setTimeout(function () { el.classList.remove('hint'); }, 2100);
      });
    } else {
      floatText('+' + r.amount + 's');
    }
    updateHUD(true);
    updateBoard();
  }

  /* ═══════════════════════════ 暂停 ═══════════════════════════ */
  function pauseGame() {
    const g = S.game;
    if (!g) return;
    if (g.pause()) {
      openOverlay('ov-pause');
      haptic(6);
    }
  }

  function resumeGame() {
    const g = S.game;
    if (!g) return;
    g.resume();
    closeOverlay('ov-pause');
    S.lastT = performance.now();
  }

  /* ═══════════════════════════ 结算 ═══════════════════════════ */
  function finishGame() {
    stopLoop();
    const g = S.game;
    if (!g) return;
    const won = g.status === 'won';
    // 真实用时：core 里的 elapsed 只在「正在玩」时累加（不含暂停、不含奖励时间）
    const elapsed = Math.max(0, g.realElapsed ? g.realElapsed() : g.elapsed);
    const stars = won ? g.stars() : 0;

    S.stats.plays = (S.stats.plays || 0) + 1;
    if (won) {
      S.stats.wins = (S.stats.wins || 0) + 1;
      S.stats.totalClearMs = (S.stats.totalClearMs || 0) + Math.round(elapsed * 1000);
    }
    S.stats.bestCombo = Math.max(S.stats.bestCombo || 0, g.maxCombo || 0);

    let isNewBest = false;
    if (won && S.meta && S.meta.mode === 'main') {
      const key = String(S.meta.level);
      const rec = S.progress.levels[key] || {};
      const cur = rec[S.meta.tier] || { stars: 0, best: null };
      if (stars > (cur.stars || 0)) { cur.stars = stars; isNewBest = true; }
      if (cur.best == null || elapsed < cur.best) { cur.best = Math.round(elapsed); isNewBest = true; }
      rec[S.meta.tier] = cur;
      S.progress.levels[key] = rec;
      if (S.meta.level + 1 > (S.progress.unlocked || 1)) {
        S.progress.unlocked = Math.min(S.meta.level + 1, LEVEL_COUNT);
      }
    }
    persist();

    // 金币与库存：库存是「买来的、可跨关携带」的道具，用剩多少写回钱包
    let coins = 0;
    if (won) {
      coins = Levels.coinReward(
        { tier: S.meta.tier, tiles: g.cfg.tiles, level: S.meta.level },
        stars
      );
      S.wallet.coins = (S.wallet.coins || 0) + coins;
    }
    if (!S.settings.debug) {
      S.wallet.items = Object.assign({}, g.props.stock);
      persistWallet();
    }

    S.result = {
      won: won, stars: stars, elapsed: elapsed, isNewBest: isNewBest,
      reason: g.loseReason, coins: coins
    };
    setTimeout(function () { showResult(); }, won ? 380 : 260);
  }

  function showResult() {
    const g = S.game;
    const r = S.result;
    if (!g || !r) return;
    const custom = S.meta && S.meta.mode === 'custom';

    $('#result-icon').textContent = r.won ? (r.stars === 3 ? '🎉' : '😃') : '😵';
    $('#result-title').textContent = r.won ? '通关！' : (r.reason === 'timeout' ? '时间到' : '卡槽满了');
    $('#result-sub').textContent = custom
      ? (g.cfg.name || '自定义关卡')
      : '第 ' + S.meta.level + ' 关 · ' + Levels.getTier(S.meta.tier).label;

    const starsEl = $('#result-stars');
    starsEl.innerHTML = '';
    if (r.won) {
      for (let i = 0; i < 3; i++) {
        const i2 = document.createElement('i');
        if (i < r.stars) i2.className = 'on';
        i2.textContent = '★';
        starsEl.appendChild(i2);
      }
      starsEl.hidden = false;
    } else {
      starsEl.hidden = true;
    }


    $('#result-stats').innerHTML =
      '<span>用时<b>' + Levels.formatTime(r.elapsed) + '</b></span>' +
      '<span>剩余<b>' + Levels.formatTime(g.timeLeft) + '</b></span>' +
      '<span>消除<b>' + g.stats.clears + ' 组</b></span>';

    const shareEl = $('#result-badge');
    if (r.won && r.isNewBest) {
      shareEl.hidden = false;
      shareEl.textContent = '🎊 新纪录';
    } else {
      shareEl.hidden = true;
    }

    const coinEl = $('#result-coins');
    if (r.won && r.coins > 0) {
      coinEl.hidden = false;
      coinEl.innerHTML = '<span class="coin-icon">🪙</span> +' + r.coins +
        '<span class="coin-total">（共 ' + S.wallet.coins + '）</span>';
    } else if (r.won && S.meta && S.meta.mode === 'custom') {
      coinEl.hidden = false;
      coinEl.textContent = '自定义关卡不产出金币';
    } else {
      coinEl.hidden = true;
    }

    const primary = $('#btn-result-primary');
    const secondary = $('#btn-result-secondary');
    const canNext = r.won && !custom && S.meta.level < LEVEL_COUNT;
    // 失败时给一个明确的「重新开始」入口
    primary.textContent = canNext ? '下一关' : '重新开始';
    primary.dataset.action = canNext ? 'next' : 'again';
    secondary.textContent = '再来一次';
    secondary.hidden = !canNext;

    openOverlay('ov-result');
  }

  function restartCurrent() {
    closeAllOverlays();
    const cfg = S.game ? S.game.cfg : null;
    if (!cfg) return;
    if (S.meta && S.meta.mode === 'custom') startGame(cfg, S.meta);
    else startMain(S.meta.level, S.meta.tier);
  }

  function nextLevelStart() {
    const lv = Math.min(S.meta.level + 1, LEVEL_COUNT);
    closeAllOverlays();
    startMain(lv, S.meta.tier || 'normal');
  }

  /* ═══════════════════════════ 统计页 ═══════════════════════════ */
  function renderStats() {
    const st = S.stats;
    const rate = st.plays ? Math.round((st.wins || 0) / st.plays * 100) : 0;
    const avg = st.wins && st.totalClearMs ? st.totalClearMs / st.wins / 1000 : 0;
    const grid = $('#stat-grid');
    grid.innerHTML =
      '<div class="stat"><b>' + (st.plays || 0) + '</b><span>总场次</span></div>' +
      '<div class="stat"><b>' + rate + '%</b><span>通关率</span></div>' +
      '<div class="stat"><b>' + Levels.formatTime(avg) + '</b><span>平均用时</span></div>' +
      '<div class="stat"><b>×' + (st.bestCombo || 0) + '</b><span>最高连击</span></div>';

    const list = $('#stat-levels');
    list.innerHTML = '';
    let any = false;
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const rec = S.progress.levels[String(i + 1)] || {};
      const best = bestOf(rec);
      if (!best.stars) continue;
      any = true;
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = '<span>第 ' + (i + 1) + ' 关</span><span class="lv-stars">' +
        starsText(best.stars) + '</span><b>' + (best.time != null ? Levels.formatTime(best.time) : '—') + '</b>';
      list.appendChild(row);
    }
    if (!any) list.innerHTML = '<p class="empty-text">还没有通关记录，去玩一局吧</p>';
  }

  /* ═══════════════════════════ 设置页 ═══════════════════════════ */
  function renderSettings() {
    const s3 = Math.round(Levels.STARS.three * 100);
    const s2 = Math.round(Levels.STARS.two * 100);
    if ($('#rule-three')) $('#rule-three').textContent = s3 + '%';
    if ($('#rule-two')) $('#rule-two').textContent = s2 + '%';
    $('#set-sfx').checked = !!S.settings.sfx;
    $('#set-music').checked = !!S.settings.music;
    $('#set-haptics').checked = !!S.settings.haptics;
    $('#set-motion').checked = !!S.settings.motion;
    $('#set-debug').checked = !!S.settings.debug;
    $('#set-fontscale').value = String(S.settings.fontScale || 1);
    if ($('#set-volume')) {
      const vol = S.settings.volume == null ? 1.15 : S.settings.volume;
      $('#set-volume').value = String(Math.round(vol * 100));
      if ($('#set-volume-val')) $('#set-volume-val').textContent = Math.round(vol * 100) + '%';
    }
    $('#debug-note').hidden = !S.settings.debug;
  }

  /* ═══════════════════════════ 设置 ═══════════════════════════ */
  function applySettings() {
    A.setEnabled(!!S.settings.sfx);
    if (A.setMusicEnabled) A.setMusicEnabled(!!S.settings.music);
    if (A.setVolume) A.setVolume(S.settings.volume == null ? 1.15 : S.settings.volume);
    if ($('#set-volume')) {
      $('#set-volume').value = String(Math.round((S.settings.volume == null ? 1.15 : S.settings.volume) * 100));
      if ($('#set-volume-val')) $('#set-volume-val').textContent = Math.round((S.settings.volume == null ? 1.15 : S.settings.volume) * 100) + '%';
    }
    app.classList.toggle('reduced-motion', !S.settings.motion);
    $('#set-sfx').checked = !!S.settings.sfx;
    $('#set-music').checked = !!S.settings.music;
    $('#set-haptics').checked = !!S.settings.haptics;
    $('#set-motion').checked = !!S.settings.motion;
    $('#set-fontscale').value = String(S.settings.fontScale || 1);
    applyFontScale();
  }

  /* ═══════════════════════════ 事件绑定 ═══════════════════════════ */
  function bind() {
    $('#btn-continue').addEventListener('click', function () {
      startMain(nextLevel(), 'normal');
    });
    $('#btn-levels').addEventListener('click', function () { goScreen('levels'); });
    $('#btn-custom').addEventListener('click', function () { goScreen('editor'); });
    $('#btn-stats').addEventListener('click', function () { goScreen('stats'); });
    $('#btn-settings').addEventListener('click', function () { goScreen('settings'); });

    $('#btn-levels-back').addEventListener('click', function () { goScreen('home'); });
    $('#btn-editor-back').addEventListener('click', function () { goScreen('home'); });
    $('#btn-stats-back').addEventListener('click', function () { goScreen('home'); });
    $('#btn-settings-back').addEventListener('click', function () {
      if (S.settingsFrom === 'game') {
        S.settingsFrom = null;
        showScreen('game');
        openOverlay('ov-pause');
        S.lastT = performance.now();
      } else {
        goScreen('home');
      }
    });
    $('#btn-tier-close').addEventListener('click', function () { closeOverlay('ov-tier'); });

    $('#btn-pause').addEventListener('click', pauseGame);
    $('#btn-resume').addEventListener('click', resumeGame);
    $('#btn-pause-settings').addEventListener('click', function () {
      closeOverlay('ov-pause');
      S.settingsFrom = 'game';
      goScreen('settings');
    });
    $('#btn-restart').addEventListener('click', restartCurrent);
    $('#btn-quit').addEventListener('click', function () {
      closeAllOverlays();
      stopLoop();
      syncStock();
      S.game = null;
      goScreen('levels');
    });
    $('#btn-home').addEventListener('click', function () {
      closeAllOverlays();
      stopLoop();
      syncStock();
      S.game = null;
      goScreen('home');
    });

    $('#btn-result-primary').addEventListener('click', function (e) {
      const action = e.currentTarget.dataset.action;
      if (action === 'next') nextLevelStart();
      else restartCurrent();
    });
    $('#btn-result-secondary').addEventListener('click', restartCurrent);
    $('#btn-result-quit').addEventListener('click', function () {
      closeAllOverlays();
      syncStock();
      S.game = null;
      goScreen('home');
    });

    $('#btn-shop').addEventListener('click', function () { goScreen('shop'); });
    $('#btn-shop-back').addEventListener('click', function () { goScreen('home'); });
    $('#btn-go-levels').addEventListener('click', function () { goScreen('levels'); });

    $$('.prop').forEach(function (btn) {
      btn.addEventListener('click', function () { useProp(btn.dataset.prop); });
    });

    if ($('#set-volume')) $('#set-volume').addEventListener('input', function (e) {
      const v = Number(e.target.value) / 100;
      S.settings.volume = v;
      if (A.setVolume) A.setVolume(v);
      if ($('#set-volume-val')) $('#set-volume-val').textContent = Math.round(v * 100) + '%';
      P.set('settings', S.settings);
    });

    $('#set-sfx').addEventListener('change', function (e) {
      S.settings.sfx = e.target.checked;
      applySettings();
      persist();
    });
    $('#set-haptics').addEventListener('change', function (e) {
      S.settings.haptics = e.target.checked;
      persist();
    });
    $('#set-music').addEventListener('change', function (e) {
      S.settings.music = e.target.checked;
      applySettings();
      persist();
    });
    $('#set-motion').addEventListener('change', function (e) {
      S.settings.motion = e.target.checked;
      applySettings();
      persist();
    });
    $('#set-fontscale').addEventListener('change', function (e) {
      S.settings.fontScale = Number(e.target.value) || 1;
      applySettings();
      persist();
      requestAnimationFrame(function () { fitBoard(); sizeTray(); });
    });
    $('#set-debug').addEventListener('change', function (e) {
      S.settings.debug = e.target.checked;
      if (!S.settings.debug) {
        // 关闭调试：用调试金币买的道具全部作废
        S.wallet.debugItems = { undo: 0, shuffle: 0, hint: 0, addTime: 0 };
        persistWallet();
      }
      $('#debug-note').hidden = !S.settings.debug;
      persist();
      $('#coin-amount').innerHTML = coinsHtml();
      if (S.screen === 'shop') renderShop();
      toast(S.settings.debug ? '调试模式已开启：全部关卡解锁 + 金币无限' : '调试模式已关闭：调试道具已清除');
    });

    function resetAll() {
      if (!window.confirm('确定清除所有进度、自定义关卡和统计吗？')) return;
      S.progress = { unlocked: 1, levels: {} };
      S.stats = { plays: 0, wins: 0, totalClearMs: 0, bestCombo: 0 };
      S.custom = [];
      persist();
      persistCustom();
      renderStats();
      toast('已清除');
    }
    $('#btn-reset-data').addEventListener('click', resetAll);
    $('#btn-reset-data2').addEventListener('click', resetAll);

    window.addEventListener('resize', function () {
      applyFontScale();
      fitBoard();
      sizeTray();
    });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { fitBoard(); sizeTray(); }).observe($('#board-wrap') || document.body);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && S.game && S.game.status === 'playing') pauseGame();
    });

    document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });

    document.addEventListener('keydown', function (e) {
      if (!S.game || S.screen !== 'game') return;
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        if (S.game.status === 'playing') pauseGame();
        else if (S.game.status === 'paused') resumeGame();
      }
      if (e.key === '1') useProp('undo');
      if (e.key === '2') useProp('shuffle');
      if (e.key === '3') useProp('hint');
      if (e.key === '4') useProp('addTime');
    });

    // 首次手势解锁音频
    document.addEventListener('pointerdown', function once() {
      A.unlock();
      document.removeEventListener('pointerdown', once);
    }, { once: true });
  }

  /* ═══════════════════════════ 启动 ═══════════════════════════ */
  function boot() {
    // 先读 URL 参数（file:// 下 Edge 不认查询串，所以用 hash）：截图/自检要关掉动画，
    // 否则元素停在入场动画的第 0 帧，量出来是透明的。
    applySettings();
    bind();


    renderHome();
    showScreen('home');

    if (!P.storageAvailable) {
      setTimeout(function () { toast('当前环境无法保存进度'); }, 600);
    }
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 忽略 */ });
    }

  }

  window.TQApp = {
    startMain: startMain,
    startGame: startGame,
    startCustom: function (config) {
      startGame(Core.prepareConfig(config), { mode: 'custom', level: 0, tier: 'custom' });
    },
    showScreen: showScreen,
    goScreen: goScreen,
    openOverlay: openOverlay,
    closeOverlay: closeOverlay,
    toast: toast,
    setInstant: function (v) { S.instant = !!v; },
    getCustom: function () { return S.custom; },
    setCustom: function (list) { S.custom = list; persistCustom(); },
    getSettings: function () { return S.settings; },
    state: S
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
