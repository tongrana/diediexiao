/* ============================================================================
 * 叠叠消 · levels.js
 * 关卡 / 难度 / 时间参数 —— 纯数据 + 纯函数，无 DOM、无平台 API。
 * 浏览器：window.TQLevels   小程序：require('../../lib/levels.js')   Node：module.exports
 * ==========================================================================*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TQLevels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 牌面 */
  // 只用 emoji：零资源、无版权风险、各端都能渲染。顺序稳定，前 N 个即为该关牌种。
  const EMOJI = ['🐑', '🥕', '✂️', '🪣', '🧶', '🌾', '🍄', '🐔', '🌽', '🍀', '🔔', '🧺', '🍇', '🐟'];

  /* ------------------------------------------------------------ 时间模型 */
  // perTile：平均每张牌的操作成本（看牌-判断-点击），单位秒。
  // perLayer：层数带来的额外搜索成本。
  // 这两个常数由 tests/selftest.mjs 的「难度校准」反向验证：
  //   中等玩家(1.6s/击) 胜率 85%~100%，慢速玩家(≈2.56s/击) 胜率 25%~70%。
  // 注意：基础时间只是「墙」，真正的可用时间还要加上每次消除的奖励（见 bonus）。
  const TIME = {
    perTile: 1.44,
    perLayer: 3.5,
    min: 45,
    max: 420,
    comboWindow: 5,      // 连击判定窗口（秒）
    comboStep: 0.5,      // 每层连击额外奖励
    comboCap: 2.0,       // 单次连击奖励上限
    addTimeAmount: 30    // 加时道具秒数
  };

  /* -------------------------------------------------------- 星级评价标准 */
  // 通关时按「剩余时间 / 基础时间」的比例给星。改这里 UI 与结算会自动跟着变。
  const STARS = {
    three: 0.40,   // 剩余 ≥40% → 3 星
    two: 0.15      // 剩余 ≥15% → 2 星；再低（只要通关）→ 1 星
  };

  /* ------------------------------------------------------ 免费道具与金币 */
  // 免费道具不写死：随关卡难度（牌数/组数）增加，新玩家前期也有得用。
  function freeProps(cfg) {
    const triples = Math.max(3, Math.round(cfg.tiles / 3));
    const level = cfg.level || 0;
    const base = 1 + Math.floor(triples / 12);   // 6 组→1，12→2，24→3，44→4
    return {
      undo: base,
      shuffle: Math.max(1, base - 1),
      hint: base,
      addTime: level >= 8 ? 2 : 1
    };
  }

  // 通关金币：随难度（组数、档位、星级）增加；自定义关卡不产出，避免刷币。
  function coinReward(cfg, stars) {
    if (!cfg || cfg.tier === 'custom') return 0;
    const triples = Math.max(3, Math.round(cfg.tiles / 3));
    const mul = cfg.tier === 'hard' ? 1.3 : cfg.tier === 'easy' ? 0.8 : 1;
    const starBonus = [0, 0, 5, 12][stars] || 0;
    return Math.round((6 + triples * 2) * mul) + starBonus;
  }

  /* -------------------------------------------------------------- 商城 */
  const SHOP_ITEMS = [
    { id: 'undo', name: '撤销', icon: '↩', price: 20, desc: '回退上一步，连已消除的也能退回' },
    { id: 'shuffle', name: '洗牌', icon: '🔀', price: 25, desc: '重排剩下的牌，洗后仍保证可解' },
    { id: 'hint', name: '提示', icon: '💡', price: 25, desc: '高亮一组能凑成三张的牌' },
    { id: 'addTime', name: '加时', icon: '⏱', price: 35, desc: '立即 +30 秒（用过最高 2 星）' },
    { id: 'revive', name: '复活卡', icon: '💖', price: 60, desc: '失败后原地复活，额外 +30 秒' }
  ];

  /* ---------------------------------------------------------------- 难度档 */
  const TIERS = {
    easy: {
      id: 'easy', label: '简单', desc: '牌种少一层，时间更宽裕',
      timeMul: 1.30, bonus: 3.0, spread: 6,
      typeDelta: -1, layerDelta: -1,
      props: { undo: 3, shuffle: 2, hint: 3, addTime: 2 }
    },
    normal: {
      id: 'normal', label: '普通', desc: '标准难度，推荐',
      timeMul: 1.00, bonus: 2.5, spread: 12,
      typeDelta: 0, layerDelta: 0,
      props: { undo: 2, shuffle: 2, hint: 2, addTime: 1 }
    },
    hard: {
      id: 'hard', label: '困难', desc: '牌种多一层，时间收紧',
      timeMul: 0.82, bonus: 2.0, spread: 18,
      typeDelta: 1, layerDelta: 1,
      props: { undo: 1, shuffle: 1, hint: 1, addTime: 1 }
    }
  };
  const TIER_IDS = ['easy', 'normal', 'hard'];

  /* ------------------------------------------------------------ 形状模板 */
  const SHAPES = ['pyramid', 'diamond', 'ring', 'cross', 'twin', 'wave', 'hollow'];

  /* -------------------------------------------------------- 主线 20 关表 */
  // triples = 组数，实际牌数 = triples * 3。牌数单调不减，难度平滑上升。
  const MAIN_LEVELS = [
    { types: 5, layers: 3, triples: 9, shape: 'pyramid' }, //  1 · 27 张
    { types: 5, layers: 3, triples: 11, shape: 'pyramid' }, //  2 · 33 张
    { types: 5, layers: 4, triples: 13, shape: 'diamond' }, //  3 · 39 张
    { types: 6, layers: 4, triples: 15, shape: 'diamond' }, //  4 · 45 张
    { types: 6, layers: 4, triples: 17, shape: 'ring' }, //  5 · 51 张
    { types: 6, layers: 5, triples: 19, shape: 'cross' }, //  6 · 57 张
    { types: 6, layers: 5, triples: 21, shape: 'twin' }, //  7 · 63 张
    { types: 6, layers: 6, triples: 23, shape: 'wave' }, //  8 · 69 张
    { types: 6, layers: 6, triples: 25, shape: 'hollow' }, //  9 · 75 张
    { types: 7, layers: 7, triples: 27, shape: 'cross' }, // 10 · 81 张
    { types: 7, layers: 8, triples: 29, shape: 'pyramid' }, // 11 · 87 张
    { types: 7, layers: 6, triples: 31, shape: 'wave' }, // 12 · 93 张
    { types: 7, layers: 6, triples: 32, shape: 'hollow' }, // 13 · 96 张
    { types: 7, layers: 7, triples: 33, shape: 'cross' }, // 14 · 99 张
    { types: 7, layers: 8, triples: 34, shape: 'pyramid' }, // 15 · 102 张
    { types: 7, layers: 6, triples: 35, shape: 'hollow' }, // 16 · 105 张
    { types: 7, layers: 8, triples: 36, shape: 'cross' }, // 17 · 108 张
    { types: 7, layers: 8, triples: 36, shape: 'wave' }, // 18 · 108 张
    { types: 7, layers: 8, triples: 36, shape: 'hollow' }, // 19 · 108 张
    { types: 7, layers: 8, triples: 36, shape: 'pyramid' } // 20 · 108 张
  ];

  /* --------------------------------------------------------------- 工具 */
  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  }
  function clampInt(v, lo, hi) {
    return Math.round(clamp(v, lo, hi));
  }

  /** 基础时间（秒）。tiles=总牌数，layers=层数，timeMul=难度时间系数 */
  function computeBaseTime(tiles, layers, timeMul) {
    const raw = (tiles * TIME.perTile + layers * TIME.perLayer) * (timeMul == null ? 1 : timeMul);
    return Math.round(clamp(Math.ceil(raw), TIME.min, TIME.max));
  }

  /** "1:05" / "0:07" */
  function formatTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function getTier(id) {
    return TIERS[id] || TIERS.normal;
  }
  function getTierList() {
    return TIER_IDS.map(function (id) { return TIERS[id]; });
  }

  /** 主线关卡配置。index 从 0 开始（对外 displayLevel = index+1） */
  function mainLevelConfig(index, tierId) {
    const base = MAIN_LEVELS[index];
    if (!base) return null;
    const t = getTier(tierId);
    const types = clampInt(base.types + t.typeDelta, 4, EMOJI.length);
    const layers = clampInt(base.layers + t.layerDelta, 2, 8);
    const tiles = base.triples * 3;
    return {
      id: 'main-' + (index + 1),
      name: '第 ' + (index + 1) + ' 关',
      level: index + 1,
      tier: t.id,
      types: types,
      layers: layers,
      tiles: tiles,
      slot: 8,
      baseTime: computeBaseTime(tiles, layers, t.timeMul),
      bonusPerClear: t.bonus,
      comboBonus: true,
      spread: t.spread,
      shape: base.shape,
      props: { undo: t.props.undo, shuffle: t.props.shuffle, hint: t.props.hint, addTime: t.props.addTime }
    };
  }

  function mainLevelCount() {
    return MAIN_LEVELS.length;
  }

  /* ------------------------------------------------------ 自定义关卡校验 */
  const DEFAULTS = {
    name: '我的关卡',
    types: 8,
    layers: 5,
    tiles: 60,
    slot: 8,
    baseTime: 0,          // 0 = 按公式自动
    bonusPerClear: 2.5,
    comboBonus: true,
    spread: 12,
    shape: 'auto',
    props: { undo: 2, shuffle: 2, hint: 2, addTime: 1 }
  };

  /**
   * 校验并归一化一个自定义关卡配置。
   * @returns {{config:Object, warnings:string[]}}
   * 非法值一律回落默认并记录 warning，绝不抛异常（导入外部 JSON 也走这里）。
   */
  function validateConfig(raw) {
    const warnings = [];
    const src = (raw && typeof raw === 'object') ? raw : {};

    function num(key, lo, hi, def) {
      const v = src[key];
      if (v == null || v === '' || !isFinite(Number(v))) {
        if (v != null) warnings.push('参数 ' + key + ' 非法，已回落默认值');
        return def;
      }
      const n = Number(v);
      const c = clampInt(n, lo, hi);
      if (c !== Math.round(n)) warnings.push('参数 ' + key + ' 超出范围已调整');
      return c;
    }

    let tiles = num('tiles', 15, 198, DEFAULTS.tiles);
    if (tiles % 3 !== 0) {
      const fixed = Math.max(15, tiles - (tiles % 3));
      warnings.push('总牌数必须是 3 的倍数，已调整为 ' + fixed);
      tiles = fixed;
    }

    let baseTime = num('baseTime', 0, 600, DEFAULTS.baseTime);
    if (baseTime > 0 && baseTime < 30) {
      warnings.push('时间限制过短，已提升到 30 秒');
      baseTime = 30;
    }

    const shape = SHAPES.indexOf(src.shape) >= 0 ? src.shape : 'auto';
    if (src.shape && src.shape !== shape) warnings.push('未知形状已回落 auto');

    const name = String(src.name == null ? DEFAULTS.name : src.name).trim().slice(0, 12) || DEFAULTS.name;

    const p = (src.props && typeof src.props === 'object') ? src.props : {};
    const props = {
      undo: clampInt(isFinite(Number(p.undo)) ? p.undo : DEFAULTS.props.undo, 0, 5),
      shuffle: clampInt(isFinite(Number(p.shuffle)) ? p.shuffle : DEFAULTS.props.shuffle, 0, 5),
      hint: clampInt(isFinite(Number(p.hint)) ? p.hint : DEFAULTS.props.hint, 0, 5),
      addTime: clampInt(isFinite(Number(p.addTime)) ? p.addTime : DEFAULTS.props.addTime, 0, 5)
    };

    const config = {
      id: typeof src.id === 'string' && src.id ? src.id.slice(0, 40) : 'custom-' + Date.now().toString(36),
      name: name,
      level: 0,
      tier: 'custom',
      types: num('types', 4, EMOJI.length, DEFAULTS.types),
      layers: num('layers', 2, 8, DEFAULTS.layers),
      tiles: tiles,
      slot: num('slot', 5, 8, DEFAULTS.slot),
      baseTime: baseTime,
      bonusPerClear: Math.round(clamp(
        isFinite(Number(src.bonusPerClear)) ? Number(src.bonusPerClear) : DEFAULTS.bonusPerClear, 0, 6) * 10) / 10,
      comboBonus: src.comboBonus !== false,
      spread: num('spread', 0, 30, DEFAULTS.spread),
      shape: shape,
      props: props
    };

    if (config.spread < 6) warnings.push('分布窗口很小，同图案会挨在一起，难度偏低');
    return { config: config, warnings: warnings };
  }

  /* --------------------------------------------------- 编辑器用的难度评估 */
  /** 粗估通关时长（秒）：按 1.6s/张 + 层数开销 */
  function estimateClearTime(config) {
    return Math.round(config.tiles * 1.6 + config.layers * 2);
  }

  /** 难度评级：牌数 × 牌种 × 层数 / 卡槽宽裕度 */
  function difficultyRating(config) {
    const load = config.tiles / 3;
    const spreadRisk = 0.75 + config.spread / 20;              // 0.75 ~ 2.25
    const typeRisk = 0.7 + (config.types - 4) / 10;            // 0.7 ~ 1.7
    const slotRelief = 1.25 - (config.slot - 5) / 10;          // 0.95 ~ 1.25
    const layerRisk = 1 + config.layers / 20;
    const score = (load / 12) * typeRisk * spreadRisk * slotRelief * layerRisk;
    let label = '轻松';
    if (score >= 1.5) label = '适中';
    if (score >= 2.4) label = '有挑战';
    if (score >= 3.4) label = '硬核';
    return { score: Math.round(score * 100) / 100, label: label };
  }

  /** 该配置实际使用的基础时间（baseTime=0 时自动算） */
  function effectiveBaseTime(config) {
    if (config.baseTime > 0) return config.baseTime;
    return computeBaseTime(config.tiles, config.layers, 1);
  }

  return {
    EMOJI: EMOJI,
    TIME: TIME,
    STARS: STARS,
    SHOP_ITEMS: SHOP_ITEMS,
    freeProps: freeProps,
    coinReward: coinReward,
    TIERS: TIERS,
    TIER_IDS: TIER_IDS,
    SHAPES: SHAPES,
    MAIN_LEVELS: MAIN_LEVELS,
    DEFAULTS: DEFAULTS,
    clamp: clamp,
    clampInt: clampInt,
    computeBaseTime: computeBaseTime,
    effectiveBaseTime: effectiveBaseTime,
    formatTime: formatTime,
    getTier: getTier,
    getTierList: getTierList,
    mainLevelConfig: mainLevelConfig,
    mainLevelCount: mainLevelCount,
    validateConfig: validateConfig,
    estimateClearTime: estimateClearTime,
    difficultyRating: difficultyRating
  };
});
