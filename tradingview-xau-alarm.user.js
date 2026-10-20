// ==UserScript==
// @name         XAU/USD Alarm
// @namespace    local.xau.price.alarm
// @version      4.0.0
// @description  Çoklu seviye, geçmiş, bildirim ve telefon push destekli minimal altın alarmı
// @match        https://*.tradingview.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// ==/UserScript==

(() => {
  "use strict";

  window.__xauAlarmStop?.();

  const PRICE_SELECTOR = '[data-qa-id="value"]';
  const KEY_ALERTS = "xauAlerts";
  const KEY_OLD_TARGET = "xauTarget";
  const KEY_GEOMETRY = "xauPanelGeometry3";
  const KEY_HISTORY = "xauHistory";
  const KEY_NTFY = "xauNtfyTopic";
  const CONFIRM_TICKS = 2;
  const MAX_JUMP = 0.03;
  const RING_EVERY_MS = 6000;
  const RING_MAX = 10;

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
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });

  const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

  // --- Kayıtlı veriler ---
  let alerts = [];
  const storedAlerts = GM_getValue(KEY_ALERTS, null);
  if (Array.isArray(storedAlerts)) {
    alerts = storedAlerts
      .map((p) => ({ price: Number(p), side: null, pending: 0, fired: false }))
      .filter((a) => Number.isFinite(a.price) && a.price > 0);
  } else {
    const old = Number(GM_getValue(KEY_OLD_TARGET, NaN));
    if (Number.isFinite(old) && old > 0) {
      alerts.push({ price: old, side: null, pending: 0, fired: false });
    }
  }

  let history = GM_getValue(KEY_HISTORY, []);
  if (!Array.isArray(history)) history = [];
  let ntfyTopic = String(GM_getValue(KEY_NTFY, "") || "");

  const saveAlerts = () =>
    GM_setValue(
      KEY_ALERTS,
      alerts.map((a) => a.price),
    );

  let audio = null;
  let soundOn = false;
  let stopped = false;
  let lastPrice = NaN;
  let priceEl = null;
  let observedEl = null;
  let ringTimer = null;
  let ringCount = 0;
  let blinkTimer = null;
  let originalTitle = document.title;
  let rafPending = false;
  let listSignature = "";

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
    #xau-panel, #xau-panel * { box-sizing: border-box; }
    #xau-panel {
      position: fixed; z-index: 2147483647;
      width: 250px;
      background: #151515; color: #e6e6e6;
      border: 1px solid #2c2c2c; border-radius: 6px;
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      overflow: hidden;
    }
    #xau-panel.alerted { border-color: #c0392b; }
    #xau-panel .h {
      display: flex; justify-content: space-between; align-items: center;
      padding: 7px 10px; cursor: move; user-select: none;
      border-bottom: 1px solid #2c2c2c; color: #8a8a8a;
    }
    #xau-panel .h button {
      all: unset; cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1;
    }
    #xau-panel .h button:hover { color: #fff; }
    #xau-panel .b { padding: 10px; display: grid; gap: 8px; }
    #xau-panel .price {
      font-size: 24px; font-weight: 600; letter-spacing: -.3px;
      font-variant-numeric: tabular-nums;
    }
    #xau-panel .list { display: grid; gap: 2px; }
    #xau-panel .item {
      display: grid; grid-template-columns: 1fr auto auto; gap: 8px;
      align-items: center; padding: 3px 0;
      border-bottom: 1px solid #222; font-variant-numeric: tabular-nums;
    }
    #xau-panel .item .arrow { color: #8a8a8a; margin-right: 4px; }
    #xau-panel .item .diff { color: #8a8a8a; }
    #xau-panel .item.fired { color: #e74c3c; }
    #xau-panel .item.fired .diff, #xau-panel .item.fired .arrow { color: #e74c3c; }
    #xau-panel .item button {
      all: unset; cursor: pointer; color: #666; padding: 0 3px; font-size: 14px; line-height: 1;
    }
    #xau-panel .item button:hover { color: #fff; }
    #xau-panel .empty { color: #666; padding: 3px 0; }
    #xau-panel .add { display: flex; gap: 6px; }
    #xau-panel input {
      flex: 1; min-width: 0; background: #0e0e0e; color: #e6e6e6;
      border: 1px solid #2c2c2c; border-radius: 4px;
      padding: 4px 6px; font: inherit;
      font-variant-numeric: tabular-nums;
    }
    #xau-panel input:focus { outline: none; border-color: #555; }
    #xau-panel .status { color: #8a8a8a; min-height: 17px; }
    #xau-panel.alerted .status { color: #e74c3c; }
    #xau-panel .btns { display: flex; gap: 6px; }
    #xau-panel .btn {
      all: unset; flex: 1; text-align: center; cursor: pointer;
      padding: 5px 0; border: 1px solid #2c2c2c; border-radius: 4px; color: #cfcfcf;
    }
    #xau-panel .btn:hover { background: #202020; }
    #xau-panel .btn.on { color: #fff; border-color: #555; }
    #xau-panel .btn.silence { display: none; color: #e74c3c; border-color: #6b2a24; }
    #xau-panel .hist { color: #666; font-size: 11px; display: grid; gap: 1px;
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
  panel.style.left = `${clamp(Number(saved.x) || window.innerWidth - 274, 8, Math.max(8, window.innerWidth - 258))}px`;
  panel.style.top = `${clamp(Number(saved.y) || 24, 8, Math.max(8, window.innerHeight - 220))}px`;

  panel.innerHTML = `
    <div class="h"><span>XAU/USD</span><button data-hide title="Gizle">×</button></div>
    <div class="b">
      <div class="price" data-price>—</div>
      <div class="list" data-list></div>
      <div class="add">
        <input data-new inputmode="decimal" placeholder="Yeni seviye">
        <button class="btn" data-add style="flex:0 0 52px">Ekle</button>
      </div>
      <div class="status" data-status></div>
      <div class="btns">
        <button class="btn" data-sound>Ses kapalı</button>
        <button class="btn" data-phone>Telefon</button>
        <button class="btn" data-reset>Sıfırla</button>
      </div>
      <div class="btns"><button class="btn silence" data-silence>Sustur</button></div>
      <div class="hist" data-hist></div>
    </div>`;

  const dock = document.createElement("button");
  dock.id = "xau-dock";
  document.body.append(panel, dock);

  const $ = (s) => panel.querySelector(s);
  const header = $(".h");
  const elPrice = $("[data-price]");
  const elList = $("[data-list]");
  const elNew = $("[data-new]");
  const elStatus = $("[data-status]");
  const elHist = $("[data-hist]");
  const btnAdd = $("[data-add]");
  const btnSound = $("[data-sound]");
  const btnPhone = $("[data-phone]");
  const btnReset = $("[data-reset]");
  const btnSilence = $("[data-silence]");

  const saveGeometry = () => {
    if (panel.style.display === "none") return;
    const r = panel.getBoundingClientRect();
    GM_setValue(KEY_GEOMETRY, { x: Math.round(r.left), y: Math.round(r.top) });
  };

  const timeStr = (ts) =>
    new Date(ts).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });

  const renderHistory = () => {
    elHist.textContent = "";
    history
      .slice(-3)
      .reverse()
      .forEach((h) => {
        const d = document.createElement("div");
        d.textContent = `${timeStr(h.t)}  ${fmt(h.target)}  →  ${fmt(h.price)}`;
        elHist.appendChild(d);
      });
  };

  const anyFired = () => alerts.some((a) => a.fired);

  const render = (price) => {
    const hasPrice = Number.isFinite(price);
    elPrice.textContent = hasPrice ? fmt(price) : "—";
    dock.textContent = hasPrice ? `XAU ${fmt(price)}` : "XAU";

    const sorted = [...alerts].sort((a, b) => b.price - a.price);
    const signature = sorted.map((a) => `${a.price}:${a.fired}`).join("|");

    if (signature !== listSignature) {
      listSignature = signature;
      elList.textContent = "";

      if (!sorted.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "Seviye yok";
        elList.appendChild(e);
      }

      sorted.forEach((a) => {
        const row = document.createElement("div");
        row.className = "item" + (a.fired ? " fired" : "");

        const left = document.createElement("span");
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.dataset.arrow = "";
        const val = document.createElement("span");
        val.textContent = fmt(a.price);
        left.append(arrow, val);

        const diff = document.createElement("span");
        diff.className = "diff";
        diff.dataset.diff = "";

        const del = document.createElement("button");
        del.textContent = "×";
        del.title = "Sil";
        del.addEventListener("click", () => {
          alerts = alerts.filter((x) => x !== a);
          saveAlerts();
          if (!anyFired()) silence();
          render(readPrice());
        });

        row.append(left, diff, del);
        row._alert = a;
        elList.appendChild(row);
      });
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

    panel.classList.toggle("alerted", anyFired());
    dock.classList.toggle("alerted", anyFired());

    if (!hasPrice) elStatus.textContent = "Fiyat okunamıyor";
    else if (anyFired()) elStatus.textContent = "Hedefe ulaşıldı";
    else if (!alerts.length) elStatus.textContent = "Seviye ekle";
    else if (!soundOn) elStatus.textContent = "Alarm için sesi aç";
    else elStatus.textContent = "Takip aktif";

    renderHistory();
  };

  // --- Ses / bildirim ---
  const tone = (freq, t0, dur, vol = 0.5) => {
    if (!audio || audio.state !== "running") return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.setValueAtTime(vol, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audio.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  };

  const beep = (cycles = 1) => {
    if (!audio) return;
    const t0 = audio.currentTime + 0.03;
    for (let c = 0; c < cycles; c++) {
      [1100, 1500, 1100, 1500].forEach((f, i) =>
        tone(f, t0 + c * 1.05 + i * 0.22, 0.18, 0.6),
      );
    }
  };

  const startBlink = () => {
    if (blinkTimer) return;
    originalTitle = document.title;
    let on = false;
    blinkTimer = setInterval(() => {
      on = !on;
      document.title = on ? "!! XAU ALARM" : originalTitle;
    }, 800);
  };

  const stopBlink = () => {
    if (!blinkTimer) return;
    clearInterval(blinkTimer);
    blinkTimer = null;
    document.title = originalTitle;
  };

  const startRinging = () => {
    clearInterval(ringTimer);
    ringCount = 0;
    btnSilence.style.display = "block";
    ringTimer = setInterval(() => {
      if (++ringCount >= RING_MAX) {
        silence();
        return;
      }
      beep(1);
    }, RING_EVERY_MS);
  };

  function silence() {
    clearInterval(ringTimer);
    ringTimer = null;
    stopBlink();
    btnSilence.style.display = "none";
  }

  const browserNotify = (target, price) => {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("XAU/USD alarm", {
          body: `Hedef ${fmt(target)} · Fiyat ${fmt(price)}`,
        });
      }
    } catch (_) {
      /* bildirim desteklenmiyor */
    }
  };

  const pushPhone = (target, price) => {
    if (!ntfyTopic) return;
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: `https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`,
        headers: { Title: "XAU/USD Alarm", Priority: "high" },
        data: `Hedef ${fmt(target)} - Fiyat ${fmt(price)}`,
      });
    } catch (e) {
      console.error("Telefon bildirimi gönderilemedi:", e);
    }
  };

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
    a.fired = true;
    history.push({ t: Date.now(), target: a.price, price });
    history = history.slice(-20);
    GM_setValue(KEY_HISTORY, history);

    console.warn(`[XAU/USD] Hedef ${fmt(a.price)} · Fiyat ${fmt(price)}`);
    beep(3);
    startRinging();
    startBlink();
    browserNotify(a.price, price);
    pushPhone(a.price, price);
  };

  const tick = () => {
    if (stopped) return;
    let price = readPrice();

    if (
      Number.isFinite(price) &&
      Number.isFinite(lastPrice) &&
      Math.abs(price - lastPrice) / lastPrice > MAX_JUMP
    ) {
      priceEl = null;
      price = NaN;
    }

    if (Number.isFinite(price) && soundOn) {
      for (const a of alerts) {
        if (a.fired) continue;
        if (a.side === null) {
          armAlert(a, price);
          continue;
        }

        const crossed =
          (a.side === "below" && price >= a.price) ||
          (a.side === "above" && price <= a.price);

        a.pending = crossed ? a.pending + 1 : 0;
        if (a.pending >= CONFIRM_TICKS) fire(a, price);
      }
    }

    if (Number.isFinite(price)) lastPrice = price;
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
  const addAlert = () => {
    const v = parsePrice(elNew.value);
    if (!Number.isFinite(v) || v <= 0) return;
    if (alerts.some((a) => a.price === v)) {
      elNew.value = "";
      return;
    }

    const a = { price: v, side: null, pending: 0, fired: false };
    armAlert(a, readPrice());
    alerts.push(a);
    saveAlerts();
    elNew.value = "";
    render(readPrice());
  };

  btnAdd.addEventListener("click", addAlert);
  elNew.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addAlert();
  });

  btnSound.addEventListener("click", async () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audio ??= new AC();
      await audio.resume();
      soundOn = true;
      btnSound.textContent = "Ses açık";
      btnSound.classList.add("on");

      const t0 = audio.currentTime + 0.03;
      tone(1000, t0, 0.2, 0.4);
      tone(1500, t0 + 0.28, 0.2, 0.4);

      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }

      // Mevcut konumu kaydet; hemen tetikleme.
      const p = readPrice();
      alerts.forEach((a) => armAlert(a, p));
      render(p);
    } catch (e) {
      console.error("Ses başlatılamadı:", e);
      elStatus.textContent = "Ses başlatılamadı";
    }
  });

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
  btnPhone.classList.toggle("on", !!ntfyTopic);

  btnReset.addEventListener("click", () => {
    silence();
    const p = readPrice();
    alerts.forEach((a) => armAlert(a, p));
    listSignature = "";
    render(p);
  });

  btnSilence.addEventListener("click", silence);

  $("[data-hide]").addEventListener("click", () => {
    saveGeometry();
    panel.style.display = "none";
    dock.style.display = "block";
  });

  dock.addEventListener("click", () => {
    panel.style.display = "";
    dock.style.display = "none";
  });

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

  const onResize = () => {
    const r = panel.getBoundingClientRect();
    panel.style.left = `${clamp(r.left, 8, Math.max(8, window.innerWidth - r.width - 8))}px`;
    panel.style.top = `${clamp(r.top, 8, Math.max(8, window.innerHeight - r.height - 8))}px`;
  };
  window.addEventListener("resize", onResize);

  const timer = setInterval(tick, 1000);

  window.__xauAlarmStop = () => {
    stopped = true;
    clearInterval(timer);
    silence();
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    panel.remove();
    dock.remove();
    style.remove();
    if (audio && audio.state !== "closed") audio.close();
    delete window.__xauAlarmStop;
  };

  const first = readPrice();
  alerts.forEach((a) => armAlert(a, first));
  tick();
})();
