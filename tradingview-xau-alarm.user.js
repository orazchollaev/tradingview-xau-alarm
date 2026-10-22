// ==UserScript==
// @name         XAU/USD Alarm
// @namespace    local.xau.price.alarm
// @version      6.0.0
// @description  Çoklu seviye, yön, not, tekrar, geçmiş, bildirim ve telefon push destekli gelişmiş altın alarmı
// @match        https://*.tradingview.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      ntfy.sh
// ==/UserScript==

(() => {
  "use strict";

  window.__xauAlarmStop?.();

  const PRICE_SELECTOR = '[data-qa-id="value"]';
  const KEY_ALERTS = "xauAlerts2";
  const KEY_LEGACY_ALERTS = "xauAlerts";
  const KEY_OLD_TARGET = "xauTarget";
  const KEY_GEOMETRY = "xauPanelGeometry3";
  const KEY_HISTORY = "xauHistory";
  const KEY_NTFY = "xauNtfyTopic";
  const KEY_UI = "xauUi";
  const KEY_POS = "xauPosition";
  const CONTRACT = 100; // 1 lot = 100 oz
  const FAST_WINDOW_MS = 60000;
  const TFS = [1, 5, 15, 60];
  const CONFIRM_TICKS = 2;
  const MAX_JUMP = 0.03;
  const JUMP_ACCEPT = 5;
  const RING_EVERY_MS = 6000;
  const HISTORY_MAX = 50;
  const HISTORY_SHOWN = 5;
  const STALE_MS = 120000;
  const TITLE_PREFIX = "!! XAU ALARM | ";
  const DIRS = ["auto", "up", "down"];

  const parsePrice = (value) => {
    let s = String(value ?? "")
      .trim()
      .replace(/\s/g, "")
      .replace(/[^\d.,+-]/g, "");
    if (!s) return NaN;
    if (s.includes(".") && s.includes(",")) {
      s =
        s.lastIndexOf(",") > s.lastIndexOf(".")
          ? s.replace(/\./g, "").replace(",", ".")
          : s.replace(/,/g, "");
    } else if (s.includes(",")) {
      s = /^-?\d{1,3}(,\d{3})+$/.test(s)
        ? s.replace(/,/g, "")
        : s.replace(",", ".");
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, "");
    }
    return Number(s);
  };

  const fmt = (v) =>
    v.toLocaleString("tr-TR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    });

  const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

  // --- Kayıtlı veriler ---
  const newAlert = (price, extra = {}) => ({
    price,
    dir: "auto",
    repeat: false,
    note: "",
    fired: false,
    side: null,
    pending: 0,
    tag: "",
    ...extra,
  });

  const loadAlerts = () => {
    const stored = GM_getValue(KEY_ALERTS, null);
    if (Array.isArray(stored)) {
      return stored
        .map((a) =>
          newAlert(Number(a?.price), {
            dir: DIRS.includes(a?.dir) ? a.dir : "auto",
            repeat: !!a?.repeat,
            note: String(a?.note ?? "").slice(0, 24),
            fired: !!a?.fired,
            tag: ["sl", "tp"].includes(a?.tag) ? a.tag : "",
          }),
        )
        .filter((a) => Number.isFinite(a.price) && a.price > 0);
    }
    // Eski sürümlerden taşı.
    const legacy = GM_getValue(KEY_LEGACY_ALERTS, null);
    if (Array.isArray(legacy)) {
      return legacy
        .map((p) => newAlert(Number(p)))
        .filter((a) => Number.isFinite(a.price) && a.price > 0);
    }
    const old = Number(GM_getValue(KEY_OLD_TARGET, NaN));
    return Number.isFinite(old) && old > 0 ? [newAlert(old)] : [];
  };

  let alerts = loadAlerts();

  let history = GM_getValue(KEY_HISTORY, []);
  if (!Array.isArray(history)) history = [];
  let ntfyTopic = String(GM_getValue(KEY_NTFY, "") || "");

  const uiDefaults = {
    hidden: false,
    minimized: false,
    settingsOpen: false,
    soundPref: false,
    volume: 0.6,
    ringMax: 10,
    wakeLock: false,
    scalpOpen: false,
    tf: 5,
    balance: 1000,
    riskPct: 1,
    rr: 2,
    fastOn: false,
    fastMove: 5,
    realized: 0,
    trades: 0,
    realizedDay: "",
  };
  const ui = { ...uiDefaults, ...(GM_getValue(KEY_UI, {}) || {}) };
  ui.volume = clamp(Number(ui.volume) || uiDefaults.volume, 0.1, 1);
  ui.ringMax = clamp(Math.round(Number(ui.ringMax)) || uiDefaults.ringMax, 1, 60);

  ui.balance = Number(ui.balance) > 0 ? Number(ui.balance) : uiDefaults.balance;
  ui.riskPct = Number(ui.riskPct) > 0 ? Number(ui.riskPct) : uiDefaults.riskPct;
  ui.rr = Number(ui.rr) > 0 ? Number(ui.rr) : uiDefaults.rr;
  ui.fastMove = Number(ui.fastMove) > 0 ? Number(ui.fastMove) : uiDefaults.fastMove;
  if (!TFS.includes(ui.tf)) ui.tf = uiDefaults.tf;
  const rollDay = () => {
    const d = new Date().toDateString();
    if (ui.realizedDay !== d) {
      ui.realizedDay = d;
      ui.realized = 0;
      ui.trades = 0;
    }
  };
  rollDay();

  let position = GM_getValue(KEY_POS, null);
  if (
    !position ||
    !["buy", "sell"].includes(position.side) ||
    !Number.isFinite(position.entry) ||
    !Number.isFinite(position.lots)
  ) {
    position = null;
  }

  const saveUi = () => GM_setValue(KEY_UI, ui);
  const saveHistory = () => GM_setValue(KEY_HISTORY, history);
  const saveAlerts = () =>
    GM_setValue(
      KEY_ALERTS,
      alerts.map(({ price, dir, repeat, note, fired, tag }) => ({
        price,
        tag,
        dir,
        repeat,
        note,
        fired,
      })),
    );

  let audio = null;
  let soundOn = false;
  let stopped = false;
  let lastPrice = NaN;
  let lastChangeTs = Date.now();
  let sessionHi = NaN;
  let sessionLo = NaN;
  let jumpCand = NaN;
  let jumpCount = 0;
  let priceEl = null;
  let observedEl = null;
  let ringTimer = null;
  let ringCount = 0;
  let blinkTimer = null;
  let rafPending = false;
  let listSignature = "";
  let flashMsg = "";
  let flashUntil = 0;
  let wakeLock = null;
  let ticks = [];
  let lastFast = 0;

  // --- Fiyat okuma ---
  const findPriceEl = () => {
    const all = [...document.querySelectorAll(PRICE_SELECTOR)].filter((el) =>
      Number.isFinite(parsePrice(el.textContent)),
    );
    return all.find((el) => el.getClientRects().length > 0) || all[0] || null;
  };

  const readPrice = () => {
    if (!priceEl || !priceEl.isConnected) priceEl = findPriceEl();
    return priceEl ? parsePrice(priceEl.textContent) : NaN;
  };

  // --- Arayüz ---
  const style = document.createElement("style");
  style.textContent = `
    .xau-root, .xau-root * { box-sizing: border-box; }
    #xau-panel {
      position: fixed; z-index: 2147483647;
      width: 280px;
      background: #151515; color: #e6e6e6;
      border: 1px solid #2c2c2c; border-radius: 6px;
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      overflow: hidden;
    }
    #xau-panel.alerted { border-color: #c0392b; }
    .xau-root .h {
      display: flex; justify-content: space-between; align-items: center;
      padding: 7px 10px; cursor: move; user-select: none;
      border-bottom: 1px solid #2c2c2c; color: #8a8a8a;
    }
    #xau-panel.min .h { border-bottom: 0; }
    #xau-panel.min .b { display: none; }
    .xau-root .h .hb { display: flex; gap: 2px; }
    .xau-root .h button {
      all: unset; cursor: pointer; padding: 0 5px; font-size: 14px; line-height: 1;
    }
    .xau-root .h button:hover { color: #fff; }
    .xau-root .h .mini { font-variant-numeric: tabular-nums; color: #cfcfcf; display: none; }
    #xau-panel.min .h .mini { display: inline; }
    .xau-root .b { padding: 10px; display: grid; gap: 8px; }
    .xau-root .price {
      font-size: 24px; font-weight: 600; letter-spacing: -.3px;
      font-variant-numeric: tabular-nums;
    }
    .xau-root .price.up { color: #2ecc71; }
    .xau-root .price.down { color: #e74c3c; }
    .xau-root .range { color: #666; font-size: 11px; font-variant-numeric: tabular-nums; }
    .xau-root .list { display: grid; gap: 2px; }
    .xau-root .item {
      display: grid; grid-template-columns: 1fr auto auto; gap: 6px;
      align-items: center; padding: 3px 0;
      border-bottom: 1px solid #222; font-variant-numeric: tabular-nums;
    }
    .xau-root .item .arrow { color: #8a8a8a; margin-right: 4px; }
    .xau-root .item .val { cursor: text; }
    .xau-root .item .note { color: #777; margin-left: 6px; font-size: 11px; }
    .xau-root .item .diff { color: #8a8a8a; }
    .xau-root .item .ctl { display: flex; gap: 1px; }
    .xau-root .item.fired { color: #e74c3c; }
    .xau-root .item.fired .diff, .xau-root .item.fired .arrow { color: #e74c3c; }
    .xau-root .item button {
      all: unset; cursor: pointer; color: #666; padding: 0 3px; font-size: 13px; line-height: 1;
    }
    .xau-root .item button:hover { color: #fff; }
    .xau-root .item button.on { color: #e6e6e6; }
    .xau-root .empty { color: #666; padding: 3px 0; }
    .xau-root .add { display: flex; gap: 6px; }
    .xau-root input[type="text"] {
      flex: 1; min-width: 0; background: #0e0e0e; color: #e6e6e6;
      border: 1px solid #2c2c2c; border-radius: 4px;
      padding: 4px 6px; font: inherit;
      font-variant-numeric: tabular-nums;
    }
    .xau-root input:focus { outline: none; border-color: #555; }
    .xau-root .status { color: #8a8a8a; min-height: 17px; }
    #xau-panel.alerted .status { color: #e74c3c; }
    .xau-root .btns { display: flex; gap: 6px; }
    .xau-root .btn {
      all: unset; flex: 1; text-align: center; cursor: pointer;
      padding: 5px 0; border: 1px solid #2c2c2c; border-radius: 4px; color: #cfcfcf;
    }
    .xau-root .btn:hover { background: #202020; }
    .xau-root .btn.on { color: #fff; border-color: #555; }
    .xau-root .btn.silence { display: none; color: #e74c3c; border-color: #6b2a24; }
    .xau-root .h button.on { color: #fff; }
    .xau-root .h .tb { font-size: 11px; padding: 2px 6px; border: 1px solid #2c2c2c; border-radius: 4px; }
    .xau-root .h .hb { align-items: center; gap: 4px; }
    .xau-root .sec {
      color: #8a8a8a; font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
    }
    .xau-pop {
      position: fixed; z-index: 2147483647; width: 300px; display: none;
      background: #151515; color: #e6e6e6;
      border: 1px solid #2c2c2c; border-radius: 6px;
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.5); overflow: hidden;
    }
    .xau-pop.open { display: block; }
    .xau-pop .ph {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 10px; cursor: move; user-select: none;
      border-bottom: 1px solid #2c2c2c; color: #cfcfcf; font-weight: 600;
    }
    .xau-pop .ph button { all: unset; cursor: pointer; color: #8a8a8a; padding: 0 4px; font-size: 16px; line-height: 1; }
    .xau-pop .ph button:hover { color: #fff; }
    .xau-pop .pb { padding: 10px; display: grid; gap: 8px; }
    .xau-root .sep { border-top: 1px solid #222; margin: 2px 0; }
    .xau-root .clock { cursor: pointer; }
    .xau-root .pos { font-variant-numeric: tabular-nums; }
    .xau-root .pos:empty { display: none; }
    .xau-root .pos.up { color: #2ecc71; }
    .xau-root .pos.down { color: #e74c3c; }
    .xau-root .calc { color: #aaa; font-size: 11px; font-variant-numeric: tabular-nums; }
    .xau-root .quick .btn { padding: 3px 0; font-size: 11px; }
    .xau-root .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #aaa; }
    .xau-root .row input[type="range"] { flex: 1; max-width: 120px; accent-color: #888; }
    .xau-root .row input[type="number"] {
      width: 80px; background: #0e0e0e; color: #e6e6e6; border: 1px solid #2c2c2c;
      border-radius: 4px; padding: 3px 5px; font: inherit;
    }
    .xau-root .hist { color: #666; font-size: 11px; display: grid; gap: 1px;
      font-variant-numeric: tabular-nums; }
    #xau-dock {
      all: unset; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: none; cursor: pointer; padding: 6px 10px;
      background: #151515; color: #e6e6e6; border: 1px solid #2c2c2c;
      border-radius: 6px; font: 12px system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    #xau-dock.alerted { border-color: #c0392b; color: #e74c3c; }
  `;
  document.head.appendChild(style);

  const saved = GM_getValue(KEY_GEOMETRY, {});
  const panel = document.createElement("div");
  panel.id = "xau-panel";
  panel.style.left = `${clamp(Number(saved.x) || window.innerWidth - 304, 8, Math.max(8, window.innerWidth - 288))}px`;
  panel.style.top = `${clamp(Number(saved.y) || 24, 8, Math.max(8, window.innerHeight - 220))}px`;

  panel.classList.add("xau-root");
  panel.innerHTML = `
    <div class="h">
      <span>XAU/USD <span class="mini" data-mini></span></span>
      <span class="hb">
        <button class="tb" data-scalpbtn title="Pozisyon hesaplayıcı ve işlem takibi">Scalp</button>
        <button class="tb" data-gear title="Ses, bildirim ve alarm ayarları">Ayarlar</button>
        <button data-min title="Küçült">–</button>
        <button data-hide title="Gizle (Alt+X)">×</button>
      </span>
    </div>
    <div class="b">
      <div class="price" data-price>—</div>
      <div class="range" data-range></div>
      <div class="range clock" data-clock title="Mum süresini değiştirmek için tıkla"></div>
      <div class="pos" data-pos></div>
      <div class="sep"></div>
      <div class="sec">Alarm seviyeleri</div>
      <div class="list" data-list></div>
      <div class="add">
        <input type="text" data-new inputmode="decimal" placeholder="Seviye: 2350  ·  +10  ·  -0,5%  ·  2350 not">
        <button class="btn" data-add style="flex:0 0 52px">Ekle</button>
      </div>
      <div class="btns quick">
        <button class="btn" data-q="-10" title="Fiyatın 10 altına alarm">−10</button>
        <button class="btn" data-q="-5" title="Fiyatın 5 altına alarm">−5</button>
        <button class="btn" data-q="+5" title="Fiyatın 5 üstüne alarm">+5</button>
        <button class="btn" data-q="+10" title="Fiyatın 10 üstüne alarm">+10</button>
      </div>
      <div class="status" data-status></div>
      <div class="btns">
        <button class="btn" data-sound>Ses kapalı</button>
        <button class="btn" data-reset title="Tüm seviyeleri anlık fiyata göre yeniden kur">Sıfırla</button>
        <button class="btn silence" data-silence>Sustur</button>
      </div>
      <div class="hist" data-hist></div>
    </div>`;

  const popScalp = document.createElement("div");
  popScalp.className = "xau-pop xau-root";
  popScalp.innerHTML = `
    <div class="ph"><span>Scalp</span><button data-popclose title="Kapat">×</button></div>
    <div class="pb">
      <div class="sec">Pozisyon hesaplayıcı</div>
      <div class="row"><span>Bakiye ($)</span><input type="number" data-balance min="1" step="any"></div>
      <div class="row"><span>Risk (%)</span><input type="number" data-risk min="0.1" step="0.1"></div>
      <div class="row"><span>Giriş (boş = anlık fiyat)</span><input type="number" data-entry step="any"></div>
      <div class="row"><span>Stop (SL)</span><input type="number" data-sl step="any"></div>
      <div class="row"><span>Hedef (R katı)</span><input type="number" data-rr min="0.1" step="0.1"></div>
      <div class="calc" data-calc></div>
      <div class="sep"></div>
      <div class="sec">Pozisyon</div>
      <div class="btns">
        <button class="btn" data-buy>Al</button>
        <button class="btn" data-sell>Sat</button>
        <button class="btn" data-close>Pozisyonu kapat</button>
      </div>
      <div class="calc">Al/Sat: SL ve TP alarmlarını otomatik kurar, kâr/zararı panelde gösterir.</div>
    </div>`;

  const popSet = document.createElement("div");
  popSet.className = "xau-pop xau-root";
  popSet.innerHTML = `
    <div class="ph"><span>Ayarlar</span><button data-popclose title="Kapat">×</button></div>
    <div class="pb">
      <div class="sec">Ses</div>
      <div class="row"><span>Ses seviyesi</span><input type="range" data-volume min="0.1" max="1" step="0.1"></div>
      <div class="row"><span>Alarm tekrar sayısı</span><input type="number" data-ringmax min="1" max="60"></div>
      <div class="btns"><button class="btn" data-testsound>Sesi test et</button></div>
      <div class="sep"></div>
      <div class="sec">Bildirim</div>
      <div class="row"><span>Masaüstü bildirimi</span><button class="btn" data-notif style="flex:0 0 80px"></button></div>
      <div class="row"><span>Telefon (ntfy)</span><button class="btn" data-phone style="flex:0 0 80px">Konu</button></div>
      <div class="btns"><button class="btn" data-testpush>Telefon testi</button></div>
      <div class="sep"></div>
      <div class="sec">Alarm</div>
      <div class="row"><span>Hızlı hareket alarmı</span><button class="btn" data-fast style="flex:0 0 80px"></button></div>
      <div class="row"><span>Eşik ($ / 60 sn)</span><input type="number" data-fastmove min="0.5" step="0.5"></div>
      <div class="sep"></div>
      <div class="sec">Diğer</div>
      <div class="row"><span>Ekranı uyanık tut</span><button class="btn" data-wake style="flex:0 0 80px"></button></div>
      <div class="btns"><button class="btn" data-clearhist>Geçmişi temizle</button></div>
    </div>`;

  const dock = document.createElement("button");
  dock.id = "xau-dock";
  document.body.append(panel, popScalp, popSet, dock);

  const $ = (s) =>
    panel.querySelector(s) || popScalp.querySelector(s) || popSet.querySelector(s);
  const header = $(".h");
  const elPrice = $("[data-price]");
  const elRange = $("[data-range]");
  const elMini = $("[data-mini]");
  const elClock = $("[data-clock]");
  const elPos = $("[data-pos]");
  const elCalc = $("[data-calc]");
  const elBalance = $("[data-balance]");
  const elRisk = $("[data-risk]");
  const elEntry = $("[data-entry]");
  const elSl = $("[data-sl]");
  const elRr = $("[data-rr]");
  const elFastMove = $("[data-fastmove]");
  const btnNotif = $("[data-notif]");
  const btnFast = $("[data-fast]");
  const btnScalp = $("[data-scalpbtn]");
  const elList = $("[data-list]");
  const elNew = $("[data-new]");
  const elStatus = $("[data-status]");
  const elHist = $("[data-hist]");
  const elVolume = $("[data-volume]");
  const elRingMax = $("[data-ringmax]");
  const btnAdd = $("[data-add]");
  const btnSound = $("[data-sound]");
  const btnPhone = $("[data-phone]");
  const btnReset = $("[data-reset]");
  const btnSilence = $("[data-silence]");
  const btnGear = $("[data-gear]");
  const btnWake = $("[data-wake]");
  const btnMin = $("[data-min]");

  // Pencereler: ilk açılışta panelin yanına yerleşir, sürüklenebilir ve konumu hatırlanır.
  ui.pops = ui.pops && typeof ui.pops === "object" ? ui.pops : {};

  const placePop = (pop, key) => {
    if (pop._placed) return;
    pop._placed = true;
    const saved = ui.pops[key];
    const w = 300;
    let x;
    let y;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      x = saved.x;
      y = saved.y;
    } else {
      const r = panel.getBoundingClientRect();
      x = r.left - w - 8 >= 8 ? r.left - w - 8 : r.right + 8;
      y = r.top;
    }
    pop.style.left = `${clamp(x, 8, Math.max(8, window.innerWidth - w - 8))}px`;
    pop.style.top = `${clamp(y, 8, Math.max(8, window.innerHeight - 120))}px`;
  };

  const makePopDraggable = (pop, key) => {
    const handle = pop.querySelector(".ph");
    let d = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const r = pop.getBoundingClientRect();
      d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!d) return;
      const r = pop.getBoundingClientRect();
      pop.style.left = `${clamp(e.clientX - d.dx, 8, Math.max(8, window.innerWidth - r.width - 8))}px`;
      pop.style.top = `${clamp(e.clientY - d.dy, 8, Math.max(8, window.innerHeight - 60))}px`;
    });
    const end = () => {
      if (!d) return;
      d = null;
      const r = pop.getBoundingClientRect();
      ui.pops[key] = { x: Math.round(r.left), y: Math.round(r.top) };
      saveUi();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const saveGeometry = () => {
    if (ui.hidden) return;
    const r = panel.getBoundingClientRect();
    GM_setValue(KEY_GEOMETRY, { x: Math.round(r.left), y: Math.round(r.top) });
  };

  const applyUi = () => {
    panel.style.display = ui.hidden ? "none" : "";
    dock.style.display = ui.hidden ? "block" : "none";
    panel.classList.toggle("min", ui.minimized);
    btnMin.textContent = ui.minimized ? "+" : "–";
    btnMin.title = ui.minimized ? "Büyüt" : "Küçült";
    popSet.classList.toggle("open", ui.settingsOpen && !ui.hidden);
    btnGear.classList.toggle("on", ui.settingsOpen);
    popScalp.classList.toggle("open", ui.scalpOpen && !ui.hidden);
    if (ui.scalpOpen && !ui.hidden) placePop(popScalp, "scalp");
    if (ui.settingsOpen && !ui.hidden) placePop(popSet, "settings");
    btnScalp.classList.toggle("on", ui.scalpOpen);
    const np = "Notification" in window ? Notification.permission : "denied";
    btnNotif.textContent = np === "granted" ? "Açık" : np === "default" ? "İzin ver" : "Engelli";
    btnNotif.classList.toggle("on", np === "granted");
    btnFast.textContent = ui.fastOn ? "Açık" : "Kapalı";
    btnFast.classList.toggle("on", ui.fastOn);
    elFastMove.value = ui.fastMove;
    if (document.activeElement !== elBalance) elBalance.value = ui.balance;
    if (document.activeElement !== elRisk) elRisk.value = ui.riskPct;
    if (document.activeElement !== elRr) elRr.value = ui.rr;
    btnWake.textContent = ui.wakeLock ? "Açık" : "Kapalı";
    btnWake.classList.toggle("on", ui.wakeLock);
    btnSound.textContent = soundOn ? "Ses açık" : "Ses kapalı";
    btnSound.classList.toggle("on", soundOn);
    btnPhone.classList.toggle("on", !!ntfyTopic);
    elVolume.value = ui.volume;
    elRingMax.value = ui.ringMax;
    if (!ui.hidden) onResize();
  };

  const setHidden = (hidden) => {
    if (hidden) saveGeometry();
    ui.hidden = hidden;
    saveUi();
    applyUi();
    if (!hidden) render(readPrice());
  };

  const flash = (msg, ms = 4000) => {
    flashMsg = msg;
    flashUntil = Date.now() + ms;
    elStatus.textContent = msg;
  };

  const timeStr = (ts) =>
    new Date(ts).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });

  const renderHistory = () => {
    elHist.textContent = "";
    history
      .slice(-HISTORY_SHOWN)
      .reverse()
      .forEach((h) => {
        const d = document.createElement("div");
        d.textContent =
          `${timeStr(h.t)}  ${fmt(h.target)}  →  ${fmt(h.price)}` +
          (h.note ? `  ${h.note}` : "");
        elHist.appendChild(d);
      });
  };

  const fmtUsd = (v) =>
    (v >= 0 ? "+" : "−") +
    "$" +
    Math.abs(v).toLocaleString("tr-TR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const sessionName = () => {
    const h = new Date().getUTCHours();
    const s = [];
    if (h < 9) s.push("Asya");
    if (h >= 7 && h < 16) s.push("Londra");
    if (h >= 12 && h < 21) s.push("New York");
    return s.length ? s.join("+") : "Sakin";
  };

  const clockText = () => {
    const len = ui.tf * 60;
    const left = len - (Math.floor(Date.now() / 1000) % len);
    const mm = String(Math.floor(left / 60)).padStart(2, "0");
    const ss = String(left % 60).padStart(2, "0");
    return `M${ui.tf} kapanış ${mm}:${ss}  ·  ${sessionName()}`;
  };

  const positionPnl = (price) =>
    position && Number.isFinite(price)
      ? (price - position.entry) *
        (position.side === "buy" ? 1 : -1) *
        position.lots *
        CONTRACT
      : NaN;

  const calcSetup = () => {
    const live = Number.isFinite(lastPrice) ? lastPrice : readPrice();
    const entry = elEntry.value.trim() ? Number(elEntry.value) : live;
    const sl = elSl.value.trim() ? Number(elSl.value) : NaN;
    if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry === sl) return null;
    const dist = Math.abs(entry - sl);
    const riskUsd = (ui.balance * ui.riskPct) / 100;
    const lots = Math.max(0.01, Math.floor((riskUsd / (dist * CONTRACT)) * 100) / 100);
    const side = sl < entry ? "buy" : "sell";
    const tp = Math.round((entry + (side === "buy" ? 1 : -1) * dist * ui.rr) * 100) / 100;
    return { entry, sl, dist, riskUsd, lots, side, tp };
  };

  const updateCalc = () => {
    const c = calcSetup();
    elCalc.textContent = c
      ? `${c.side === "buy" ? "AL" : "SAT"} · Lot ${c.lots.toFixed(2)} · Risk $${c.riskUsd.toFixed(2)} · SL mesafe ${fmt(c.dist)} · TP ${fmt(c.tp)}`
      : "Stop gir: lot ve hedef otomatik hesaplanır";
  };

  const anyFired = () => alerts.some((a) => a.fired);
  const isAlerted = () => anyFired() || !!ringTimer;

  const dirIcon = { auto: "↕", up: "↑", down: "↓" };
  const dirTitle = {
    auto: "Yön: her iki yön (değiştir)",
    up: "Yön: yukarı kesişim (değiştir)",
    down: "Yön: aşağı kesişim (değiştir)",
  };

  const editNote = (a) => {
    const answer = prompt(`${fmt(a.price)} seviyesi için not:`, a.note);
    if (answer === null) return;
    a.note = answer.trim().slice(0, 24);
    saveAlerts();
    render(readPrice());
  };

  const buildRow = (a) => {
    const row = document.createElement("div");
    row.className = "item" + (a.fired ? " fired" : "");

    const left = document.createElement("span");
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.dataset.arrow = "";
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = fmt(a.price);
    val.title = "Not eklemek için çift tıkla";
    val.addEventListener("dblclick", () => editNote(a));
    left.append(arrow, val);
    if (a.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = a.note;
      left.appendChild(note);
    }

    const diff = document.createElement("span");
    diff.className = "diff";
    diff.dataset.diff = "";

    const ctl = document.createElement("span");
    ctl.className = "ctl";

    const dirBtn = document.createElement("button");
    dirBtn.textContent = dirIcon[a.dir];
    dirBtn.title = dirTitle[a.dir];
    dirBtn.classList.toggle("on", a.dir !== "auto");
    dirBtn.addEventListener("click", () => {
      a.dir = DIRS[(DIRS.indexOf(a.dir) + 1) % DIRS.length];
      armAlert(a, readPrice());
      saveAlerts();
      render(readPrice());
    });

    const repBtn = document.createElement("button");
    repBtn.textContent = "↻";
    repBtn.title = a.repeat ? "Tekrar: açık" : "Tekrar: kapalı (tek seferlik)";
    repBtn.classList.toggle("on", a.repeat);
    repBtn.addEventListener("click", () => {
      a.repeat = !a.repeat;
      if (a.repeat && a.fired) armAlert(a, readPrice());
      saveAlerts();
      render(readPrice());
    });

    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Sil";
    del.addEventListener("click", () => {
      alerts = alerts.filter((x) => x !== a);
      saveAlerts();
      if (!anyFired()) silence();
      render(readPrice());
    });

    ctl.append(dirBtn, repBtn, del);
    row.append(left, diff, ctl);
    row._alert = a;
    return row;
  };

  const render = (price) => {
    if (ui.hidden) {
      // Gizliyken sadece dock'u güncelle.
      dock.textContent = Number.isFinite(price) ? `XAU ${fmt(price)}` : "XAU";
      dock.classList.toggle("alerted", isAlerted());
      return;
    }

    const hasPrice = Number.isFinite(price);
    elPrice.textContent = hasPrice ? fmt(price) : "—";
    elMini.textContent = hasPrice ? fmt(price) : "";
    dock.textContent = hasPrice ? `XAU ${fmt(price)}` : "XAU";
    elRange.textContent =
      Number.isFinite(sessionHi) && Number.isFinite(sessionLo)
        ? `Oturum  Y ${fmt(sessionHi)}  ·  D ${fmt(sessionLo)}`
        : "";

    elClock.textContent = clockText();
    if (position) {
      const pl = positionPnl(price);
      elPos.textContent =
        `${position.side === "buy" ? "AL" : "SAT"} ${position.lots.toFixed(2)} @ ${fmt(position.entry)}  ` +
        (Number.isFinite(pl) ? fmtUsd(pl) : "—") +
        (ui.trades ? `  ·  Gün ${fmtUsd(ui.realized)}` : "");
      elPos.className = "pos " + (pl >= 0 ? "up" : "down");
    } else {
      elPos.textContent = ui.trades
        ? `Gün ${fmtUsd(ui.realized)} · ${ui.trades} işlem`
        : "";
      elPos.className = "pos";
    }
    if (ui.scalpOpen) updateCalc();

    const sorted = [...alerts].sort((a, b) => b.price - a.price);
    const signature = sorted
      .map((a) => `${a.price}:${a.fired}:${a.dir}:${a.repeat}:${a.note}`)
      .join("|");

    if (signature !== listSignature) {
      listSignature = signature;
      elList.textContent = "";

      if (!sorted.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "Seviye yok";
        elList.appendChild(e);
      }

      sorted.forEach((a) => elList.appendChild(buildRow(a)));
    }

    [...elList.querySelectorAll(".item")].forEach((row) => {
      const a = row._alert;
      const arrowEl = row.querySelector("[data-arrow]");
      const diffEl = row.querySelector("[data-diff]");
      arrowEl.textContent = a.fired
        ? "!"
        : a.side === "below"
          ? "↑"
          : a.side === "above"
            ? "↓"
            : "·";
      if (hasPrice) {
        const d = price - a.price;
        diffEl.textContent = (d >= 0 ? "+" : "−") + fmt(Math.abs(d));
      } else {
        diffEl.textContent = "—";
      }
    });

    panel.classList.toggle("alerted", isAlerted());
    dock.classList.toggle("alerted", isAlerted());

    const stale = Date.now() - lastChangeTs;
    if (Date.now() < flashUntil) elStatus.textContent = flashMsg;
    else if (!hasPrice) elStatus.textContent = "Fiyat okunamıyor";
    else if (anyFired()) elStatus.textContent = "Hedefe ulaşıldı";
    else if (!alerts.length) elStatus.textContent = "Seviye ekle";
    else if (stale > STALE_MS)
      elStatus.textContent = `Fiyat ${Math.round(stale / 60000)} dk'dır değişmedi`;
    else if (!soundOn)
      elStatus.textContent = ui.soundPref
        ? "Takip aktif · sesi açmak için sayfaya tıkla"
        : "Takip aktif · ses kapalı";
    else elStatus.textContent = "Takip aktif";

    renderHistory();
  };

  // --- Ses / bildirim ---
  const tone = (freq, t0, dur, vol = 0.5) => {
    if (!audio || audio.state !== "running") return;
    const v = Math.max(0.001, vol * ui.volume);
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.015);
    g.gain.setValueAtTime(v, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audio.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  };

  const beep = (cycles = 1, up = null) => {
    if (!audio) return;
    const t0 = audio.currentTime + 0.03;
    const freqs =
      up === true
        ? [900, 1200, 1500, 1800]
        : up === false
          ? [1800, 1500, 1200, 900]
          : [1100, 1500, 1100, 1500];
    for (let c = 0; c < cycles; c++) {
      freqs.forEach((f, i) =>
        tone(f, t0 + c * 1.05 + i * 0.22, 0.18, 0.6),
      );
    }
  };

  const baseTitle = () => document.title.split(TITLE_PREFIX).join("");

  const startBlink = () => {
    if (blinkTimer) return;
    let on = false;
    blinkTimer = setInterval(() => {
      on = !on;
      document.title = on ? TITLE_PREFIX + baseTitle() : baseTitle();
    }, 800);
  };

  const stopBlink = () => {
    if (!blinkTimer) return;
    clearInterval(blinkTimer);
    blinkTimer = null;
    document.title = baseTitle();
  };

  const startRinging = (up = null) => {
    clearInterval(ringTimer);
    ringCount = 0;
    btnSilence.style.display = "block";
    ringTimer = setInterval(() => {
      if (++ringCount >= ui.ringMax) {
        silence();
        return;
      }
      beep(1, up);
    }, RING_EVERY_MS);
  };

  function silence() {
    clearInterval(ringTimer);
    ringTimer = null;
    stopBlink();
    btnSilence.style.display = "none";
    if (!stopped) render(readPrice());
  }

  // Site bildirimi izinli değilse Tampermonkey bildirimine düşer.
  const desktopNotify = (body, title = "XAU/USD alarm") => {
    let shown = false;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(title, { body, requireInteraction: true });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        shown = true;
      }
    } catch (_) {
      /* site bildirimi desteklenmiyor */
    }
    if (shown) return;
    try {
      GM_notification({
        title,
        text: body,
        timeout: 0,
        onclick: () => window.focus(),
      });
    } catch (_) {
      /* Tampermonkey bildirimi desteklenmiyor */
    }
  };

  const pushPhone = (text, test = false) => {
    if (!ntfyTopic) {
      if (test) flash("Önce telefon konusu ayarla");
      return;
    }
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: `https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`,
        headers: { Title: "XAU/USD Alarm", Priority: "high" },
        data: text,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            if (test) flash("Test bildirimi gönderildi");
          } else {
            flash(`Telefon bildirimi hatası (${r.status})`, 8000);
          }
        },
        onerror: () => flash("Telefon bildirimi gönderilemedi", 8000),
        ontimeout: () => flash("Telefon bildirimi zaman aşımı", 8000),
        timeout: 10000,
      });
    } catch (e) {
      console.error("Telefon bildirimi gönderilemedi:", e);
      flash("Telefon bildirimi gönderilemedi", 8000);
    }
  };

  const alarm = (text, up = null) => {
    console.warn(`[XAU/USD] ${text}`);
    beep(3, up);
    startRinging(up);
    startBlink();
    desktopNotify(text);
    pushPhone(text);
  };

  // --- Ekran uyanık tutma ---
  const updateWakeLock = async () => {
    try {
      if (ui.wakeLock && !wakeLock && "wakeLock" in navigator) {
        if (document.visibilityState !== "visible") return;
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
        });
      } else if (!ui.wakeLock && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (_) {
      wakeLock = null;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") updateWakeLock();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // --- Alarm mantığı ---
  const armAlert = (a, price) => {
    a.fired = false;
    a.pending = 0;
    a.side = Number.isFinite(price)
      ? price < a.price
        ? "below"
        : "above"
      : null;
  };

  const fire = (a, price) => {
    history.push({ t: Date.now(), target: a.price, price, note: a.note });
    history = history.slice(-HISTORY_MAX);
    saveHistory();

    if (a.repeat) armAlert(a, price);
    else a.fired = true;
    a.pending = 0;
    saveAlerts();

    alarm(
      `${a.tag ? a.tag.toUpperCase() + " · " : ""}Hedef ${fmt(a.price)} · Fiyat ${fmt(price)}` +
        (a.note && !a.tag ? ` · ${a.note}` : ""),
      price >= a.price,
    );
  };

  const checkAlert = (a, price) => {
    if (a.fired) return;
    if (a.side === null) {
      armAlert(a, price);
      return;
    }

    const crossedUp = a.side === "below" && price >= a.price;
    const crossedDown = a.side === "above" && price <= a.price;

    if (!crossedUp && !crossedDown) {
      a.pending = 0;
      return;
    }

    const allowed =
      a.dir === "auto" || (a.dir === "up" ? crossedUp : crossedDown);

    if (!allowed) {
      // İstenmeyen yönde kesişti; yeni tarafı kaydet ki geri dönüşte yakalansın.
      a.pending = 0;
      if (crossedUp && price > a.price) a.side = "above";
      if (crossedDown && price < a.price) a.side = "below";
      return;
    }

    a.pending++;
    if (a.pending >= CONFIRM_TICKS) fire(a, price);
  };

  const tick = () => {
    if (stopped) return;
    let price = readPrice();

    if (
      Number.isFinite(price) &&
      Number.isFinite(lastPrice) &&
      Math.abs(price - lastPrice) / lastPrice > MAX_JUMP
    ) {
      // Büyük sıçrama: aynı yeni değer sürerse (sembol değişimi) kabul et.
      if (price === jumpCand) jumpCount++;
      else {
        jumpCand = price;
        jumpCount = 1;
      }
      if (jumpCount >= JUMP_ACCEPT) {
        lastPrice = NaN;
        sessionHi = sessionLo = NaN;
        ticks = [];
        jumpCand = NaN;
        jumpCount = 0;
        alerts.forEach((a) => {
          if (!a.fired) armAlert(a, price);
        });
      } else {
        priceEl = null;
        price = NaN;
      }
    } else {
      jumpCount = 0;
    }

    if (Number.isFinite(price)) {
      for (const a of alerts) checkAlert(a, price);

      const nowTs = Date.now();
      if (!ticks.length || ticks[ticks.length - 1].p !== price) {
        ticks.push({ t: nowTs, p: price });
      }
      while (ticks.length && nowTs - ticks[0].t > FAST_WINDOW_MS) ticks.shift();
      if (ui.fastOn && nowTs - lastFast > FAST_WINDOW_MS && ticks.length > 1) {
        const hi = Math.max(...ticks.map((x) => x.p));
        const lo = Math.min(...ticks.map((x) => x.p));
        if (hi - lo >= ui.fastMove) {
          lastFast = nowTs;
          const up = price >= ticks[0].p;
          alarm(
            `Hızlı hareket ${up ? "↑" : "↓"} ${fmt(hi - lo)} / 60 sn · Fiyat ${fmt(price)}`,
            up,
          );
        }
      }

      if (price !== lastPrice) lastChangeTs = nowTs;
      sessionHi = Number.isFinite(sessionHi) ? Math.max(sessionHi, price) : price;
      sessionLo = Number.isFinite(sessionLo) ? Math.min(sessionLo, price) : price;

      const dirClass =
        Number.isFinite(lastPrice) && price !== lastPrice
          ? price > lastPrice
            ? "up"
            : "down"
          : null;
      if (dirClass) {
        elPrice.classList.remove("up", "down");
        elPrice.classList.add(dirClass);
      }
      lastPrice = price;
    }

    render(price);
    observe();
  };

  // Fiyat öğesi değişince hemen kontrol et (yedek olarak zamanlayıcı da var).
  const observer = new MutationObserver(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      tick();
    });
  });

  function observe() {
    if (!priceEl || priceEl === observedEl) return;
    observer.disconnect();
    observer.observe(priceEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    observedEl = priceEl;
  }

  // --- Olaylar ---
  // "2350", "2350 destek", "+10", "-0,5%" biçimlerini çözer.
  const parseInput = (raw) => {
    const text = raw.trim();
    if (!text) return null;
    const rel = text.match(/^([+-])\s*([\d.,]+)\s*(%?)\s*(.*)$/);
    if (rel) {
      const base = Number.isFinite(lastPrice) ? lastPrice : readPrice();
      const amount = parsePrice(rel[2]);
      if (!Number.isFinite(base) || !Number.isFinite(amount)) return null;
      const delta = rel[3] ? (base * amount) / 100 : amount;
      const price = Math.round((base + (rel[1] === "-" ? -delta : delta)) * 1000) / 1000;
      return { price, note: rel[4].trim() };
    }
    const m = text.match(/^([\d.,]+)\s*(.*)$/);
    if (!m) return null;
    return { price: parsePrice(m[1]), note: m[2].trim() };
  };

  const addAlert = () => {
    const parsed = parseInput(elNew.value);
    if (!parsed || !Number.isFinite(parsed.price) || parsed.price <= 0) {
      flash("Geçersiz seviye");
      return;
    }
    const existing = alerts.find((a) => a.price === parsed.price);
    if (existing) {
      if (parsed.note) existing.note = parsed.note.slice(0, 24);
      if (existing.fired) armAlert(existing, readPrice());
      saveAlerts();
      elNew.value = "";
      render(readPrice());
      return;
    }

    const a = newAlert(parsed.price, { note: parsed.note.slice(0, 24) });
    armAlert(a, readPrice());
    alerts.push(a);
    saveAlerts();
    elNew.value = "";
    render(readPrice());
  };

  btnAdd.addEventListener("click", addAlert);
  elNew.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") addAlert();
  });
  elNew.addEventListener("keyup", (e) => e.stopPropagation());

  const enableSound = async (quiet = false) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audio ??= new AC();
      await audio.resume();
      if (audio.state !== "running") throw new Error("Ses bağlamı çalışmıyor");
      soundOn = true;
      ui.soundPref = true;
      saveUi();
      applyUi();

      if (!quiet) {
        const t0 = audio.currentTime + 0.03;
        tone(1000, t0, 0.2, 0.4);
        tone(1500, t0 + 0.28, 0.2, 0.4);

        if ("Notification" in window && Notification.permission === "default") {
          Notification.requestPermission();
        }
      }
      updateWakeLock();
      render(readPrice());
      return true;
    } catch (e) {
      console.error("Ses başlatılamadı:", e);
      flash("Ses başlatılamadı");
      return false;
    }
  };

  const disableSound = () => {
    soundOn = false;
    ui.soundPref = false;
    saveUi();
    silence();
    applyUi();
    render(readPrice());
  };

  btnSound.addEventListener("click", () => {
    if (soundOn) disableSound();
    else enableSound();
  });

  // Önceden ses açıksa, tarayıcı kuralı gereği ilk etkileşimde otomatik aç.
  const autoResume = (e) => {
    if (soundOn || !ui.soundPref || e.target.closest?.("#xau-panel, .xau-pop")) return;
    enableSound(true);
  };
  if (ui.soundPref) {
    document.addEventListener("pointerdown", autoResume, true);
    document.addEventListener("keydown", autoResume, true);
  }

  btnPhone.addEventListener("click", () => {
    const answer = prompt(
      "ntfy konu adı (telefonda ntfy uygulamasında bu konuya abone ol).\n" +
        "Tahmin edilmesi zor bir isim seç. Boş bırakırsan kapanır:",
      ntfyTopic,
    );
    if (answer === null) return;
    ntfyTopic = answer.trim();
    GM_setValue(KEY_NTFY, ntfyTopic);
    btnPhone.classList.toggle("on", !!ntfyTopic);
  });

  $("[data-testpush]").addEventListener("click", () =>
    pushPhone("Test bildirimi", true),
  );

  btnNotif.addEventListener("click", async () => {
    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (_) {
        /* izin istenemedi */
      }
    }
    applyUi();
    desktopNotify("Test bildirimi");
    if (!("Notification" in window) || Notification.permission === "denied") {
      flash(
        "Site bildirimi engelli, Tampermonkey bildirimi kullanılıyor. Site için açmak: adres çubuğu kilit simgesi > Bildirimler > İzin ver",
        10000,
      );
    }
  });

  btnFast.addEventListener("click", () => {
    ui.fastOn = !ui.fastOn;
    ticks = [];
    saveUi();
    applyUi();
  });
  elFastMove.addEventListener("change", () => {
    ui.fastMove = Number(elFastMove.value) > 0 ? Number(elFastMove.value) : 5;
    elFastMove.value = ui.fastMove;
    saveUi();
  });

  btnScalp.addEventListener("click", () => {
    ui.scalpOpen = !ui.scalpOpen;
    saveUi();
    applyUi();
    if (ui.scalpOpen) updateCalc();
  });

  elClock.addEventListener("click", () => {
    ui.tf = TFS[(TFS.indexOf(ui.tf) + 1) % TFS.length];
    saveUi();
    elClock.textContent = clockText();
  });

  panel.querySelectorAll("[data-q]").forEach((b) =>
    b.addEventListener("click", () => {
      elNew.value = b.dataset.q;
      addAlert();
    }),
  );

  const closePosition = () => {
    if (!position) return;
    const price = Number.isFinite(lastPrice) ? lastPrice : readPrice();
    const pl = positionPnl(price);
    rollDay();
    if (Number.isFinite(pl)) {
      ui.realized += pl;
      ui.trades++;
      saveUi();
    }
    position = null;
    GM_setValue(KEY_POS, null);
    alerts = alerts.filter((a) => !a.tag);
    saveAlerts();
    if (!anyFired()) silence();
    flash(Number.isFinite(pl) ? `Pozisyon kapandı ${fmtUsd(pl)}` : "Pozisyon kapandı");
    render(readPrice());
  };

  const openPosition = (side) => {
    const c = calcSetup();
    if (!c) {
      flash("Stop (SL) gir");
      return;
    }
    if (c.side !== side) {
      flash(
        side === "buy"
          ? "Al için SL girişin altında olmalı"
          : "Sat için SL girişin üstünde olmalı",
      );
      return;
    }
    if (position) closePosition();
    position = { side, entry: c.entry, lots: c.lots, sl: c.sl, tp: c.tp };
    GM_setValue(KEY_POS, position);

    alerts = alerts.filter((a) => !a.tag);
    const p = readPrice();
    [
      ["sl", c.sl],
      ["tp", c.tp],
    ].forEach(([tag, price]) => {
      if (alerts.some((x) => x.price === price)) return;
      const a = newAlert(price, { tag, note: tag.toUpperCase() });
      armAlert(a, p);
      alerts.push(a);
    });
    saveAlerts();
    flash(`${side === "buy" ? "AL" : "SAT"} ${c.lots.toFixed(2)} lot · SL/TP alarmları kuruldu`);
    render(p);
  };

  $("[data-buy]").addEventListener("click", () => openPosition("buy"));
  $("[data-sell]").addEventListener("click", () => openPosition("sell"));
  $("[data-close]").addEventListener("click", closePosition);

  const bindNum = (el, key) =>
    el.addEventListener("input", () => {
      if (Number(el.value) > 0) ui[key] = Number(el.value);
      saveUi();
      updateCalc();
    });
  bindNum(elBalance, "balance");
  bindNum(elRisk, "riskPct");
  bindNum(elRr, "rr");
  [elEntry, elSl].forEach((el) => el.addEventListener("input", updateCalc));
  [elBalance, elRisk, elEntry, elSl, elRr].forEach((el) => {
    el.addEventListener("keydown", (e) => e.stopPropagation());
    el.addEventListener("keyup", (e) => e.stopPropagation());
  });

  $("[data-testsound]").addEventListener("click", async () => {
    if (!audio || audio.state !== "running") {
      if (!(await enableSound(true))) return;
    }
    beep(1);
  });

  $("[data-clearhist]").addEventListener("click", () => {
    history = [];
    saveHistory();
    renderHistory();
  });

  elVolume.addEventListener("input", () => {
    ui.volume = clamp(Number(elVolume.value) || 0.6, 0.1, 1);
    saveUi();
  });
  elRingMax.addEventListener("change", () => {
    ui.ringMax = clamp(Math.round(Number(elRingMax.value)) || 10, 1, 60);
    elRingMax.value = ui.ringMax;
    saveUi();
  });
  [elVolume, elRingMax, elFastMove].forEach((el) => {
    el.addEventListener("keydown", (e) => e.stopPropagation());
  });

  btnWake.addEventListener("click", () => {
    ui.wakeLock = !ui.wakeLock;
    saveUi();
    applyUi();
    updateWakeLock();
    if (ui.wakeLock && !("wakeLock" in navigator)) {
      flash("Tarayıcı ekran kilidini desteklemiyor");
    }
  });

  popScalp.querySelector("[data-popclose]").addEventListener("click", () => {
    ui.scalpOpen = false;
    saveUi();
    applyUi();
  });
  popSet.querySelector("[data-popclose]").addEventListener("click", () => {
    ui.settingsOpen = false;
    saveUi();
    applyUi();
  });
  makePopDraggable(popScalp, "scalp");
  makePopDraggable(popSet, "settings");

  btnGear.addEventListener("click", () => {
    ui.settingsOpen = !ui.settingsOpen;
    saveUi();
    applyUi();
  });

  btnReset.addEventListener("click", () => {
    silence();
    const p = readPrice();
    alerts.forEach((a) => armAlert(a, p));
    saveAlerts();
    sessionHi = sessionLo = Number.isFinite(p) ? p : NaN;
    listSignature = "";
    render(p);
  });

  btnSilence.addEventListener("click", silence);

  btnMin.addEventListener("click", () => {
    ui.minimized = !ui.minimized;
    saveUi();
    applyUi();
  });

  $("[data-hide]").addEventListener("click", () => setHidden(true));
  dock.addEventListener("click", () => setHidden(false));

  // Alt+X ile paneli göster/gizle.
  const onKey = (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyX") {
      e.preventDefault();
      setHidden(!ui.hidden);
    }
  };
  window.addEventListener("keydown", onKey, true);

  try {
    GM_registerMenuCommand("Paneli göster/gizle", () => setHidden(!ui.hidden));
  } catch (_) {
    /* menü desteklenmiyor */
  }

  // Sürükleme
  let drag = null;
  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = `${clamp(e.clientX - drag.dx, 8, Math.max(8, window.innerWidth - r.width - 8))}px`;
    panel.style.top = `${clamp(e.clientY - drag.dy, 8, Math.max(8, window.innerHeight - r.height - 8))}px`;
  });
  const endDrag = () => {
    if (drag) {
      drag = null;
      saveGeometry();
    }
  };
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);
  header.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    ui.minimized = !ui.minimized;
    saveUi();
    applyUi();
  });

  function onResize() {
    if (ui.hidden) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = `${clamp(r.left, 8, Math.max(8, window.innerWidth - r.width - 8))}px`;
    panel.style.top = `${clamp(r.top, 8, Math.max(8, window.innerHeight - r.height - 8))}px`;
  }
  window.addEventListener("resize", onResize);

  const timer = setInterval(tick, 1000);

  window.__xauAlarmStop = () => {
    stopped = true;
    clearInterval(timer);
    silence();
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointerdown", autoResume, true);
    document.removeEventListener("keydown", autoResume, true);
    wakeLock?.release?.().catch?.(() => {});
    panel.remove();
    popScalp.remove();
    popSet.remove();
    dock.remove();
    style.remove();
    if (audio && audio.state !== "closed") audio.close();
    delete window.__xauAlarmStop;
  };

  // Başlangıç: kalıcı arayüz durumunu uygula, kayıtlı seviyeleri mevcut fiyata göre kur.
  applyUi();
  const first = readPrice();
  alerts.forEach((a) => {
    if (!a.fired) armAlert(a, first);
  });
  tick();
})();
