// background.js — сервис-воркер (MV3): очередь задач, инъекция контента, анти-бан режим
// Логика: popup отправляет список запросов и конфиг. Воркер по одному открывает вкладки,
// ждёт загрузки, инжектит content_script `extract.js`, получает сгруппированные цены,
// выбирает «лучшую» валюту, сообщает прогресс и результат обратно.

/* global chrome */

let state = 'idle'; // idle | running | paused | stopped
let queue = [];
let idx = 0;
let cfg = {
  engine: 'google',
  delayMs: 8000,
  useQuotes: true,
  limitCount: 100,
  googleHl: 'ru',
  googleGl: 'ru'
};

// Накопленные результаты текущего запуска
let resultsMap = {}; // { [task: string]: {min,max,avg,samples[],currency} }
let itemsSnapshot = [];

// Восстановление состояния из хранилища (на случай перезапуска воркера)
(async function restoreBgState(){
  try {
    const data = await new Promise((res)=>chrome.storage.local.get('ps_bg', res));
    const st = data && data.ps_bg;
    if (!st) return;
    state = st.state || 'idle';
    idx = st.idx || 0;
    cfg = { ...cfg, ...(st.cfg || {}) };
    resultsMap = st.results || {};
    itemsSnapshot = Array.isArray(st.items) ? st.items : [];
    if (!queue.length && Array.isArray(st.queue)) queue = st.queue;
  } catch (_e) {}
})();

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  try {
    if (!msg || !msg.type) return;

    if (msg.type === 'queue:start') {
      queue = Array.isArray(msg.items) ? msg.items.slice(0, msg.cfg?.limitCount || msg.items.length) : [];
      idx = 0;
      cfg = { ...cfg, ...(msg.cfg || {}) };
      resultsMap = {};
      itemsSnapshot = queue.slice();
      state = 'running';
      chrome.runtime.sendMessage({ type: 'queue:state', state });
      persistBgState();
      tick();
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === 'queue:pause') {
      if (state === 'running') state = 'paused';
      chrome.runtime.sendMessage({ type: 'queue:state', state });
      persistBgState();
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === 'queue:resume') {
      if (state === 'paused') {
        state = 'running';
        chrome.runtime.sendMessage({ type: 'queue:state', state });
        tick();
      }
      persistBgState();
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === 'queue:stop') {
      state = 'stopped';
      chrome.runtime.sendMessage({ type: 'queue:state', state });
      persistBgState();
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === 'queue:getStatus') {
      sendResponse?.({ state, i: idx, total: queue.length || itemsSnapshot.length || 0, results: resultsMap, cfg, items: itemsSnapshot });
      return true;
    }
  } catch (e) {
    // в сервис-воркере лучше не падать
    console.warn('background onMessage error', e);
  }
});

async function tick() {
  if (state !== 'running') return;
  if (idx >= queue.length) {
    state = 'idle';
    chrome.runtime.sendMessage({ type: 'queue:state', state });
    chrome.runtime.sendMessage({ type: 'queue:done' });
    persistBgState();
    return;
  }

  const task = queue[idx];
  let result = null;

  try {
    // Открываем/обновляем вкладку с поиском
    const url = buildSearchUrl(cfg.engine, String(task || ''), cfg);
    const tab = await chrome.tabs.create({ url, active: false });

    await waitForComplete(tab.id);

    // Инъекция контент-скрипта и сбор цен
    const [execRes] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_scripts/extract.js']
    });

    await safeCloseTab(tab.id);

    const data = execRes?.result || { captcha: false, grouped: null };
    if (data.captcha) {
      state = 'paused';
      chrome.runtime.sendMessage({ type: 'queue:captcha' });
      chrome.runtime.sendMessage({ type: 'queue:state', state });
      return; // ждём ручного resume
    }

    const best = chooseBestCurrency(data.grouped);
    result = best ? {
      min: Math.min(...best.values),
      max: Math.max(...best.values),
      avg: Number((best.values.reduce((a, b) => a + b, 0) / best.values.length).toFixed(2)),
      samples: best.samples.slice(0, 5),
      currency: best.currency
    } : null;

    chrome.runtime.sendMessage({ type: 'queue:tick', i: idx + 1, total: queue.length, task, result });
    if (result) {
      resultsMap[String(task)] = result;
      persistBgState();
    }
  } catch (e) {
    console.warn('tick error', e);
    chrome.runtime.sendMessage({ type: 'queue:tick', i: idx + 1, total: queue.length, task, result: null });
  }

  idx++;

  // Пауза между запросами (слегка рандомизируем)
  const jitter = Math.round((Math.random() * 0.4 + 0.8) * (cfg.delayMs || 8000));
  setTimeout(() => {
    if (state === 'running') tick();
  }, jitter);
}

function buildSearchUrl(engine, q, cfgLocal) {
  const query = cfgLocal.useQuotes ? `"${q}"` : q;
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(cfgLocal.googleHl || 'ru')}&gl=${encodeURIComponent(cfgLocal.googleGl || 'ru')}`;
    case 'yandex':
      return `https://yandex.ru/search/?text=${encodeURIComponent(query)}`;
    case 'bing':
      return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    default:
      return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 8000);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function safeCloseTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_e) {
    // ignore
  }
}

function chooseBestCurrency(grouped) {
  if (!grouped) return null;
  // Выбираем валюту с максимальным количеством цен
  const entries = Object.entries(grouped).filter(([, v]) => v.values.length > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1].values.length - a[1].values.length);
  const [currency, data] = entries[0];
  return { currency, values: data.values, samples: data.samples };
}

function persistBgState() {
  try {
    chrome.storage.local.set({ ps_bg: { state, idx, cfg, results: resultsMap, items: itemsSnapshot, queue } });
  } catch (_e) {}
}