/* ============================================================================
 * 叠叠消 · audio.js
 * 全部音效 + 背景音乐都由 WebAudio 现场合成：不加载任何音频文件，离线可用、零体积。
 * 首次用户手势后才创建 AudioContext（浏览器自动播放策略）。
 * ==========================================================================*/
(function () {
  'use strict';

  let ctx = null;
  let enabled = true;        // 音效
  let musicOn = false;       // 背景音乐开关
  let master = null;
  let volume = 1.4;
  let sfxBus = null;
  let musicBus = null;
  let musicTimer = null;
  let nextNoteTime = 0;
  let step = 0;

  /** 主音量：0~2，1 为基准；设置里的滑块右大左小 */
  function setVolume(v) {
    volume = Math.max(0, Math.min(2, Number(v) || 0));
    try { if (master) master.gain.value = volume; } catch (e) { /* ignore */ }
    return volume;
  }

  function ensure() {
    if (!enabled && !musicOn) return null;
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
        sfxBus = ctx.createGain();
        sfxBus.gain.value = 1;
        sfxBus.connect(master);
        musicBus = ctx.createGain();
        musicBus.gain.value = 0.0001;
        musicBus.connect(master);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (e) {
      return null;
    }
  }

  /** 单个音符（音效走 sfxBus） */
  function tone(opts) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (opts.delay || 0);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to), t0 + opts.dur);
    const peak = opts.gain == null ? 0.12 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain).connect(sfxBus);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  /* ───────────────────────────── 背景音乐 ─────────────────────────────
   * 4 个和弦（C - Am - F - G）循环，每小节 4 拍；长音铺底 + 短促拨弦旋律。
   * 全部是协和音程，音量很低，只做背景氛围。
   */
  const PROG = [
    { pad: [261.63, 392.00], mel: [523.25, 659.25, 783.99, 659.25] },  // C
    { pad: [220.00, 329.63], mel: [440.00, 523.25, 659.25, 523.25] },  // Am
    { pad: [174.61, 261.63], mel: [349.23, 440.00, 523.25, 440.00] },  // F
    { pad: [196.00, 293.66], mel: [392.00, 493.88, 587.33, 493.88] }   // G
  ];
  const STEP = 0.44;

  function padNote(freq, when, dur, gain) {
    const c = ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.35);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(musicBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  function pluckNote(freq, when) {
    const c = ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.05, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
    osc.connect(g).connect(musicBus);
    osc.start(when);
    osc.stop(when + 0.46);
  }

  function scheduleMusic() {
    const c = ensure();
    if (!c || !musicOn) return;
    while (nextNoteTime < c.currentTime + 0.6) {
      const bar = Math.floor(step / 4) % PROG.length;
      const beat = step % 4;
      const chord = PROG[bar];
      if (beat === 0) {
        padNote(chord.pad[0], nextNoteTime, 1.9, 0.055);
        padNote(chord.pad[1], nextNoteTime, 1.9, 0.035);
      }
      pluckNote(chord.mel[beat], nextNoteTime);
      nextNoteTime += STEP;
      step++;
    }
  }

  function startMusic() {
    if (!musicOn) return;
    const c = ensure();
    if (!c) return;
    if (musicTimer) return;
    nextNoteTime = c.currentTime + 0.15;
    step = 0;
    try {
      musicBus.gain.cancelScheduledValues(c.currentTime);
      musicBus.gain.setValueAtTime(0.0001, c.currentTime);
      musicBus.gain.linearRampToValueAtTime(0.5, c.currentTime + 1.2);
    } catch (e) { /* ignore */ }
    scheduleMusic();
    musicTimer = setInterval(scheduleMusic, 180);
  }

  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    if (ctx && musicBus) {
      try {
        musicBus.gain.cancelScheduledValues(ctx.currentTime);
        musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
        musicBus.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      } catch (e) { /* ignore */ }
    }
  }

  window.TQAudio = {
    setVolume: setVolume,
    getVolume: function () { return volume; },
    unlock: function (opts) {
      ensure();
      if (musicOn && !(opts && opts.noMusic)) startMusic();
    },

    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled && !musicOn) this.suspend();
    },

    setMusicEnabled: function (v) {
      musicOn = !!v;
      if (musicOn) startMusic();
      else stopMusic();
    },

    suspend: function () {
      try { if (ctx && ctx.state === 'running') ctx.suspend(); } catch (e) { /* ignore */ }
    },

    resume: function () {
      try { if (ctx && ctx.state === 'suspended') ctx.resume(); } catch (e) { /* ignore */ }
      if (musicOn) startMusic();
    },

    click: function () { tone({ freq: 620, dur: 0.07, type: 'triangle', gain: 0.08 }); },

    clear: function (combo) {
      const base = 720 + Math.min(4, combo || 0) * 90;
      tone({ freq: base, dur: 0.1, type: 'sine', gain: 0.12 });
      tone({ freq: base * 1.5, dur: 0.12, type: 'sine', gain: 0.09, delay: 0.06 });
    },

    combo: function (n) {
      tone({ freq: 900 + n * 60, dur: 0.09, type: 'square', gain: 0.06 });
      tone({ freq: 1350 + n * 90, dur: 0.1, type: 'sine', gain: 0.06, delay: 0.05 });
    },

    prop: function () { tone({ freq: 520, dur: 0.14, type: 'triangle', gain: 0.1, to: 780 }); },

    deny: function () { tone({ freq: 220, dur: 0.1, type: 'square', gain: 0.07 }); },

    tick: function () { tone({ freq: 1200, dur: 0.04, type: 'square', gain: 0.05 }); },

    coin: function () {
      tone({ freq: 1046.5, dur: 0.09, type: 'sine', gain: 0.09 });
      tone({ freq: 1568, dur: 0.12, type: 'sine', gain: 0.07, delay: 0.06 });
    },

    win: function () {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach(function (f, i) {
        tone({ freq: f, dur: 0.22, type: 'sine', gain: 0.11, delay: i * 0.09 });
      });
    },

    lose: function () {
      tone({ freq: 380, dur: 0.3, type: 'sawtooth', gain: 0.08, to: 180 });
      tone({ freq: 190, dur: 0.4, type: 'sine', gain: 0.07, to: 110, delay: 0.12 });
    }
  };
})();
