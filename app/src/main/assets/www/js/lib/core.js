/* ============================================================================
 * 叠叠消 · core.js
 * 纯逻辑核心：RNG / 布局生成 / 剥离序 / 图案分配 / 求解器 / 游戏状态机 / 分享码
 * 严禁出现 window、document、localStorage —— 三端共用（浏览器 / 小程序 / Node）。
 * ==========================================================================*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TQCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const Levels = (function () {
    if (typeof require === 'function' && typeof module === 'object') {
      try { return require('./levels.js'); } catch (e) { /* 小程序/浏览器走全局 */ }
    }
    if (typeof globalThis !== 'undefined' && globalThis.TQLevels) return globalThis.TQLevels;
    throw new Error('levels.js 未加载');
  })();

  /* ------------------------------------------------------------ 常量 */
  // 9×7 的格子：手机竖屏下每张牌能放大到约 38~41px，比 11 列好点得多。
  const GRID = { cols: 9, rows: 7, tw: 46, th: 56 };
  // 每层错位（0 / 半格），制造 1~4 张的部分遮挡
  const LAYER_OFFSETS = [[0, 0], [0.5, 0.5], [0.5, 0], [0, 0.5]];
  const EPS = 0.5;

  /* ================================================================
   * 1. 随机数（xorshift32，可播种，三端一致）
   * ==============================================================*/
  function createRng(seed) {
    let s = (seed | 0) || 0x9e3779b9;
    return function rng() {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  function randInt(rng, n) { return Math.floor(rng() * n); }

  /* ================================================================
   * 2. 布局生成
   * ==============================================================*/
  /**
   * 形状遮罩。t = 0（最底层）→ 1（最高层），越高层占地越小，形成塔状轮廓。
   * 所有阈值都按 t 归一化，避免高层直接收缩成 0 个格子（曾经踩过这个坑）。
   */
  function shapeMask(shape, dc, dr, t) {
    const R = 4.0;
    switch (shape) {
      case 'diamond':
        return (Math.abs(dc) + Math.abs(dr) * 1.25) <= R + 0.6 - t * 3.0;
      case 'ring': {
        const d = Math.sqrt(dc * dc + dr * dr * 1.5);
        return d <= R + 0.4 - t * 2.0 && d >= (R * 0.55) - t * 0.55;
      }
      case 'cross':
        return (Math.abs(dc) <= 1.2 || Math.abs(dr) <= 1.0) &&
          Math.max(Math.abs(dc), Math.abs(dr) * 1.1) <= R + 0.2 - t * 2.8;
      case 'twin':
        return Math.min(Math.hypot(dc - 2.2, dr * 1.1), Math.hypot(dc + 2.2, dr * 1.1)) <= R * 0.64 - t * 1.7;
      case 'wave':
        return Math.abs(dr - Math.sin(dc * 0.85) * 1.05) <= 2.9 - t * 1.4;
      case 'hollow': {
        const d = Math.max(Math.abs(dc), Math.abs(dr) * 0.85);
        return d <= R - t * 2.5 && !(t < 0.15 && d < 1.1);
      }
      case 'pyramid':
      default:
        return Math.max(Math.abs(dc), Math.abs(dr) * 0.85) <= R - t * 2.7;
    }
  }

  /**
   * 选层内格子：先按形状遮罩取候选，再按「中心度 + 随机」排序取前 count 个，
   * 保证形状是连贯的一团而不是散点。若遮罩内不够，用遮罩外的格子补齐，
   * 从而保证每层数量精确（牌总数必须能被 3 整除）。
   */
  function pickCells(shape, k, layers, count, rng) {
    const cc = (GRID.cols - 1) / 2;
    const cr = (GRID.rows - 1) / 2;
    const t = layers > 1 ? k / (layers - 1) : 0;
    const inside = [];
    const outside = [];
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        const dc = c - cc;
        const dr = r - cr;
        const dist = Math.sqrt(dc * dc + dr * dr);
        // 权重：越靠中心越可能被选中，但带随机抖动，避免每关长得一样
        const w = Math.exp(-0.28 * dist) * (0.45 + rng() * 1.1);
        const cell = { c: c, r: r, w: w };
        if (shapeMask(shape, dc, dr, t)) inside.push(cell);
        else outside.push(cell);
      }
    }
    inside.sort(function (a, b) { return b.w - a.w; });
    if (inside.length >= count) return inside.slice(0, count);
    outside.sort(function (a, b) { return b.w - a.w; });
    return inside.concat(outside.slice(0, count - inside.length));
  }

  /** 把 total 张牌按权重分给各层。返回的数组和恒等于 total。 */
  function allocateCounts(total, layers, caps) {
    const weights = [];
    for (let k = 0; k < layers; k++) {
      weights.push(Math.pow(0.76, k) * Math.sqrt(Math.max(1, caps[k])));
    }
    const sum = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    const counts = weights.map(function (w) { return Math.floor(w / sum * total); });
    let left = total - counts.reduce(function (a, b) { return a + b; }, 0);

    // 按最大余数补齐
    const fracs = weights.map(function (w, i) { return { i: i, f: w / sum * total - counts[i] }; })
      .sort(function (a, b) { return b.f - a.f; });
    let qi = 0;
    while (left > 0) {
      const idx = fracs[qi % fracs.length].i;
      qi++;
      if (counts[idx] < caps[idx] || qi > fracs.length * 4) { counts[idx]++; left--; }
    }

    // 超出容量的挪到还有空位的层
    for (let k = 0; k < layers; k++) {
      let guard = 0;
      while (counts[k] > caps[k] && guard++ < 200) {
        let best = -1, bestRoom = 0;
        for (let j = 0; j < layers; j++) {
          const room = caps[j] - counts[j];
          if (room > bestRoom) { bestRoom = room; best = j; }
        }
        if (best < 0) break;
        counts[k]--; counts[best]++;
      }
    }
    return counts;
  }

  /** 生成布局（尚未分配图案） */
  function buildLayout(cfg, rng) {
    const layers = cfg.layers;
    const shape = cfg.shape === 'auto' ? 'pyramid' : cfg.shape;

    // 每层容量（形状遮罩内格子数 + 一点余量，余量由 pickCells 的外扩补齐）
    const caps = [];
    const cc0 = (GRID.cols - 1) / 2;
    const cr0 = (GRID.rows - 1) / 2;
    for (let k = 0; k < layers; k++) {
      const t = layers > 1 ? k / (layers - 1) : 0;
      let cnt = 0;
      for (let r = 0; r < GRID.rows; r++) {
        for (let c = 0; c < GRID.cols; c++) {
          if (shapeMask(shape, c - cc0, r - cr0, t)) cnt++;
        }
      }
      caps.push(cnt + 10);
    }

    const counts = allocateCounts(cfg.tiles, layers, caps);

    const tiles = [];
    for (let k = 0; k < layers; k++) {
      const cells = pickCells(shape, k, layers, counts[k], rng);
      const off = LAYER_OFFSETS[k % LAYER_OFFSETS.length];
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        tiles.push({
          id: tiles.length,
          layer: k,
          col: cell.c,
          row: cell.r,
          x: (cell.c + off[0]) * GRID.tw,
          y: (cell.r + off[1]) * GRID.th,
          type: null,
          coverers: []
        });
      }
    }

    // 遮挡关系：只可能被更高层覆盖
    // coverers[i] = 压在 i 上面的牌；covers[i] = 被 i 压住的牌（移除 i 才能解锁它们）
    for (let i = 0; i < tiles.length; i++) {
      tiles[i].covers = [];
    }
    for (let i = 0; i < tiles.length; i++) {
      for (let j = 0; j < tiles.length; j++) {
        if (i === j) continue;
        const a = tiles[i], b = tiles[j];
        if (b.layer <= a.layer) continue;
        if (Math.abs(a.x - b.x) < GRID.tw - EPS && Math.abs(a.y - b.y) < GRID.th - EPS) {
          a.coverers.push(j);
          b.covers.push(i);
        }
      }
    }

    return {
      tiles: tiles,
      layers: layers,
      shape: shape,
      bounds: { w: GRID.cols * GRID.tw, h: GRID.rows * GRID.th },
      cell: { w: GRID.tw, h: GRID.th }
    };
  }

  /* ================================================================
   * 3. 剥离序 & 图案分配
   * ==============================================================*/
  /** 返回一个「始终取当前空闲牌」的完整顺序（无死锁 ⇒ 一定存在） */
  function peelOrder(layout, rng) {
    const n = layout.tiles.length;
    const alive = new Uint8Array(n).fill(1);
    const coverCnt = new Int16Array(n);
    for (let i = 0; i < n; i++) coverCnt[i] = layout.tiles[i].coverers.length;
    const order = [];
    for (let step = 0; step < n; step++) {
      const free = [];
      for (let i = 0; i < n; i++) if (alive[i] && coverCnt[i] === 0) free.push(i);
      if (free.length === 0) break; // 理论上不会
      const pick = free[randInt(rng, free.length)];
      alive[pick] = 0;
      order.push(pick);
      // 移除 pick → 它压着的牌少了一个遮挡
      const below = layout.tiles[pick].covers;
      for (let k = 0; k < below.length; k++) coverCnt[below[k]]--;
    }
    return order;
  }

  /**
   * 按剥离序分配图案：
   * 取 order[i]，再在其后 spread 窗口内随机挑 2 个未分配位置，三者同图案。
   * spread = 0 时退化成「相邻三连」，此时按序游玩卡槽占用 ≤2，数学上必然可解。
   */
  function assignTypes(layout, order, spread, rng) {
    const n = order.length;
    const pool = Levels.EMOJI.slice(0, Math.min(layout.types || 8, Levels.EMOJI.length));
    const used = new Uint8Array(n);
    const types = new Array(n);
    let ti = 0;

    // 注意：这里的下标一律是「剥离序中的位置」pos，而不是 tile id。
    // 最后再用 order[pos] 映射回具体牌。
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const group = [i];
      if (spread > 0) {
        const cands = [];
        for (let j = i + 1; j < n && j <= i + spread; j++) {
          if (!used[j]) cands.push(j);
        }
        shuffleInPlace(cands, rng);
        for (let k = 0; k < 2; k++) {
          if (cands[k] == null) continue;
          used[cands[k]] = 1;
          group.push(cands[k]);
        }
      }
      // 不足 3 个（窗口太小/末尾）→ 顺延取后两个未分配位置
      let j = i + 1;
      while (group.length < 3 && j < n) {
        if (!used[j]) { used[j] = 1; group.push(j); }
        j++;
      }
      if (group.length < 3) continue; // 兜底：不应发生（总数是 3 的倍数）
      const type = pool[ti % pool.length];
      ti++;
      for (let k = 0; k < group.length; k++) types[group[k]] = type;
    }
    for (let i = 0; i < n; i++) {
      if (types[i] == null) types[i] = pool[randInt(rng, pool.length)];
      layout.tiles[order[i]].type = types[i];
    }
    return layout;
  }

  /* ================================================================
   * 4. 求解器（DFS + 记忆化 + 支配性剪枝）
   * ==============================================================*/
  const TIMEOUT = { timeout: true };

  /**
   * @param {Object} board  layout 或已生成的 board
   * @param {number} slot   卡槽容量
   * @param {Object} opts   { nodeBudget, timeMs, removed:[tileId], tray:[typeString], maxBranch }
   * @returns {{solvable:boolean, moves:number[], nodes:number, timeout:boolean}}
   */
  function solve(board, slot, opts) {
    const opt = opts || {};
    const nodeBudget = opt.nodeBudget || 120000;
    const timeMs = opt.timeMs == null ? 80 : opt.timeMs;
    const maxBranch = opt.maxBranch || 26;
    const tiles = board.tiles;
    const n = tiles.length;

    // 类型索引
    const typeList = [];
    const typeMap = {};
    const typeIdx = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const t = tiles[i].type;
      if (typeMap[t] == null) { typeMap[t] = typeList.length; typeList.push(t); }
      typeIdx[i] = typeMap[t];
    }
    const T = typeList.length;

    const rem = new Uint8Array(n);
    const coverCnt = new Int16Array(n);
    const words = new Int32Array((n + 31) >> 5);
    const tray = new Int8Array(T);
    let trayTotal = 0;

    const removedSet = {};
    (opt.removed || []).forEach(function (id) { removedSet[id] = 1; });

    for (let i = 0; i < n; i++) {
      if (!removedSet[i]) { rem[i] = 1; words[i >> 5] |= (1 << (i & 31)); }
    }
    for (let i = 0; i < n; i++) {
      if (!rem[i]) continue;
      let c = 0;
      const cv = tiles[i].coverers;
      for (let k = 0; k < cv.length; k++) if (rem[cv[k]]) c++;
      coverCnt[i] = c;
    }
    (opt.tray || []).forEach(function (t) {
      const idx = typeMap[t];
      if (idx != null) { tray[idx]++; trayTotal++; }
    });

    let remaining = 0;
    for (let i = 0; i < n; i++) if (rem[i]) remaining++;

    const failed = new Set();
    const moves = [];
    let nodes = 0;
    const deadline = Date.now() + timeMs;
    let timedOut = false;

    function stateKey() {
      let s = '';
      for (let w = 0; w < words.length; w++) s += (words[w] >>> 0).toString(36) + '.';
      for (let t = 0; t < T; t++) s += tray[t];
      return s;
    }

    function dfs() {
      if (remaining === 0) return true;
      nodes++;
      if (nodes > nodeBudget) { timedOut = true; throw TIMEOUT; }
      if ((nodes & 511) === 0 && Date.now() > deadline) { timedOut = true; throw TIMEOUT; }

      const key = stateKey();
      if (failed.has(key)) return false;

      // 收集空闲牌 + 每种类型的空闲数量
      const freeByType = new Int16Array(T);
      const free = [];
      for (let i = 0; i < n; i++) {
        if (rem[i] && coverCnt[i] === 0) { free.push(i); freeByType[typeIdx[i]]++; }
      }
      if (free.length === 0) { failed.add(key); return false; }

      // 支配性剪枝：只要能立刻三消，就一定先消（永不吃亏）
      const completing = [];
      for (let k = 0; k < free.length; k++) {
        const t = typeIdx[free[k]];
        if (tray[t] === 2) completing.push(free[k]);
      }
      let cand = free;
      if (completing.length > 0) cand = completing;

      // 打分排序
      const scored = cand.map(function (i) {
        const t = typeIdx[i];
        let s = tray[t] * 60 + freeByType[t] * 12;
        if (freeByType[t] >= 3) s += 120;
        s += tiles[i].covers.length * 6; // 移除它能解锁更多下层牌
        if (trayTotal + 1 > slot && tray[t] !== 2) s -= 9999; // 放不进去
        return { i: i, s: s };
      }).sort(function (a, b) { return b.s - a.s; });

      let tried = 0;
      const seen = {};
      for (let q = 0; q < scored.length && tried < maxBranch; q++) {
        const i = scored[q].i;
        const t = typeIdx[i];
        if (trayTotal + 1 > slot && tray[t] !== 2) continue; // 卡槽不够且不能消除
        const sig = t + ':' + tiles[i].covers.length + ':' + tray[t];
        if (seen[sig]) continue; // 同类型同状态的落子等价，去重
        seen[sig] = 1;
        tried++;

        // apply
        rem[i] = 0;
        words[i >> 5] &= ~(1 << (i & 31));
        remaining--;
        const willClear = tray[t] === 2;
        if (willClear) { tray[t] = 0; trayTotal -= 2; }
        else { tray[t]++; trayTotal++; }
        const below = tiles[i].covers;
        for (let k2 = 0; k2 < below.length; k2++) if (rem[below[k2]]) coverCnt[below[k2]]--;

        moves.push(i);
        if (dfs()) return true;
        moves.pop();

        // undo
        rem[i] = 1;
        words[i >> 5] |= (1 << (i & 31));
        remaining++;
        if (willClear) { tray[t] = 2; trayTotal += 2; } else { tray[t]--; trayTotal--; }
        for (let k2 = 0; k2 < below.length; k2++) if (rem[below[k2]]) coverCnt[below[k2]]++;
      }

      failed.add(key);
      return false;
    }

    let solvable = false;
    try {
      solvable = dfs();
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      solvable = false;
    }
    return { solvable: solvable, moves: solvable ? moves.slice() : [], nodes: nodes, timeout: timedOut };
  }

  /* ================================================================
   * 5. 对外的牌局生成（布局 → 分配 → 校验 → 自动降级）
   * ==============================================================*/
  function generateBoard(config, seed) {
    const cfg = prepareConfig(config);
    const rng = createRng(seed);
    const layout = buildLayout(cfg, rng);
    layout.types = cfg.types;

    const order = peelOrder(layout, rng);
    let spread = cfg.spread;
    let attempt = 0;
    let verified = false;

    while (attempt < 9) {
      assignTypes(layout, order, spread, rng);
      const res = solve(layout, cfg.slot, { nodeBudget: 60000, timeMs: 45 });
      if (res.solvable) { verified = true; break; }
      attempt++;
      if (spread <= 0) break;
      spread = Math.max(0, Math.ceil(spread * 0.6));
    }
    if (!verified) {
      // 兜底：严格相邻三连（按剥离序游玩卡槽占用 ≤2，必然可解）
      assignTypes(layout, order, 0, rng);
      spread = 0;
    }

    layout.seed = seed;
    layout.meta = { spread: spread, attempts: attempt, verified: verified, config: cfg };
    return layout;
  }

  /* ================================================================
   * 6. 配置预处理
   * ==============================================================*/
  function prepareConfig(raw) {
    const v = Levels.validateConfig(raw);
    const cfg = v.config;
    if (raw && raw.level != null) cfg.level = raw.level;
    if (raw && typeof raw.tier === 'string') cfg.tier = raw.tier;
    cfg.baseTime = Levels.effectiveBaseTime(cfg);
    cfg.warnings = v.warnings;
    return cfg;
  }

  /* ================================================================
   * 7. 游戏状态机
   * ==============================================================*/
  function createGame(config, seed, platform, opts) {
    const cfg = prepareConfig(config);
    const board = generateBoard(cfg, seed);
    const tiles = board.tiles;
    const n = tiles.length;

    const rem = new Uint8Array(n).fill(1);
    const coverCnt = new Int16Array(n);
    for (let i = 0; i < n; i++) coverCnt[i] = tiles[i].coverers.length;

    const gameRng = createRng((seed ^ 0x5f3759df) | 0);
    const free = Levels.freeProps(cfg);
    const stockIn = (opts && opts.stock) || {};

    const state = {
      cfg: cfg,
      board: board,
      tiles: tiles,
      seed: seed,
      platform: platform || null,
      status: 'playing',          // playing | paused | won | lost
      baseTime: cfg.baseTime,
      timeLeft: cfg.baseTime,
      elapsed: 0,
      tray: [],                   // tile id 数组（顺序即槽位顺序）
      combo: 0,
      maxCombo: 0,
      lastClearElapsed: -99,
      // free = 本关免费次数；stock = 商城买来、可跨关携带的库存
      props: {
        free: {
          undo: free.undo,
          shuffle: free.shuffle,
          hint: free.hint,
          addTime: free.addTime
        },
        stock: {
          undo: Math.max(0, Number(stockIn.undo) || 0),
          shuffle: Math.max(0, Number(stockIn.shuffle) || 0),
          hint: Math.max(0, Number(stockIn.hint) || 0),
          addTime: Math.max(0, Number(stockIn.addTime) || 0)
        }
      },
      usedAddTime: false,
      stats: { clicks: 0, clears: 0, bonus: 0 },
      history: [],
      lastEvents: []
    };

    /** 可用总次数（免费 + 库存） */
    state.propCount = function (k) {
      return state.props.free[k] + state.props.stock[k];
    };
    /** 扣一次：先扣免费，再扣库存 */
    function takeProp(k) {
      if (state.props.free[k] > 0) { state.props.free[k]--; return true; }
      if (state.props.stock[k] > 0) { state.props.stock[k]--; return true; }
      return false;
    }
    state.takeProp = takeProp;

    /* ------------------------------ 查询 ------------------------------ */
    state.remainingCount = function () {
      let c = 0;
      for (let i = 0; i < n; i++) if (rem[i]) c++;
      return c;
    };
    state.isFree = function (id) { return rem[id] === 1 && coverCnt[id] === 0; };
    state.isPresent = function (id) { return rem[id] === 1; };
    state.isCovered = function (id) { return rem[id] === 1 && coverCnt[id] > 0; };
    state.freeIds = function () {
      const out = [];
      for (let i = 0; i < n; i++) if (rem[i] && coverCnt[i] === 0) out.push(i);
      return out;
    };
    state.trayTypes = function () {
      return state.tray.map(function (id) { return tiles[id].type; });
    };
    state.stars = function () {
      const ratio = state.baseTime > 0 ? state.timeLeft / state.baseTime : 0;
      const s3 = Levels.STARS ? Levels.STARS.three : 0.4;
      const s2 = Levels.STARS ? Levels.STARS.two : 0.15;
      let s = ratio >= s3 ? 3 : (ratio >= s2 ? 2 : 1);
      if (state.usedAddTime) s = Math.min(s, 2);
      return s;
    };
    /** 本局真实用时（秒）：只统计「正在玩」的时长，不含暂停，也不是时间差 */
    state.realElapsed = function () {
      return Math.max(0, state.elapsed);
    };
    state.starRatio = function () {
      return state.baseTime > 0 ? state.timeLeft / state.baseTime : 0;
    };
    state.progress = function () {
      return { cleared: n - state.remainingCount(), total: n, ratio: (n - state.remainingCount()) / n };
    };
    state.comboActive = function () {
      return state.combo > 1 && (state.elapsed - state.lastClearElapsed) <= Levels.TIME.comboWindow;
    };

    /* ------------------------------ 快照 ------------------------------ */
    function snapshot() {
      state.history.push({
        rem: rem.slice(),
        coverCnt: coverCnt.slice(),
        tray: state.tray.slice(),
        timeLeft: state.timeLeft,
        elapsed: state.elapsed,
        combo: state.combo,
        lastClearElapsed: state.lastClearElapsed,
        usedAddTime: state.usedAddTime,
        stats: { clicks: state.stats.clicks, clears: state.stats.clears, bonus: state.stats.bonus },
        props: {
          free: Object.assign({}, state.props.free),
          stock: Object.assign({}, state.props.stock)
        },
        status: state.status
      });
      if (state.history.length > 80) state.history.shift();
    }

    /* ------------------------------ 落牌 ------------------------------ */
    state.click = function (id) {
      if (state.status !== 'playing') return { ok: false, reason: 'not-playing' };
      id = Number(id);
      if (!(id >= 0 && id < n)) return { ok: false, reason: 'bad-id' };
      if (!rem[id]) return { ok: false, reason: 'gone' };
      if (coverCnt[id] > 0) return { ok: false, reason: 'covered' };

      snapshot();
      state.stats.clicks++;

      const events = [];

      // 1) 入槽：同类型的牌自动靠在一起，其余牌顺延让位
      rem[id] = 0;
      const below = tiles[id].covers;
      for (let k = 0; k < below.length; k++) if (rem[below[k]]) coverCnt[below[k]]--;
      const idType = tiles[id].type;
      let insertAt = state.tray.length;
      for (let i = state.tray.length - 1; i >= 0; i--) {
        if (tiles[state.tray[i]].type === idType) { insertAt = i + 1; break; }
      }
      state.tray.splice(insertAt, 0, id);
      events.push({ type: 'placed', tile: id, tray: state.tray.slice(), slot: insertAt });

      // 2) 判定三消
      const type = tiles[id].type;
      const same = [];
      for (let i = 0; i < state.tray.length; i++) {
        if (tiles[state.tray[i]].type === type) same.push(state.tray[i]);
      }
      let clearedTiles = null;
      if (same.length >= 3) {
        clearedTiles = same.slice(0, 3);
        state.tray = state.tray.filter(function (x) { return clearedTiles.indexOf(x) < 0; });
      }

      // 3) 结算：先胜后负，消除优先
      if (clearedTiles) {
        state.stats.clears++;
        const inWindow = (state.elapsed - state.lastClearElapsed) <= Levels.TIME.comboWindow;
        state.combo = inWindow ? state.combo + 1 : 1;
        state.maxCombo = Math.max(state.maxCombo, state.combo);
        state.lastClearElapsed = state.elapsed;

        let bonus = cfg.bonusPerClear;
        let comboExtra = 0;
        if (cfg.comboBonus && state.combo > 1) {
          comboExtra = Math.min(Levels.TIME.comboCap, Levels.TIME.comboStep * (state.combo - 1));
          bonus += comboExtra;
        }
        bonus = Math.round(bonus * 10) / 10;
        state.timeLeft += bonus;
        state.stats.bonus += bonus;
        events.push({
          type: 'cleared', tiles: clearedTiles, tray: state.tray.slice(),
          bonus: bonus, combo: state.combo, comboExtra: comboExtra
        });
      } else {
        // 卡槽溢出判定（满 7 格可继续，第 8 张才失败）
        if (state.tray.length > cfg.slot) {
          state.status = 'lost';
          state.loseReason = 'overflow';
          events.push({ type: 'overflow', tray: state.tray.slice() });
          state.lastEvents = events;
          return { ok: true, events: events };
        }
      }

      // 4) 胜利判定
      let left = 0;
      for (let i = 0; i < n; i++) if (rem[i]) left++;
      if (left === 0) {
        state.status = 'won';
        events.push({ type: 'win' });
      }

      state.lastEvents = events;
      return { ok: true, events: events };
    };

    /* ------------------------------ 计时 ------------------------------ */
    state.tick = function (dtSec) {
      if (state.status !== 'playing') return null;
      if (!(dtSec > 0)) return null;
      state.timeLeft -= dtSec;
      state.elapsed += dtSec;
      if (state.timeLeft <= 0) {
        state.timeLeft = 0;
        state.status = 'lost';
        state.loseReason = 'timeout';
        return { type: 'timeout' };
      }
      return null;
    };
    state.pause = function () {
      if (state.status === 'playing') { state.status = 'paused'; return true; }
      return false;
    };
    state.resume = function () {
      if (state.status === 'paused') { state.status = 'playing'; return true; }
      return false;
    };

    /* ------------------------------ 道具 ------------------------------ */
    state.undo = function () {
      if (state.status !== 'playing' && state.status !== 'paused') return { ok: false, reason: 'status' };
      if (state.propCount('undo') <= 0) return { ok: false, reason: 'no-props' };
      if (state.history.length === 0) return { ok: false, reason: 'empty' };
      const s = state.history.pop();
      for (let i = 0; i < n; i++) { rem[i] = s.rem[i]; coverCnt[i] = s.coverCnt[i]; }
      state.tray = s.tray.slice();
      // 只回退「牌面」：时间不回滚（否则等于白送时间），
      // 这中间用掉的道具也不返还（只扣一次撤销本身）。
      state.combo = s.combo;
      state.lastClearElapsed = s.lastClearElapsed;
      state.stats = { clicks: s.stats.clicks, clears: s.stats.clears, bonus: s.stats.bonus };
      state.status = 'playing';
      takeProp('undo');
      return { ok: true, events: [{ type: 'undone', tray: state.tray.slice() }] };
    };

    state.shuffle = function () {
      if (state.status !== 'playing') return { ok: false, reason: 'status' };
      if (state.propCount('shuffle') <= 0) return { ok: false, reason: 'no-props' };
      const ids = [];
      for (let i = 0; i < n; i++) if (rem[i]) ids.push(i);
      if (ids.length < 4) return { ok: false, reason: 'too-few' };

      const backup = ids.map(function (i) { return tiles[i].type; });
      for (let attempt = 0; attempt < 8; attempt++) {
        const pool = ids.map(function (i) { return tiles[i].type; });
        shuffleInPlace(pool, gameRng);
        // 避免洗出「完全没变化」
        let changed = false;
        for (let k = 0; k < ids.length; k++) if (pool[k] !== tiles[ids[k]].type) { changed = true; break; }
        if (!changed) continue;
        for (let k = 0; k < ids.length; k++) tiles[ids[k]].type = pool[k];

        const res = solve(board, cfg.slot, {
          removed: (function () {
            const out = [];
            for (let i = 0; i < n; i++) if (!rem[i]) out.push(i);
            return out;
          })(),
          tray: state.trayTypes(),
          nodeBudget: 40000,
          timeMs: 40
        });
        if (res.solvable) {
          takeProp('shuffle');
          return { ok: true, events: [{ type: 'shuffled' }] };
        }
      }
      // 全部失败 → 还原，不扣次数
      for (let k = 0; k < ids.length; k++) tiles[ids[k]].type = backup[k];
      return { ok: false, reason: 'unsolvable' };
    };

    /** 提示：优先「卡槽里已有 2 张」的类型，其次「能立刻凑三张」的空闲牌 */
    state.hint = function () {
      if (state.status !== 'playing') return { ok: false, reason: 'status' };
      if (state.propCount('hint') <= 0) return { ok: false, reason: 'no-props' };
      const freeIds = state.freeIds();
      const trayCount = {};
      state.tray.forEach(function (id) { const t = tiles[id].type; trayCount[t] = (trayCount[t] || 0) + 1; });
      const freeByType = {};
      freeIds.forEach(function (id) { const t = tiles[id].type; (freeByType[t] = freeByType[t] || []).push(id); });

      let bestType = null, bestScore = -1;
      Object.keys(freeByType).forEach(function (t) {
        const inTray = trayCount[t] || 0;
        const onBoard = freeByType[t].length;
        const score = inTray * 100 + (inTray + onBoard >= 3 ? 50 : 0) + onBoard * 3;
        if (score > bestScore) { bestScore = score; bestType = t; }
      });
      if (!bestType) return { ok: false, reason: 'empty' };

      const ids = (freeByType[bestType] || []).slice(0, Math.max(1, 3 - (trayCount[bestType] || 0)));
      takeProp('hint');
      return { ok: true, types: [bestType], tiles: ids };
    };

    /** 失败后复活：回到游戏中，补时；星级上限不变（用了就算用过加时） */
    state.revive = function (extraSec) {
      if (state.status !== 'lost') return { ok: false, reason: 'status' };
      if (state.usedRevive) return { ok: false, reason: 'used' };
      state.status = 'playing';
      state.timeLeft += (extraSec || 30);
      state.usedAddTime = true;
      state.usedRevive = true;
      return { ok: true, events: [{ type: 'revived' }] };
    };

    state.addTime = function () {
      if (state.status !== 'playing' && state.status !== 'paused') return { ok: false, reason: 'status' };
      if (state.propCount('addTime') <= 0) return { ok: false, reason: 'no-props' };
      takeProp('addTime');
      state.usedAddTime = true;
      state.timeLeft += Levels.TIME.addTimeAmount;
      return { ok: true, amount: Levels.TIME.addTimeAmount };
    };

    state.restart = function (newSeed) {
      return createGame(cfg, newSeed == null ? seed : newSeed, platform, { stock: state.props.stock });
    };

    return state;
  }

  /* ================================================================
   * 8. 分享码（纯前端，无后端）
   * ==============================================================*/
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }
  function bytesUtf8(bytes) {
    let out = '', i = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      else if (b < 0xf0) out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else {
        const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023));
      }
    }
    return out;
  }
  function b64encode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      out += b1 == null ? '=' : B64[((b1 & 15) << 2) | ((b2 || 0) >> 6)];
      out += b2 == null ? '=' : B64[b2 & 63];
    }
    return out;
  }
  function b64decode(str) {
    const clean = String(str).replace(/[^A-Za-z0-9\-_]/g, '');
    const bytes = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = B64.indexOf(clean[i]), c1 = B64.indexOf(clean[i + 1]);
      const c2 = B64.indexOf(clean[i + 2]), c3 = B64.indexOf(clean[i + 3]);
      if (c0 < 0 || c1 < 0) break;
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 >= 0) bytes.push(((c2 & 3) << 6) | c3);
    }
    return bytes;
  }

  function encodeShare(cfg) {
    const slim = {
      n: cfg.name, t: cfg.types, l: cfg.layers, c: cfg.tiles, s: cfg.slot,
      b: cfg.baseTime, bc: cfg.bonusPerClear, sp: cfg.spread, sh: cfg.shape,
      p: [cfg.props.undo, cfg.props.shuffle, cfg.props.hint, cfg.props.addTime]
    };
    return 'TQ1.' + b64encode(utf8Bytes(JSON.stringify(slim)));
  }

  function decodeShare(code) {
    try {
      const str = String(code).trim().replace(/^TQ1\./, '');
      const json = bytesUtf8(b64decode(str));
      const slim = JSON.parse(json);
      const raw = {
        name: slim.n, types: slim.t, layers: slim.l, tiles: slim.c, slot: slim.s,
        baseTime: slim.b, bonusPerClear: slim.bc, spread: slim.sp, shape: slim.sh,
        props: { undo: slim.p && slim.p[0], shuffle: slim.p && slim.p[1], hint: slim.p && slim.p[2], addTime: slim.p && slim.p[3] }
      };
      const v = Levels.validateConfig(raw);
      return { ok: true, config: v.config, warnings: v.warnings };
    } catch (e) {
      return { ok: false, error: '分享码无法识别' };
    }
  }

  return {
    GRID: GRID,
    createRng: createRng,
    shuffleInPlace: shuffleInPlace,
    buildLayout: buildLayout,
    peelOrder: peelOrder,
    assignTypes: assignTypes,
    solve: solve,
    generateBoard: generateBoard,
    prepareConfig: prepareConfig,
    createGame: createGame,
    encodeShare: encodeShare,
    decodeShare: decodeShare,
    Levels: Levels
  };
});
