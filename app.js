/* ==========================================================
   繪本電子書主程式（純 JavaScript，無需任何套件）
   結構：
     1. CONFIG        設定區（檔名、頁數、音量）
     2. DOM / State   元素與狀態
     3. 工具函式      提示訊息、除錯記錄
     4. 頁面模組      翻頁、載入 / 錯誤提示、邊界限制
     5. 預載模組      預載第 N+1 頁的圖片與語音
     6. 朗讀模組      播放 / 中斷 / 背景音樂降音量
     7. 音樂模組      自動循環播放、靜音、空白鍵暫停
     8. 除錯模組      Debug 按鈕與面板
     9. 事件綁定      按鈕、鍵盤、滑動手勢
   ========================================================== */
(() => {
  'use strict';

  /* ---------- 1. CONFIG ---------- */
  const CONFIG = {
    firstPage: 0,
    lastPage: 19,

    // 繪本圖片：graphics/0.jpg ~ graphics/19.jpg
    imageDir: 'graphics/',
    imageExt: 'jpg',

    // 語音：依序嘗試 speech/N.mp3 → N.wav → N.m4a → N.ogg
    speechDir: 'speech/',
    speechExts: ['mp3', 'wav', 'm4a', 'ogg'],
    speechName: (page) => String(page),           // 若檔名不是純數字，改這裡

    // 背景音樂：依序嘗試，使用第一個能播放的。請把你的實際檔名加在最前面
    musicCandidates: [
      'music/bgm.mp3',
      'music/music.mp3',
      'music/background.mp3',
      'music/bgm.m4a',
      'music/bgm.ogg',
      'music/bgm.wav',
    ],
    musicVolume: 0.5,        // 平常音量
    musicDuckVolume: 0.15,   // 朗讀時的背景音樂音量
  };

  /* ---------- 2. DOM 與狀態 ---------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    img: $('page-image'),
    prev: $('prev-btn'), next: $('next-btn'),
    read: $('read-btn'), spirit: $('spirit-btn'), debug: $('debug-btn'),
    indicator: $('page-indicator'), bar: $('progress-bar'), stage: $('stage'),
    loading: $('loading-indicator'),
    error: $('error-message'), retry: $('retry-btn'),
    toast: $('toast'), debugPanel: $('debug-panel'),
  };

  const state = {
    page: CONFIG.firstPage,
    direction: 'fade',        // 圖片載入完成後使用的進場動畫
    reading: false,
    muted: false,
    speechToken: 0,           // 每次中斷 / 重播就 +1，用來作廢「過期」的非同步播放
    speechUrlCache: {},       // page -> 已確認可用的語音網址
    musicUrl: null,
    musicWasPlayingBeforeHide: false,
  };

  // 背景音樂與朗讀各用一個 Audio 物件
  const music = new Audio();
  music.loop = true;
  music.preload = 'auto';
  music.volume = CONFIG.musicVolume;

  const speechAudio = new Audio();
  speechAudio.preload = 'auto';

  /* ---------- 3. 工具函式 ---------- */
  let toastTimer;
  function toast(msg, ms = 3000) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
  }

  const debugLog = [];
  function log(msg) {
    debugLog.push(`${new Date().toLocaleTimeString()}  ${msg}`);
    if (debugLog.length > 30) debugLog.shift();
    console.debug('[ebook]', msg);
  }

  const imageUrl = (page) => `${CONFIG.imageDir}${page}.${CONFIG.imageExt}`;
  const speechCandidates = (page) =>
    CONFIG.speechExts.map((ext) => `${CONFIG.speechDir}${CONFIG.speechName(page)}.${ext}`);

  /* ---------- 4. 頁面模組 ---------- */

  const showLoading = (on) => { els.loading.style.display = on ? 'block' : 'none'; };
  const showError = (on) => { els.error.style.display = on ? 'block' : 'none'; };

  /** 更新頁碼、進度條、上一頁 / 下一頁的停用狀態 */
  function updateUI() {
    const total = CONFIG.lastPage - CONFIG.firstPage + 1;
    const current = state.page - CONFIG.firstPage + 1;
    els.indicator.textContent = `第 ${current} / ${total} 頁`;
    els.bar.style.width = `${(current / total) * 100}%`;
    els.prev.disabled = state.page <= CONFIG.firstPage;   // 第 0 頁：停用上一頁
    els.next.disabled = state.page >= CONFIG.lastPage;    // 第 19 頁：停用下一頁
  }

  /** 圖片載入成功 */
  function handleImageLoad() {
    showLoading(false);
    showError(false);
    els.img.style.visibility = 'visible';
    els.img.classList.remove('enter-next', 'enter-prev', 'enter-fade');
    void els.img.offsetWidth;                              // 強制重排，動畫才能重複觸發
    els.img.classList.add(`enter-${state.direction}`);
  }

  /** 圖片載入失敗：顯示錯誤訊息與重試按鈕 */
  function handleImageError() {
    showLoading(false);
    showError(true);
    els.img.style.visibility = 'hidden';
    log(`圖片載入失敗：${els.img.getAttribute('src')}`);
  }

  /** 切換到指定頁；direction: 'next' | 'prev' | 'fade' */
  function showPage(page, direction = 'fade') {
    page = Math.max(CONFIG.firstPage, Math.min(CONFIG.lastPage, page));
    state.page = page;
    state.direction = direction;

    stopSpeech();                       // 換頁：立即中斷舊頁語音並恢復背景音樂音量
    updateUI();

    showLoading(true);
    showError(false);
    els.img.style.visibility = 'visible';
    els.img.alt = `繪本第 ${page + 1} 頁`;
    els.img.src = imageUrl(page);

    preloadNext(page);
  }

  const goNext = () => { if (state.page < CONFIG.lastPage) showPage(state.page + 1, 'next'); };
  const goPrev = () => { if (state.page > CONFIG.firstPage) showPage(state.page - 1, 'prev'); };

  /* ---------- 5. 預載模組 ---------- */
  const preloadedImages = {};   // 保留參照，避免被垃圾回收而中斷預載
  const preloadedAudio = {};

  /** 偷偷探測並預載某頁語音，成功時記下可用網址 */
  function probeSpeech(page) {
    const a = new Audio();
    a.preload = 'auto';
    const urls = speechCandidates(page);
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) { a.oncanplay = a.onerror = null; log(`預載：第 ${page} 頁沒有語音檔`); return; }
      a.src = urls[i];
      a.load();
    };
    a.oncanplay = () => {
      state.speechUrlCache[page] = urls[i];
      a.oncanplay = a.onerror = null;
      log(`預載語音完成：${urls[i]}`);
    };
    a.onerror = () => { i += 1; tryNext(); };
    tryNext();
    return a;
  }

  /** 切換到第 N 頁時，背景預載第 N+1 頁的圖片與語音 */
  function preloadNext(page) {
    const n = page + 1;
    if (n > CONFIG.lastPage) return;
    if (!preloadedImages[n]) {
      const im = new Image();
      im.src = imageUrl(n);
      preloadedImages[n] = im;
    }
    if (!preloadedAudio[n]) preloadedAudio[n] = probeSpeech(n);
  }

  /* ---------- 6. 朗讀模組 ---------- */

  const duck = () => { music.volume = CONFIG.musicDuckVolume; };     // 朗讀中：0.15
  const unduck = () => { music.volume = CONFIG.musicVolume; };       // 朗讀結束：0.5

  function setReading(on) {
    state.reading = on;
    els.read.classList.toggle('reading', on);
    if (on) duck(); else unduck();
  }

  /** 立即停止並重置朗讀（Stop & Reset currentTime = 0），回傳新的 token */
  function stopSpeech() {
    state.speechToken += 1;             // 讓尚在等待中的 play() 失效
    speechAudio.pause();
    try { speechAudio.currentTime = 0; } catch (e) { /* 尚未載入中繼資料時可忽略 */ }
    setReading(false);
    return state.speechToken;
  }

  speechAudio.onended = () => setReading(false);   // 朗讀結束：背景音樂恢復 0.5
  speechAudio.onplaying = () => { state.reading = true; els.read.classList.add('reading'); duck(); };

  /**
   * 點朗讀鈕：先中斷目前正在播的語音，再從頭播放本頁語音（連按也安全）。
   * 依序嘗試 mp3 / wav / m4a / ogg，找不到才提示。
   */
  async function readCurrentPage() {
    const token = stopSpeech();
    const page = state.page;
    const cached = state.speechUrlCache[page];
    const urls = cached ? [cached] : speechCandidates(page);

    for (const url of urls) {
      if (token !== state.speechToken) return;      // 使用者已再次點擊或翻頁
      speechAudio.src = url;
      try {
        await speechAudio.play();
        if (token !== state.speechToken) return;
        state.speechUrlCache[page] = url;
        setReading(true);
        log(`朗讀：${url}`);
        return;
      } catch (err) {
        if (token !== state.speechToken) return;    // 被中斷造成的 AbortError，直接忽略
        if (err && err.name === 'NotAllowedError') {
          toast('瀏覽器擋住了播放，請再點一次朗讀');
          return;
        }
        log(`語音載入失敗：${url}（${err && err.name}）`);
      }
    }
    toast(`第 ${page + 1} 頁找不到語音檔 🔇（請檢查 speech/ 資料夾）`);
  }

  /* ---------- 7. 音樂模組 ---------- */

  let musicLoading = null;

  /**
   * 開始（或繼續）播放背景音樂。回傳 'playing' | 'blocked' | 'missing'
   * blocked = 瀏覽器的自動播放政策擋下，需等使用者互動
   */
  function startMusic() {
    if (musicLoading) return musicLoading;
    musicLoading = (async () => {
      const urls = state.musicUrl ? [state.musicUrl] : CONFIG.musicCandidates;
      for (const url of urls) {
        music.src = url;
        try {
          await music.play();
          state.musicUrl = url;
          log(`背景音樂播放中：${url}`);
          return 'playing';
        } catch (err) {
          if (err && err.name === 'NotAllowedError') return 'blocked';
          log(`音樂載入失敗：${url}（${err && err.name}）`);
        }
      }
      return 'missing';
    })().finally(() => { musicLoading = null; });
    return musicLoading;
  }

  /** 空白鍵：播放 / 暫停背景音樂 */
  async function toggleMusicPlayback() {
    if (music.paused) {
      const r = await startMusic();
      if (r === 'missing') toast('找不到背景音樂 🎵（請檢查 music/ 資料夾）', 4000);
    } else {
      music.pause();
      log('背景音樂已暫停');
    }
  }

  /** 靜音 / 解除靜音（用 muted 屬性，音量數值 0.5 / 0.15 不受影響） */
  function setMuted(m) {
    state.muted = m;
    music.muted = m;
    els.spirit.classList.toggle('is-muted', m);
    els.spirit.setAttribute('aria-pressed', String(m));
    els.spirit.title = m ? '解除靜音' : '靜音';
    log(m ? '背景音樂已靜音' : '背景音樂已解除靜音');
  }

  function onSpiritClick() {
    setMuted(!state.muted);
    els.spirit.classList.remove('wiggle');
    void els.spirit.offsetWidth;
    els.spirit.classList.add('wiggle');
  }

  /**
   * 自動播放：先直接嘗試；若被瀏覽器擋下，就在使用者第一次互動時啟動。
   * （空白鍵不列入，因為空白鍵本身就是「播放 / 暫停」。）
   */
  function initMusicAutoplay() {
    const events = ['pointerdown', 'touchend', 'keydown'];
    const unlock = async (e) => {
      if (e.type === 'keydown' && (e.key === ' ' || e.code === 'Space')) return;
      const r = await startMusic();
      if (r === 'playing') {
        events.forEach((t) => document.removeEventListener(t, unlock, true));
      } else if (r === 'missing') {
        events.forEach((t) => document.removeEventListener(t, unlock, true));
        toast('找不到背景音樂 🎵（請檢查 music/ 資料夾）', 4000);
      }
    };

    startMusic().then((r) => {
      if (r === 'blocked') {
        events.forEach((t) => document.addEventListener(t, unlock, true));
        log('自動播放被擋下，等待使用者互動');
      } else if (r === 'missing') {
        toast('找不到背景音樂 🎵（請檢查 music/ 資料夾）', 4000);
      }
    });
  }

  /* ---------- 8. 除錯模組 ---------- */

  function snapshot() {
    return {
      page: state.page,
      indicator: els.indicator.textContent,
      imageSrc: els.img.getAttribute('src'),
      prevDisabled: els.prev.disabled,
      nextDisabled: els.next.disabled,
      music: {
        src: music.getAttribute('src'), paused: music.paused, muted: music.muted,
        volume: music.volume, currentTime: Number(music.currentTime.toFixed(1)),
      },
      speech: {
        src: speechAudio.getAttribute('src'), paused: speechAudio.paused,
        currentTime: Number(speechAudio.currentTime.toFixed(1)), reading: state.reading,
      },
      speechUrlCache: state.speechUrlCache,
      recentLog: debugLog.slice(-10),
    };
  }

  let debugTimer = null;
  function renderDebug() { els.debugPanel.textContent = JSON.stringify(snapshot(), null, 2); }

  function toggleDebugPanel() {
    const show = els.debugPanel.hidden;
    els.debugPanel.hidden = !show;
    clearInterval(debugTimer);
    if (show) { renderDebug(); debugTimer = setInterval(renderDebug, 500); }
    console.log('[ebook] debug snapshot', snapshot());
  }

  /** 除錯按鈕平常隱藏：網址加 ?debug，或按鍵盤 D 鍵可顯示 / 隱藏 */
  function toggleDebugButton(forceShow) {
    const show = typeof forceShow === 'boolean' ? forceShow : els.debug.style.display === 'none';
    els.debug.style.display = show ? '' : 'none';
    if (!show) { els.debugPanel.hidden = true; clearInterval(debugTimer); }
  }

  // 提供給瀏覽器 Console 使用：ebookDebug.getState() / ebookDebug.goTo(5)
  window.ebookDebug = { getState: snapshot, goTo: (p) => showPage(p, 'fade') };

  /* ---------- 9. 事件綁定 ---------- */

  function bindEvents() {
    els.prev.addEventListener('click', goPrev);
    els.next.addEventListener('click', goNext);
    els.read.addEventListener('click', readCurrentPage);
    els.spirit.addEventListener('click', onSpiritClick);
    els.debug.addEventListener('click', toggleDebugPanel);

    // 圖片事件
    els.img.addEventListener('load', handleImageLoad);
    els.img.addEventListener('error', handleImageError);

    // 重試：清除失敗的快取，重新載入目前頁面
    els.retry.addEventListener('click', () => {
      state.speechUrlCache = {};
      Object.keys(preloadedAudio).forEach((k) => delete preloadedAudio[k]);
      Object.keys(preloadedImages).forEach((k) => delete preloadedImages[k]);
      showError(false);
      showLoading(true);
      els.img.style.visibility = 'visible';
      els.img.src = `${imageUrl(state.page)}?retry=${Date.now()}`;
      preloadNext(state.page);
      log('使用者按下重試');
    });

    // 鍵盤：← 上一頁、→ 下一頁、空白鍵 播放 / 暫停音樂、D 顯示除錯按鈕
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();                          // 防止網頁向下捲動
        if (!e.repeat) toggleMusicPlayback();
      } else if (e.key === 'd' || e.key === 'D') {
        toggleDebugButton();
      }
    });
    // 部分瀏覽器（如 Firefox）會在 keyup 時對聚焦中的按鈕觸發 click，這裡一併攔截
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.code === 'Space') e.preventDefault();
    });

    // 觸控滑動：向左滑 = 下一頁，向右滑 = 上一頁
    let startX = 0, startY = 0;
    els.stage.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, { passive: true });
    els.stage.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? goNext : goPrev)();
    }, { passive: true });

    // 分頁切到背景時暫停音樂，回來再繼續
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.musicWasPlayingBeforeHide = !music.paused;
        music.pause();
      } else if (state.musicWasPlayingBeforeHide) {
        music.play().catch(() => {});
      }
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    bindEvents();
    updateUI();
    setMuted(false);

    // HTML 已指定 graphics/0.jpg；若在 JS 執行前就載入完成，補做一次狀態處理
    if (els.img.complete) {
      if (els.img.naturalWidth > 0) handleImageLoad(); else handleImageError();
    } else {
      showLoading(true);
    }

    preloadNext(state.page);
    initMusicAutoplay();
    if (/[?&]debug\b/.test(location.search)) toggleDebugButton(true);
  }

  init();
})();