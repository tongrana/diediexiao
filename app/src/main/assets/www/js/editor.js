/* ============================================================================
 * 叠叠消 · editor.js
 * 自定义关卡：表单 / 实时评估 / 保存 / 试玩 / 分享码导入导出
 * ==========================================================================*/
(function () {
  'use strict';

  const Levels = window.TQLevels;
  const Core = window.TQCore;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const MAX_CUSTOM = 50;

  function val(id) { return Number($('#' + id).value); }

  function readForm() {
    return {
      name: ($('#f-name').value || '').trim() || '我的关卡',
      tiles: val('f-tiles'),
      types: val('f-types'),
      layers: val('f-layers'),
      slot: val('f-slot'),
      baseTime: val('f-time'),
      bonusPerClear: val('f-bonus'),
      spread: val('f-spread'),
      shape: $('#f-shape').value,
      comboBonus: true,
      props: {
        undo: val('f-prop-undo'),
        shuffle: val('f-prop-shuffle'),
        hint: val('f-prop-hint'),
        addTime: val('f-prop-addTime')
      }
    };
  }

  function writeForm(cfg) {
    $('#f-name').value = cfg.name || '';
    $('#f-tiles').value = cfg.tiles;
    $('#f-types').value = cfg.types;
    $('#f-layers').value = cfg.layers;
    $('#f-slot').value = cfg.slot;
    $('#f-time').value = cfg.baseTime || 0;
    $('#f-bonus').value = cfg.bonusPerClear;
    $('#f-spread').value = cfg.spread;
    $('#f-shape').value = cfg.shape || 'auto';
    $('#f-prop-undo').value = cfg.props.undo;
    $('#f-prop-shuffle').value = cfg.props.shuffle;
    $('#f-prop-hint').value = cfg.props.hint;
    $('#f-prop-addTime').value = cfg.props.addTime;
    updateLabels();
  }

  function updateLabels() {
    const raw = readForm();
    const checked = Levels.validateConfig(raw);
    const cfg = checked.config;

    $('#v-tiles').textContent = cfg.tiles + ' 张';
    $('#v-types').textContent = cfg.types + ' 种';
    $('#v-layers').textContent = cfg.layers + ' 层';
    $('#v-slot').textContent = cfg.slot + ' 格';
    $('#v-bonus').textContent = cfg.bonusPerClear.toFixed(1) + ' 秒';
    $('#v-spread').textContent = cfg.spread === 0 ? '不分散' : String(cfg.spread);

    const auto = Levels.computeBaseTime(cfg.tiles, cfg.layers, 1);
    if (cfg.baseTime > 0) {
      $('#v-time').textContent = Levels.formatTime(cfg.baseTime);
      $('#v-time').style.color = '';
    } else {
      $('#v-time').textContent = '自动 ' + Levels.formatTime(auto);
    }

    const est = Levels.estimateClearTime(cfg);
    const limit = cfg.baseTime > 0 ? cfg.baseTime : auto;
    $('#eval-time').textContent = Levels.formatTime(limit) + '（约 ' + Levels.formatTime(est) + ' 通关）';

    const rating = Levels.difficultyRating(cfg);
    $('#eval-diff').textContent = rating.label;

    const warnEl = $('#eval-warn');
    const warns = checked.warnings.slice();
    if (limit < est * 0.85) warns.push('时间可能偏紧，通关会比较吃力');
    if (warnEl) {
      if (warns.length) {
        warnEl.hidden = false;
        warnEl.textContent = warns.slice(0, 2).join('；');
      } else {
        warnEl.hidden = false;
        warnEl.textContent = '生成时会自动校验可解性，保证不会出现死局';
      }
    }
  }

  /* ───────────────────────────── 列表 ───────────────────────────── */
  function render() {
    const list = $('#custom-list');
    if (!list) return;
    const items = window.TQApp ? window.TQApp.getCustom() : [];
    $('#custom-count').textContent = String(items.length);
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<p class="empty-text">还没有自定义关卡，调好参数点「保存到列表」</p>';
      return;
    }
    items.forEach(function (cfg, idx) {
      const row = document.createElement('div');
      row.className = 'custom-item';
      const rating = Levels.difficultyRating(cfg);
      row.innerHTML =
        '<div class="custom-meta">' +
        '<div class="custom-name"></div>' +
        '<div class="custom-desc">' + cfg.tiles + ' 张 · ' + cfg.types + ' 种 · ' + cfg.layers + ' 层 · ' +
        rating.label + ' · ' + Levels.formatTime(cfg.baseTime || Levels.computeBaseTime(cfg.tiles, cfg.layers, 1)) +
        '</div></div>' +
        '<div class="custom-actions">' +
        '<button class="icon-btn" data-act="play" title="试玩">▶</button>' +
        '<button class="icon-btn" data-act="edit" title="编辑">✎</button>' +
        '<button class="icon-btn" data-act="share" title="分享">↗</button>' +
        '<button class="icon-btn" data-act="del" title="删除">✕</button>' +
        '</div>';
      row.querySelector('.custom-name').textContent = cfg.name || '未命名';
      row.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'play') play(cfg);
        if (act === 'edit') { writeForm(cfg); window.scrollTo(0, 0); const sc = $('.editor-scroll'); if (sc) sc.scrollTop = 0; window.TQApp.toast('已载入参数，改完点「生成并试玩」'); }
        if (act === 'share') openShare(cfg);
        if (act === 'del') {
          if (!window.confirm('删除「' + (cfg.name || '未命名') + '」？')) return;
          const arr = window.TQApp.getCustom().slice();
          arr.splice(idx, 1);
          window.TQApp.setCustom(arr);
          render();
        }
      });
      list.appendChild(row);
    });
  }

  function play(cfg) {
    const checked = Levels.validateConfig(cfg);
    window.TQApp.startCustom(checked.config);
  }

  function save() {
    const items = window.TQApp.getCustom().slice();
    const checked = Levels.validateConfig(readForm());
    const cfg = checked.config;
    if (items.length >= MAX_CUSTOM) {
      window.TQApp.toast('最多保存 ' + MAX_CUSTOM + ' 个关卡');
      return;
    }
    items.push(cfg);
    window.TQApp.setCustom(items);
    render();
    window.TQApp.toast('已保存「' + cfg.name + '」');
  }

  /* ───────────────────────────── 分享 ───────────────────────────── */
  let sharingCfg = null;
  function openShare(cfg) {
    sharingCfg = cfg;
    $('#share-code').value = Core.encodeShare(cfg);
    window.TQApp.openOverlay('ov-share');
  }

  function copyShare() {
    const el = $('#share-code');
    el.select();
    el.setSelectionRange(0, 9999);
    let done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.value).then(function () {}, function () {});
        done = true;
      }
    } catch (e) { /* ignore */ }
    try { done = document.execCommand('copy') || done; } catch (e) { /* ignore */ }
    window.TQApp.toast(done ? '已复制分享码' : '请长按文本框手动复制');
  }

  function openImport() {
    $('#import-code').value = '';
    window.TQApp.openOverlay('ov-import');
  }

  function doImport() {
    const code = ($('#import-code').value || '').trim();
    if (!code) { window.TQApp.toast('请先粘贴分享码'); return; }
    const res = Core.decodeShare(code);
    if (!res.ok) { window.TQApp.toast('分享码无法识别'); return; }
    window.TQApp.closeOverlay('ov-import');
    writeForm(res.config);
    window.TQApp.toast('导入成功，可直接试玩');
    play(res.config);
  }

  /* ───────────────────────────── 绑定 ───────────────────────────── */
  function bind() {
    ['f-tiles', 'f-types', 'f-layers', 'f-slot', 'f-time', 'f-bonus', 'f-spread',
      'f-name', 'f-shape', 'f-prop-undo', 'f-prop-shuffle', 'f-prop-hint', 'f-prop-addTime'
    ].forEach(function (id) {
      const el = $('#' + id);
      if (!el) return;
      el.addEventListener('input', updateLabels);
      el.addEventListener('change', updateLabels);
    });

    $('#btn-play-custom').addEventListener('click', function () {
      play(Levels.validateConfig(readForm()).config);
    });
    $('#btn-save-custom').addEventListener('click', save);
    $('#btn-import').addEventListener('click', openImport);
    $('#btn-copy-share').addEventListener('click', copyShare);
    $('#btn-close-share').addEventListener('click', function () { window.TQApp.closeOverlay('ov-share'); });
    $('#btn-cancel-import').addEventListener('click', function () { window.TQApp.closeOverlay('ov-import'); });
    $('#btn-do-import').addEventListener('click', doImport);
  }

  window.TQEditor = {
    render: render,
    bind: bind,
    updateLabels: updateLabels
  };

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    writeForm(Levels.validateConfig({}).config);
    updateLabels();
    render();
  });
})();
