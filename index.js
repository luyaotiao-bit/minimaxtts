(function(){
  "use strict";

  const TAVERN_URL = window.location.origin;

  const LS_API = "xzy_mm_api";
  const LS_GRP = "xzy_mm_grp";
  const LS_VOICE = "xzy_mm_voc";
  const LS_MODEL = "xzy_mm_mod";
  const LS_OLD_FAV = "xzy_mm_fav";
  const LS_OLD_CACHE = "xzy_mm_cache_v4";
  const LS_PRESETS = "mm_tts_voice_presets_v1";
  const LS_MIGRATED = "mm_tts_idb_migrated_v1";

  const DB_NAME = "minimax_single_tts_db_v1";
  const DB_VERSION = 1;
  const STORE_CACHE = "cache";
  const STORE_FAV = "fav";

  let memoryCache = new Map();
  let currentAudio = null;
  let dbPromise = null;
  let migratePromise = null;
  let presetBusy = false;
  let favPage = 1;
  const favPageSize = 10;
  let cachePage = 1;
  const cachePageSize = 10;

  function getApi(name) {
    if (typeof window[name] === "function") return window[name];
    try { if (window.parent && typeof window.parent[name] === "function") return window.parent[name]; } catch (e) {}
    try { if (window.top && typeof window.top[name] === "function") return window.top[name]; } catch (e) {}
    return null;
  }

  function toast(type, msg) {
    try { if (window.toastr && typeof toastr[type] === "function") { toastr[type](msg); } else { console.log("[MiniMax TTS]", type, msg); } } catch (e) { console.log("[MiniMax TTS]", type, msg); }
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"]/g, function(c) {
      if (c === "&") return "&#38;";
      if (c === "<") return "&#60;";
      if (c === ">") return "&#62;";
      if (c === '"') return "&#34;";
      return c;
    });
  }

  function stopEvent(e) {
    if (!e) return false;
    e.preventDefault(); e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    return false;
  }

  function openDB() {
    return new Promise(function(resolve, reject) {
      if (!window.indexedDB) { reject(new Error("当前浏览器不支持 IndexedDB，无法保存大量语音。")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_CACHE)) { const cache = db.createObjectStore(STORE_CACHE, { keyPath: "text" }); cache.createIndex("time", "time", { unique: false }); }
        if (!db.objectStoreNames.contains(STORE_FAV)) { const fav = db.createObjectStore(STORE_FAV, { keyPath: "text" }); fav.createIndex("time", "time", { unique: false }); }
      };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error || new Error("IndexedDB 打开失败")); };
    });
  }

  function getDB() { if (!dbPromise) { dbPromise = openDB().catch(function(err) { dbPromise = null; throw err; }); } return dbPromise; }

  async function idbGet(storeName, key) {
    const db = await getDB();
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(storeName, "readonly"); const store = tx.objectStore(storeName); const req = store.get(key);
      req.onsuccess = function() { resolve(req.result || null); }; req.onerror = function() { reject(req.error || tx.error || new Error("IndexedDB 读取失败")); };
    });
  }

  async function idbPut(storeName, value) {
    const db = await getDB();
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(storeName, "readwrite"); const store = tx.objectStore(storeName); store.put(value);
      tx.oncomplete = function() { resolve(); }; tx.onerror = function() { reject(tx.error || new Error("IndexedDB 写入失败")); };
    });
  }

  async function idbDelete(storeName, key) {
    const db = await getDB();
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(storeName, "readwrite"); const store = tx.objectStore(storeName); store.delete(key);
      tx.oncomplete = function() { resolve(); }; tx.onerror = function() { reject(tx.error || new Error("IndexedDB 删除失败")); };
    });
  }

  async function idbClear(storeName) {
    const db = await getDB(); return new Promise(function(resolve, reject) {
      const tx = db.transaction(storeName, "readwrite"); const store = tx.objectStore(storeName); store.clear(); tx.oncomplete = function() { resolve(); };
    });
  }

  async function idbGetAll(storeName) {
    const db = await getDB();
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(storeName, "readonly"); const store = tx.objectStore(storeName);
      if (typeof store.getAll === "function") { const req = store.getAll(); req.onsuccess = function() { resolve(req.result || []); }; return; }
      const list = []; const req = store.openCursor();
      req.onsuccess = function(event) { const cursor = event.target.result; if (cursor) { list.push(cursor.value); cursor.continue(); } else { resolve(list); } };
    });
  }

  async function migrateOldStorage() {
    if (migratePromise) return migratePromise;
    migratePromise = (async function() {
      if (localStorage.getItem(LS_MIGRATED) === "1") return;
      try {
        await getDB(); let oldFavs = JSON.parse(localStorage.getItem(LS_OLD_FAV) || "[]");
        for (const item of oldFavs) { if (!item || !item.text) continue; await idbPut(STORE_FAV, { text: item.text, audio: item.audio || "", time: item.time || Date.now() }); }
        localStorage.setItem(LS_MIGRATED, "1");
      } catch (e) {}
    })(); return migratePromise;
  }

  function getHash(str) {
    let hash = 0; for (let i = 0; i < str.length; i++) { hash = (hash << 5) - hash + str.charCodeAt(i); hash |= 0; } return Math.abs(hash).toString(36);
  }

  async function uploadToPC(filename, base64Data) {
    let pureBase64 = base64Data; if (pureBase64.includes("base64,")) pureBase64 = pureBase64.split("base64,")[1];
    try {
      const token = window.TAVERN_CSRF_TOKEN || "";
      await fetch(TAVERN_URL + "/api/content/upload", {
        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({ filename: "cache/" + filename, data: pureBase64, encoding: "base64" })
      });
      console.log("[MiniMax] 云端备份落盘成功: " + filename);
    } catch (e) { console.error("[MiniMax] 扩展落盘写盘报错", e); }
  }

  async function getCachedAudio(text) {
    await migrateOldStorage(); if (memoryCache.has(text)) return memoryCache.get(text);
    const filename = "mm_" + getHash(text) + ".mp3"; const remoteUrl = TAVERN_URL + "/cache/" + filename;
    try { const res = await fetch(remoteUrl, { method: 'HEAD' }); if (res.ok) { memoryCache.set(text, remoteUrl); return remoteUrl; } } catch (e) {}
    const cacheItem = await idbGet(STORE_CACHE, text); if (cacheItem && cacheItem.audio) { memoryCache.set(text, cacheItem.audio); return cacheItem.audio; }
    return null;
  }

  async function saveCachedAudio(text, audio) {
    memoryCache.set(text, audio); const filename = "mm_" + getHash(text) + ".mp3"; uploadToPC(filename, audio);
    await idbPut(STORE_CACHE, { text: text, audio: audio, time: Date.now() });
  }

  async function getFavorites() { await migrateOldStorage(); const list = await idbGetAll(STORE_FAV); return list.sort((a, b) => (a.time || 0) - (b.time || 0)); }
  async function deleteFavorite(text) { await idbDelete(STORE_FAV, text); }

  async function cleanCache(keepCount) {
    keepCount = keepCount || 60; await migrateOldStorage(); const list = await idbGetAll(STORE_CACHE);
    list.sort((a, b) => (b.time || 0) - (a.time || 0)); const toDelete = list.slice(keepCount);
    for (const item of toDelete) { if (item && item.text) { await idbDelete(STORE_CACHE, item.text); memoryCache.delete(item.text); } }
    return toDelete.length;
  }

  function getPresets() { try { return JSON.parse(localStorage.getItem(LS_PRESETS) || "[]"); } catch (e) { return []; } }
  function savePresets(list) { localStorage.setItem(LS_PRESETS, JSON.stringify(list)); }

  function renderPresets() {
    try {
      const select = $("#xzy-preset-select"); const list = getPresets(); if (!select.length) return;
      select.empty().append('<option value="">未选择预设</option>');
      list.forEach(function(p, i) { select.append('<option value="' + i + '">' + escapeHtml(p.name || ("预设" + (i + 1))) + '</option>'); });
    } catch (e) {}
  }

  function loadPreset(index) {
    const p = getPresets()[index]; if (!p) { toast("warning", "请选择一个预设"); return; }
    $("#xzy-preset-name").val(p.name || ""); $("#xzy-inp-voc").val(p.voice || ""); $("#xzy-inp-mod").val(p.model || "speech-2.8-hd");
    toast("success", "已加载音色预设");
  }

  function createOrUpdatePreset(update) {
    if (presetBusy) return; presetBusy = true; setTimeout(function() { presetBusy = false; }, 500);
    const list = getPresets(); let index = $("#xzy-preset-select").val(); let name = ($("#xzy-preset-name").val() || "").trim();
    const voice = ($("#xzy-inp-voc").val() || "").trim(); const model = ($("#xzy-inp-mod").val() || "").trim() || "speech-2.8-hd";
    if (!voice) { toast("warning", "请先填写音色 ID"); return; } if (!name) name = voice;
    if (update) {
      if (index === "") { toast("warning", "请先选择要更新的预设"); return; }
      list[index] = { name: name, voice: voice, model: model, time: Date.now() }; toast("success", "预设已更新");
    } else {
      list.push({ name: name, voice: voice, model: model, time: Date.now() }); index = String(list.length - 1); toast("success", "预设已创建");
    }
    savePresets(list); renderPresets(); $("#xzy-preset-select").val(index);
  }

  function deletePreset() {
    const list = getPresets(); const index = $("#xzy-preset-select").val(); if (index === "") { toast("warning", "请先选择要删除的预设"); return; }
    list.splice(Number(index), 1); savePresets(list); $("#xzy-preset-name").val(""); renderPresets(); toast("success", "预设已删除");
  }

  function initUI() {
    if (document.getElementById("xzy-tts-overlay")) return;
    if (!window.JSZip) { let script = document.createElement("script"); script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; document.head.appendChild(script); }
    const html = [
      '<div id="xzy-tts-overlay" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;background:rgba(0,0,0,0.3);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);pointer-events:auto;touch-action:none;">',
        '<div id="xzy-tts-modal" style="position:absolute;top:5%;left:50%;transform:translate(-50%,0);width:90%;max-width:360px;max-height:95vh;background:#ffffff;border:1px solid #ccc;border-radius:16px;display:flex;flex-direction:column;box-shadow:0 20px 40px rgba(0,0,0,0.15);overflow:hidden;pointer-events:auto;touch-action:auto;">',
          '<div style="padding:12px;display:flex;flex-direction:column;overflow-y:auto;flex:1;">',
            '<div style="display:flex;justify-content:space-between;margin-bottom:12px;align-items:center;flex-shrink:0;">',
              '<h3 style="margin:0;font-size:15px;color:#d16b7c;">minimax单条语音扩展 v1.4.1 ✧</h3>',
              '<button id="xzy-tts-close" style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;padding:0;">✖</button>',
            '</div>',
            '<div style="display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid #eee;padding-bottom:10px;flex-shrink:0;">',
              '<button id="xzy-tab-set" style="flex:1;background:#ffb6c1;color:#000;border:none;padding:6px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;">配置参数</button>',
              '<button id="xzy-tab-fav" style="flex:1;background:transparent;color:#333;border:1px solid #ccc;padding:6px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;">收藏夹</button>',
              '<button id="xzy-tab-cache" style="flex:1;background:transparent;color:#333;border:1px solid #ccc;padding:6px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;">缓存池</button>',
            '</div>',
            '<div id="xzy-pane-set" style="display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding-right:5px;">',
              '<div><label style="font-size:12px;color:#555;">API Key</label><br><input id="xzy-inp-api" type="password" style="width:100%;box-sizing:border-box;background:#f5f5f5;border:1px solid #ccc;color:#000;padding:8px;border-radius:6px;margin-top:4px;"></div>',
              '<div><label style="font-size:12px;color:#555;">Group ID</label><br><input id="xzy-inp-grp" type="text" style="width:100%;box-sizing:border-box;background:#f5f5f5;border:1px solid #ccc;color:#000;padding:8px;border-radius:6px;margin-top:4px;"></div>',
              '<div><label style="font-size:12px;color:#555;">音色 ID (如 voice-xxx)</label><br><input id="xzy-inp-voc" type="text" style="width:100%;box-sizing:border-box;background:#f5f5f5;border:1px solid #ccc;color:#000;padding:8px;border-radius:6px;margin-top:4px;"></div>',
              '<div><label style="font-size:12px;color:#555;">模型名称</label><br><input id="xzy-inp-mod" type="text" placeholder="默认: speech-2.8-hd" style="width:100%;box-sizing:border-box;background:#f5f5f5;border:1px solid #ccc;color:#000;padding:8px;border-radius:6px;margin-top:4px;"></div>',
              '<div style="border:1px solid #e8e8e8;border-radius:8px;padding:8px;background:#fafafa;">',
                '<label style="font-size:12px;color:#555;">音色预设</label><br>',
                '<select id="xzy-preset-select" style="width:100%;box-sizing:border-box;background:#f5f5f5;border:1px solid #ccc;color:#000;padding:8px;border-radius:6px;margin-top:4px;"><option value="">未选择预设</option></select>',
                '<input id="xzy-preset-name" type="text" placeholder="预设备注名，例如：温柔男声" style="width:100%;box-sizing:border-box;background:#f5f5f5;border:1px solid #ccc;color:#000;padding:8px;border-radius:6px;margin-top:6px;">',
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">',
                  '<button id="xzy-preset-load" type="button" style="background:#d9f7be;color:#000;border:none;padding:7px;border-radius:7px;font-weight:bold;">加载</button>',
                  '<button id="xzy-preset-save-new" type="button" style="background:#ffb6c1;color:#000;border:none;padding:7px;border-radius:7px;font-weight:bold;">新建</button>',
                  '<button id="xzy-preset-update" type="button" style="background:#bae7ff;color:#000;border:none;padding:7px;border-radius:7px;font-weight:bold;">更新</button>',
                  '<button id="xzy-preset-delete" type="button" style="background:#ffccc7;color:#000;border:none;padding:7px;border-radius:7px;font-weight:bold;">删除</button>',
                '</div>',
                '<div style="font-size:11px;color:#666;line-height:1.4;margin-top:6px;">预设会保存：备注名、音色 ID、模型名称。</div>',
              '</div>',
              '<button id="xzy-btn-clean-cache" style="background:#ffccc7;color:#ff4d4f;border:1px solid #ffccc7;padding:9px;border-radius:8px;cursor:pointer;font-weight:bold;width:100%;flex-shrink:0;">清理本地缓存</button>',
              '<button id="xzy-btn-save" style="background:#ffb6c1;color:#000;border:none;padding:10px;border-radius:8px;cursor:pointer;margin-top:2px;font-weight:bold;width:100%;flex-shrink:0;">保存配置</button>',
            '</div>',
            '<div id="xzy-pane-fav" style="display:none;flex-direction:column;gap:8px;overflow-y:auto;padding-right:5px;flex:1;"></div>',
            '<div id="xzy-pane-cache" style="display:none;flex-direction:column;gap:8px;overflow-y:auto;padding-right:5px;flex:1;"></div>',
          '</div>',
        '</div>',
      '</div>'
    ].join("");
    $("body").append(html);
  }

  function bindPanelEvents() {
    $("#xzy-tts-overlay").on("click", function(e) { if (e.target === this) $(this).fadeOut(200); });
    $("#xzy-tts-close").on("click", function() { $("#xzy-tts-overlay").fadeOut(200); });
    
    $("#xzy-tab-set").on("click", function() {
      $(this).css({ background: "#ffb6c1", color: "#000", border: "none" }); 
      $("#xzy-tab-fav, #xzy-tab-cache").css({ background: "transparent", color: "#333", border: "1px solid #ccc" });
      $("#xzy-pane-set").css("display", "flex"); 
      $("#xzy-pane-fav, #xzy-pane-cache").hide();
    });
    
    $("#xzy-tab-fav").on("click", function() {
      $(this).css({ background: "#ffb6c1", color: "#000", border: "none" }); 
      $("#xzy-tab-set, #xzy-tab-cache").css({ background: "transparent", color: "#333", border: "1px solid #ccc" });
      $("#xzy-pane-fav").css("display", "flex"); 
      $("#xzy-pane-set, #xzy-pane-cache").hide(); 
      renderFavorites().catch(console.error);
    });
    
    $("#xzy-tab-cache").on("click", function() {
      $(this).css({ background: "#ffb6c1", color: "#000", border: "none" }); 
      $("#xzy-tab-set, #xzy-tab-fav").css({ background: "transparent", color: "#333", border: "1px solid #ccc" });
      $("#xzy-pane-cache").css("display", "flex"); 
      $("#xzy-pane-set, #xzy-pane-fav").hide(); 
      renderCachePane().catch(console.error);
    });
    
    $("#xzy-btn-save").on("click", function() {
      localStorage.setItem(LS_API, ($("#xzy-inp-api").val() || "").trim()); 
      localStorage.setItem(LS_GRP, ($("#xzy-inp-grp").val() || "").trim());
      localStorage.setItem(LS_VOICE, ($("#xzy-inp-voc").val() || "").trim()); 
      localStorage.setItem(LS_MODEL, ($("#xzy-inp-mod").val() || "").trim() || "speech-2.8-hd");
      toast("success", "配置已更新！"); 
      $("#xzy-tts-overlay").fadeOut(200);
    });
    
    let cleaning = false;
    $("#xzy-btn-clean-cache").on("click", async function() {
      if (cleaning) return false; 
      cleaning = true;
      try { 
        const count = await cleanCache(60); 
        toast("success", "已清理本地冗余缓存 " + count + " 条。"); 
        if ($("#xzy-pane-cache").is(":visible")) renderCachePane(); 
      } catch (err) {} 
      finally { cleaning = false; }
    });

    $("#xzy-preset-load").on("click", function() {
      const index = $("#xzy-preset-select").val();
      if (index !== "") loadPreset(parseInt(index));
      else toast("warning", "请选择一个预设");
    });

    $("#xzy-preset-save-new").on("click", function() {
      createOrUpdatePreset(false);
    });

    $("#xzy-preset-update").on("click", function() {
      createOrUpdatePreset(true);
    });

    $("#xzy-preset-delete").on("click", function() {
      deletePreset();
    });
  }

  window.openMinimaxPanel = function() {
    $("#xzy-inp-api").val(localStorage.getItem(LS_API) || ""); 
    $("#xzy-inp-grp").val(localStorage.getItem(LS_GRP) || "");
    $("#xzy-inp-voc").val(localStorage.getItem(LS_VOICE) || ""); 
    $("#xzy-inp-mod").val(localStorage.getItem(LS_MODEL) || "speech-2.8-hd");
    renderPresets(); 
    renderFavorites().catch(console.error); 
    $("#xzy-tts-overlay").fadeIn(200);
  };

  async function renderFavorites() {
    const pane = $("#xzy-pane-fav"); 
    pane.empty(); 
    const favs = await getFavorites();
    if (favs.length === 0) { 
      pane.append('<div style="text-align:center;color:#777;font-size:12px;margin-top:20px;padding:20px;">暂无收藏</div>'); 
      return; 
    }
    const total = Math.max(1, Math.ceil(favs.length / favPageSize)); 
    if (favPage > total) favPage = total; 
    const start = (favPage - 1) * favPageSize; 
    const pageList = favs.slice(start, start + favPageSize);
    pageList.forEach(item => {
      const row = $('<div style="display:flex;align-items:center;background:#f9f9f9;border:1px solid #ddd;padding:8px;border-radius:8px;gap:8px;margin-bottom:6px;"><div style="flex:1;font-size:12px;color:#222;">' + escapeHtml(item.text) + '</div><button class="xzy-fav-play" style="background:#ffb6c1;color:#000;border:none;border-radius:7px;padding:7px 9px;cursor:pointer;">▶️</button><button class="xzy-fav-del" style="background:rgba(255,77,79,.08);color:#ff4d4f;border:none;border-radius:7px;padding:7px 9px;cursor:pointer;">✖</button></div>');
      row.find(".xzy-fav-play").on("click", function() { playAudio(item.audio, this); }); 
      row.find(".xzy-fav-del").on("click", async function() { await deleteFavorite(item.text); renderFavorites(); }); 
      pane.append(row);
    });
    const pager = $('<div style="border-top:1px solid #eee;margin-top:8px;padding-top:10px;display:flex;flex-direction:column;gap:8px;align-items:center;"></div>'); 
    const rowPager = $('<div style="display:flex;gap:6px;"></div>');
    const mkBtn = (t, d, a) => $('<button style="padding:4px 8px;border-radius:6px;font-size:11px;background:'+(a?'#ffb6c1':d?'#f0f0f0':'#fafafa')+'">'+t+'</button>');
    const prev = mkBtn("上一页", favPage<=1, false); 
    if(favPage>1) prev.on('click', () => { favPage--; renderFavorites(); }); 
    const next = mkBtn("下一页", favPage>=total, false); 
    if(favPage<total) next.on('click', () => { favPage++; renderFavorites(); }); 
    rowPager.append(prev).append(next); 
    pager.append(rowPager);
    const jump = $('<div style="display:flex;gap:6px;font-size:11px;align-items:center;"><span>第 '+favPage+' / '+total+' 页</span><input id="xzy-fav-page-input" type="number" style="width:45px;text-align:center;border:1px solid #ccc;" value="' + favPage + '"><button id="xzy-fav-page-jump" style="padding:2px 6px;border:1px solid #ccc;">跳转</button></div>'); 
    pager.append(jump); 
    pane.append(pager);
    pane.find("#xzy-fav-page-jump").on('click', () => { const val = parseInt($("#xzy-fav-page-input").val()); if(val > 0 && val <= total) { favPage = val; renderFavorites(); } });
  }

   async function renderCachePane() {
    const pane = $("#xzy-pane-cache");
    pane.empty();
    let cacheList = await idbGetAll(STORE_CACHE);
    if (cacheList.length === 0) {
        memoryCache.forEach((audio, text) => cacheList.push({ text: text, audio: audio }));
    }
    if (cacheList.length === 0) {
        pane.append('<div style="text-align:center;color:#777;font-size:12px;margin-top:20px;padding:20px;">暂无本地缓存</div>');
        return;
    }

    pane.append(`
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#666;margin-bottom:6px;flex-wrap:wrap;gap:6px;">
            <span>共缓存了 ${cacheList.length} 条</span>
            <div style="display:flex;gap:6px;">
                <button id="xzy-cache-download-all" style="background:#bae7ff;color:#000;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;">打包下载</button>
                <button id="xzy-cache-clear-all" style="background:#ffccc7;color:#ff4d4f;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;">一键清空</button>
            </div>
        </div>
    `);

    $("#xzy-cache-download-all").on('click', async function() {
        if (cacheList.length === 0) {
            toast("warning", "没有可下载的缓存");
            return;
        }
        try {
            if (typeof JSZip === 'undefined') {
                toast("error", "JSZip 未加载，请刷新页面重试");
                return;
            }
            const zip = new JSZip();
            let count = 0;
            for (const item of cacheList) {
                if (item.audio) {
                    let audioData = item.audio;
                    if (audioData.includes('base64,')) {
                        audioData = audioData.split('base64,')[1];
                    }
                    const filename = "mm_" + getHash(item.text) + ".mp3";
                    zip.file(filename, audioData, { base64: true });
                    count++;
                }
            }
            if (count === 0) {
                toast("warning", "没有可下载的音频数据");
                return;
            }
            const content = await zip.generateAsync({ type: "blob" });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = `minimax_tts_cache_${new Date().toISOString().slice(0,10)}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
            toast("success", `成功打包下载 ${count} 个音频文件`);
        } catch (e) {
            console.error("[MiniMax] 打包下载失败:", e);
            toast("error", "打包下载失败: " + (e.message || "未知错误"));
        }
    });

    $("#xzy-cache-clear-all").on('click', async () => {
        if (confirm("确定清空所有缓存吗？")) {
            await idbClear(STORE_CACHE);
            memoryCache.clear();
            renderCachePane();
            toast("success", "已清空所有缓存");
        }
    });

    const total = Math.max(1, Math.ceil(cacheList.length / cachePageSize));
    if (cachePage > total) cachePage = total;
    const start = (cachePage - 1) * cachePageSize;
    const pageList = cacheList.slice(start, start + cachePageSize);

    pageList.forEach(item => {
        const filename = "mm_" + getHash(item.text) + ".mp3";
        const hasAudio = item.audio && item.audio.length > 0;
        const row = $(`
            <div style="display:flex;align-items:center;background:#f9f9f9;border:1px solid #ddd;padding:8px;border-radius:8px;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
                <div style="flex:1;font-size:12px;color:#222;min-width:60px;word-break:break-all;">${escapeHtml(item.text)}</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    <button class="xzy-cache-play" style="background:#ffb6c1;color:#000;border:none;border-radius:7px;padding:4px 8px;cursor:pointer;font-size:11px;">▶️</button>
                    ${hasAudio ? `<button class="xzy-cache-download" data-filename="${filename}" data-audio="${encodeURIComponent(item.audio)}" style="background:#bae7ff;color:#000;border:none;border-radius:7px;padding:4px 8px;cursor:pointer;font-size:11px;">下载</button>` : ''}
                </div>
            </div>
        `);

        row.find(".xzy-cache-play").on("click", function() {
            playAudio(TAVERN_URL + "/cache/" + filename, this);
        });

        row.find(".xzy-cache-download").on("click", function() {
            const audioData = decodeURIComponent($(this).attr("data-audio") || "");
            const filename = $(this).attr("data-filename") || "audio.mp3";
            if (audioData) {
                let base64Data = audioData;
                if (base64Data.includes('base64,')) {
                    base64Data = base64Data.split('base64,')[1];
                }
                try {
                    const link = document.createElement('a');
                    link.href = 'data:audio/mp3;base64,' + base64Data;
                    link.download = filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    toast("success", `已下载: ${filename}`);
                } catch (e) {
                    toast("error", "下载失败");
                    console.error("[MiniMax] 下载失败:", e);
                }
            } else {
                const url = TAVERN_URL + "/cache/" + filename;
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                link.target = '_blank';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                toast("success", `已下载: ${filename}`);
            }
        });

        pane.append(row);
    });

    const pager = $('<div style="border-top:1px solid #eee;margin-top:8px;padding-top:10px;display:flex;flex-direction:column;gap:8px;align-items:center;"></div>');
    const rowPager = $('<div style="display:flex;gap:6px;"></div>');
    const mkBtn = (t, d, a) => $('<button style="padding:4px 8px;border-radius:6px;font-size:11px;background:' + (a ? '#ffb6c1' : d ? '#f0f0f0' : '#fafafa') + '">' + t + '</button>');
    const prev = mkBtn("上页", cachePage <= 1, false);
    if (cachePage > 1) prev.on('click', () => { cachePage--;
        renderCachePane(); });
    const next = mkBtn("下页", cachePage >= total, false);
    if (cachePage < total) next.on('click', () => { cachePage++;
        renderCachePane(); });
    rowPager.append(prev).append(next);
    pager.append(rowPager);
    const jump = $('<div style="display:flex;gap:6px;font-size:11px;align-items:center;"><span>第 ' + cachePage + ' / ' + total + ' 页</span><input id="xzy-cache-page-input" type="number" style="width:45px;text-align:center;border:1px solid #ccc;border-radius:4px;padding:2px;" value="' + cachePage + '"><button id="xzy-cache-page-jump" style="padding:2px 8px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f5f5f5;">跳转</button></div>');
    pager.append(jump);
    pane.append(pager);
    pane.find("#xzy-cache-page-jump").on('click', () => {
        const val = parseInt($("#xzy-cache-page-input").val());
        if (val > 0 && val <= total) {
            cachePage = val;
            renderCachePane();
        }
    });
  }
  
  function playAudio(audioUrl, btn) {
    if (currentAudio) currentAudio.pause(); 
    currentAudio = new Audio(audioUrl);
    currentAudio.play().catch(e => {
      console.warn("[MiniMax] 切换本地备用通道播放..."); 
      const text = btn ? decodeURIComponent($(btn).attr("data-txt") || "") : "";
      if(text) { 
        idbGet(STORE_CACHE, text).then(item => { 
          if(item && item.audio) { 
            if(currentAudio) currentAudio.pause(); 
            currentAudio = new Audio(item.audio); 
            currentAudio.play().catch(console.error); 
          } 
        }); 
      }
    });
    if (btn) { 
      btn.innerText = "🔊"; 
      currentAudio.onended = function() { btn.innerText = "▶️"; }; 
    }
  }

  function hexToAudioUrl(hex) {
    const matched = hex.match(/.{1,2}/g); 
    const bytes = new Uint8Array(matched.map(x => parseInt(x, 16))); 
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]); 
    return "data:audio/mp3;base64," + btoa(bin);
  }

  window.playXzyTTS = async function(text, btn) {
    const apiRaw = localStorage.getItem(LS_API) || ""; 
    const voice = localStorage.getItem(LS_VOICE); 
    const model = localStorage.getItem(LS_MODEL) || "speech-2.8-hd"; 
    const api = apiRaw.trim().replace(/^Bearer\s+/i, "");
    if (!api || !voice) { toast("warning", "请先配置 API Key 和音色 ID。"); return; }
    const cachedUrl = await getCachedAudio(text); 
    if (cachedUrl) { playAudio(cachedUrl, btn); return; } 
    if (btn) btn.innerText = "⏳";
    try {
      const resp = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
        method: "POST", 
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + api },
        body: JSON.stringify({ 
          model: model, 
          text: text, 
          stream: false, 
          voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0, emotion: "neutral" }, 
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 }, 
          output_format: "hex" 
        })
      });
      const raw = await resp.text(); 
      const json = JSON.parse(raw);
      if (json && json.base_resp && json.base_resp.status_code === 0 && json.data && json.data.audio) {
        const audioUrl = hexToAudioUrl(json.data.audio); 
        await saveCachedAudio(text, audioUrl); 
        if (btn) btn.innerText = "▶️";
        const filename = "mm_" + getHash(text) + ".mp3"; 
        playAudio(TAVERN_URL + "/cache/" + filename, btn);
      } else { 
        if (btn) btn.innerText = "❌"; 
        let code = json && json.base_resp ? json.base_resp.status_code : "未知"; 
        toast("error", "MiniMax 报错: " + code); 
      }
    } catch (err) { 
      if (btn) btn.innerText = "▶️"; 
      toast("error", "请求失败: " + (err.message || "未知错误"));
      console.error("[MiniMax]", err);
    }
  };

  window.favXzyTTS = async function(text, btn) {
    try {
      const audio = await getCachedAudio(text); 
      if (!audio) { toast("warning", "请先点击 ▶️ 生成语音再收藏！"); return; }
      const old = await idbGet(STORE_FAV, text); 
      if (old) { toast("info", "已经在收藏夹里了。"); return; }
      await idbPut(STORE_FAV, { text: text, audio: audio, time: Date.now() }); 
      toast("success", "已添加到收藏夹！"); 
      if (btn) btn.innerText = "🌟";
    } catch (e) { 
      toast("error", "收藏失败"); 
      console.error("[MiniMax]", e);
    }
  };

  function processMessages() {
    $(".mes_text p").each(function() {
      if ($(this).hasClass("xzy-tts-processed")) return; 
      const oldHtml = $(this).html();
      const newHtml = oldHtml.replace(/(\"[^\"]+\"|“[^”]+”|「[^」]+」|『[^』]+』)/g, function(match) {
        const text = match.replace(/[""「」『』“”]/g, "").replace(/<[^>]*>?/gm, "").trim(); 
        if (text.length === 0) return match; 
        const encoded = encodeURIComponent(text);
        return match + "<span class='xzy-inline-wrap' style='white-space:nowrap;margin-left:4px;opacity:0.8;user-select:none;display:inline-flex;gap:2px;align-items:center;'><span class='xzy-play-btn' data-txt='" + encoded + "' style='cursor:pointer;background:rgba(0,0,0,0.05);padding:2px 4px;border-radius:4px;font-size:0.9em;'>▶️</span><span class='xzy-fav-btn' data-txt='" + encoded + "' style='cursor:pointer;background:rgba(0,0,0,0.05);padding:2px 4px;border-radius:4px;font-size:0.9em;'>⭐</span></span>";
      });
      $(this).html(newHtml).addClass("xzy-tts-processed");
    });
  }

  initUI(); 
  bindPanelEvents();

// ========== 添加到扩展菜单 ==========
(function() {
    console.log("[MiniMax] 启动扩展菜单注入...");
    
    function addMenuItem() {
        const menu = document.getElementById('extensionsMenu');
        if (menu && !menu.querySelector('.minimax-menu-item')) {
            const item = document.createElement('div');
            item.className = 'extension_container interactable minimax-menu-item';
            item.setAttribute('tabindex', '0');
            item.setAttribute('role', 'listitem');
            item.style.cssText = "display: flex; align-items: center; gap: 10px; padding: 5px; cursor: pointer; border-radius: 4px; transition: background 0.2s;";
            item.innerHTML = '<div class="fa-fw fa-solid fa-microphone extensionsMenuExtensionButton" style="color: #ffb6c1;"></div><span>MiniMax语音</span>';
            item.onmouseenter = function() { this.style.background = 'rgba(255,182,193,0.15)'; };
            item.onmouseleave = function() { this.style.background = 'transparent'; };
            item.onclick = function(e) {
                e.stopPropagation();
                window.openMinimaxPanel();
                const menu = document.getElementById('extensionsMenu');
                if (menu) menu.style.display = 'none';
            };
            
            const firstItem = menu.querySelector('.extension_container');
            if (firstItem) {
                menu.insertBefore(item, firstItem.nextSibling);
            } else {
                menu.appendChild(item);
            }
            console.log("[MiniMax] ✅ 已添加到扩展菜单");
            return true;
        }
        return false;
    }
    
    // 监听扩展按钮点击
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('#extensionsMenuButton');
        if (btn) {
            console.log("[MiniMax] 扩展按钮被点击");
            setTimeout(addMenuItem, 100);
            setTimeout(addMenuItem, 300);
            setTimeout(addMenuItem, 600);
        }
    });
    
    // 监听 DOM 变化
    const observer = new MutationObserver(function() {
        const menu = document.getElementById('extensionsMenu');
        if (menu && menu.style.display !== 'none') {
            addMenuItem();
        }
    });
    observer.observe(document.body, { 
        childList: true, 
        subtree: true 
    });
    
    // 定期检查
    let attempts = 0;
    const interval = setInterval(function() {
        attempts++;
        if (addMenuItem()) {
            clearInterval(interval);
        } else if (attempts > 20) {
            clearInterval(interval);
        }
    }, 2000);
    
    console.log("[MiniMax] ✅ 注入程序已启动，点击 🧩 扩展按钮查看");
})();

// ========== 启动消息处理 ==========
(function startMessageProcessor() {
    console.log("[MiniMax] 启动消息处理器...");
    
    // 确保 processMessages 存在
    if (typeof processMessages !== 'function') {
        console.error("[MiniMax] ❌ processMessages 函数未定义！");
        return;
    }
    
    // 立即执行一次
    setTimeout(function() {
        try {
            processMessages();
            console.log("[MiniMax] ✅ 首次消息处理完成");
        } catch(e) {
            console.error("[MiniMax] ❌ 首次消息处理失败:", e);
        }
    }, 1000);
    
    // 每2秒执行一次
    const intervalId = setInterval(function() {
        try {
            processMessages();
        } catch(e) {
            console.error("[MiniMax] ❌ 定时处理失败:", e);
        }
    }, 2000);
    console.log("[MiniMax] ✅ 定时器已启动 (间隔2秒)");
    
    // 监听新消息
    const chatObserver = new MutationObserver(function() {
        clearTimeout(chatObserver.debounce);
        chatObserver.debounce = setTimeout(function() {
            try {
                processMessages();
            } catch(e) {
                console.error("[MiniMax] ❌ 观察者处理失败:", e);
            }
        }, 300);
    });
    
    // 等待聊天容器出现
    let attempts = 0;
    const waitForChat = setInterval(function() {
        attempts++;
        const chatContainer = document.getElementById('chat');
        if (chatContainer) {
            chatObserver.observe(chatContainer, {
                childList: true,
                subtree: true
            });
            console.log("[MiniMax] ✅ 聊天监听已启动");
            clearInterval(waitForChat);
        } else if (attempts > 10) {
            console.log("[MiniMax] ⚠️ 未找到聊天容器，仅使用定时器轮询");
            clearInterval(waitForChat);
        }
    }, 500);
    
    console.log("[MiniMax] ✅ 消息处理器已完全启动");
})();
  
})();
