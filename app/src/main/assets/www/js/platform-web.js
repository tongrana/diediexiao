/* ============================================================================
 * 叠叠消 · platform-web.js
 * 平台适配层：本地存储 / 震动 / 字体尺度。UI 只依赖这一层，方便移植到小程序。
 * ==========================================================================*/
(function () {
  'use strict';

  const PREFIX = 'tq.v1.';
  let memory = {};
  let available = true;

  try {
    const probe = PREFIX + '__probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
  } catch (e) {
    available = false; // file:// 隐私模式 / 存储被禁用 → 退化为内存态
  }

  window.TQPlatform = {
    storageAvailable: available,

    get: function (key, fallback) {
      const k = PREFIX + key;
      try {
        const raw = available ? window.localStorage.getItem(k) : memory[k];
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },

    set: function (key, value) {
      const k = PREFIX + key;
      try {
        const raw = JSON.stringify(value);
        if (available) window.localStorage.setItem(k, raw);
        else memory[k] = raw;
        return true;
      } catch (e) {
        // 配额超限等：退化为内存，不阻塞游戏
        try { memory[k] = JSON.stringify(value); } catch (e2) { /* ignore */ }
        return false;
      }
    },

    remove: function (key) {
      const k = PREFIX + key;
      try { if (available) window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      delete memory[k];
    },

    vibrate: function (pattern) {
      try {
        if (available && navigator.vibrate) navigator.vibrate(pattern);
      } catch (e) { /* ignore */ }
    },

    /** 是否处于触摸设备 */
    isTouch: function () {
      return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    }
  };
})();
