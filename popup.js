// popup.js — UI, чтение файлов, связь с background, сбор результатов и выгрузка

/* global XLSX, chrome */

// Глобальные переменные состояния файла
let workbook = null;
let sheetName = '';
let sheetData = [];
let originalFileName = '';
let lastSavedAt = 0;

// Названия колонок для результатов парсинга (определяются один раз при загрузке файла)
let priceColumns = {
  min: 'Min',
  max: 'Max', 
  avg: 'Avg',
  currency: 'Currency'
};

// Кэш DOM-элементов
const dom = {
  fileInput: document.getElementById('fileInput'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  downloadXlsx: document.getElementById('downloadXlsx'),
  downloadCsv: document.getElementById('downloadCsv'),
  engineSelect: document.getElementById('engineSelect'),
  delaySec: document.getElementById('delaySec'),
  limitCount: document.getElementById('limitCount'),
  useQuotes: document.getElementById('useQuotes'),
  googleHl: document.getElementById('googleHl'),
  googleGl: document.getElementById('googleGl'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  progressWrap: document.getElementById('progressWrap'),
  progressBar: document.getElementById('progressBar'),
  columnRow: document.getElementById('columnRow'),
  columnSelect: document.getElementById('columnSelect'),
  autoDetect: document.getElementById('autoDetect')
};

function setProgress(i, total) {
  if (!total) {
    dom.progressWrap.classList.add('hidden');
    return;
  }
  dom.progressWrap.classList.remove('hidden');
  const pct = Math.min(100, Math.round((i / total) * 100));
  dom.progressBar.style.width = pct + '%';
  dom.status.textContent = `Обработано: ${i} / ${total} (${pct}%)`;
}

function log(message) {
  const ts = new Date().toLocaleTimeString();
  // Показываем только последнее сообщение
  dom.log.textContent = `[${ts}] ${message}`;
  dom.log.scrollTop = dom.log.scrollHeight;
}

// --- Persist helpers ---
function debounceSave() {
  const now = Date.now();
  if (now - lastSavedAt < 400) return; // не слишком часто
  lastSavedAt = now;
  const state = {
    sheetName,
    originalFileName,
    sheetData,
    ui: {
      engine: dom.engineSelect.value,
      delaySec: dom.delaySec.value,
      limitCount: dom.limitCount.value,
      useQuotes: dom.useQuotes.checked,
      googleHl: dom.googleHl.value,
      googleGl: dom.googleGl.value,
      column: dom.columnSelect.value
    }
  };
  try { chrome.storage.local.set({ ps_state: state }); } catch (_e) {}
}

async function restoreState() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('ps_state', (data) => {
        const st = data && data.ps_state;
        if (!st) return resolve();
        try {
          // UI
          if (st.ui) {
            if (st.ui.engine) dom.engineSelect.value = st.ui.engine;
            if (st.ui.delaySec) dom.delaySec.value = st.ui.delaySec;
            if (st.ui.limitCount) dom.limitCount.value = st.ui.limitCount;
            if (typeof st.ui.useQuotes === 'boolean') dom.useQuotes.checked = st.ui.useQuotes;
            if (st.ui.googleHl) dom.googleHl.value = st.ui.googleHl;
            if (st.ui.googleGl) dom.googleGl.value = st.ui.googleGl;
          }
          // Данные файла (если уже были получены результаты — позволим выгрузку)
          if (Array.isArray(st.sheetData) && st.sheetData.length) {
            sheetData = st.sheetData;
            sheetName = st.sheetName || 'Sheet1';
            originalFileName = st.originalFileName || '';
            // Восстановим книгу из sheetData, чтобы работала выгрузка
            try {
              workbook = XLSX.utils.book_new();
              const ws = XLSX.utils.json_to_sheet(sheetData);
              XLSX.utils.book_append_sheet(workbook, ws, sheetName);
            } catch (_e) {}
            // Определяем названия колонок для цен
            definePriceColumns();
            populateColumnSelect();
            if (st.ui && st.ui.column) dom.columnSelect.value = st.ui.column;
            dom.startBtn.disabled = sheetData.length === 0;
            dom.downloadXlsx.disabled = false;
            dom.downloadCsv.disabled = false;
          }
          // Получим накопленные результаты из background и сольём
          chrome.runtime.sendMessage({ type: 'queue:getStatus' }, (resp) => {
            try {
              if (chrome.runtime.lastError) {
                console.log('Background script not available:', chrome.runtime.lastError.message);
                resolve();
                return;
              }
              if (resp && resp.results && typeof resp.results === 'object') {
                mergeResultsIntoSheet(resp.results);
                if (Object.keys(resp.results).length) {
dom.downloadXlsx.disabled = false;
dom.downloadCsv.disabled = false;
                }
              }
            } catch (_e) {
              console.log('Error processing background response:', _e);
            }
            resolve();
          });
        } catch (_e) { resolve(); }
      });
    } catch (_e) { resolve(); }
  });
}

function definePriceColumns() {
  if (!Array.isArray(sheetData) || !sheetData.length) return;
  
  const existingKeys = Object.keys(sheetData[0] || {});
  let index = 0;
  
  // Ищем первый свободный индекс для колонок цен
  while (existingKeys.includes(`Min_${index}`) || 
         existingKeys.includes(`Max_${index}`) || 
         existingKeys.includes(`Avg_${index}`) || 
         existingKeys.includes(`Currency_${index}`)) {
    index++;
  }
  
  // Устанавливаем названия колонок в правильном порядке
  priceColumns = {
    min: `Min_${index}`,
    max: `Max_${index}`,
    avg: `Avg_${index}`,
    currency: `Currency_${index}`
  };
  
  // Добавляем колонки в конец каждой строки в правильном порядке
  for (const row of sheetData) {
    if (!row[priceColumns.min]) row[priceColumns.min] = '';
    if (!row[priceColumns.max]) row[priceColumns.max] = '';
    if (!row[priceColumns.avg]) row[priceColumns.avg] = '';
    if (!row[priceColumns.currency]) row[priceColumns.currency] = '';
  }
}

function mergeResultsIntoSheet(resultsMap) {
  if (!Array.isArray(sheetData) || !sheetData.length) return;
  const key = dom.columnSelect.value || inferColumnName();
  const lookup = new Map(sheetData.map(r => [String(r[key] ?? ''), r]));
  
  for (const [task, res] of Object.entries(resultsMap || {})) {
    const row = lookup.get(String(task));
    if (row && res) {
      row[priceColumns.min] = res.min;
      row[priceColumns.max] = res.max;
      row[priceColumns.avg] = res.avg;
      row[priceColumns.currency] = res.currency;
    }
  }
  // Обновим книгу после слияния с правильным порядком колонок
  rebuildWorksheetFromData();
}

function inferColumnName() {
  if (!Array.isArray(sheetData) || sheetData.length === 0) return null;
  const firstRow = sheetData[0];
  const keys = Object.keys(firstRow || {});
  if (!keys.length) return null;
  // Приоритетные названия колонок
  const priority = [
    'Наименование',
    'наименование',
    'Название',
    'название',
    'Имя',
    'имя',
    'Товар',
    'товар',
    'Product',
    'Name',
  ];
  // точное совпадение
  for (const p of priority) {
    if (keys.includes(p)) return p;
  }
  // попытка по нормализованному виду
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g,'').replace(/["'`]/g,'');
  const map = new Map(keys.map(k => [norm(k), k]));
  const priorityNorm = ['наименование','название','товар','product','name'];
  for (const p of priorityNorm) {
    if (map.has(p)) return map.get(p);
  }
  // иначе первое поле
  return keys[0];
}

function rebuildWorksheetFromData() {
  // Создаем лист с правильным порядком колонок
const ws = XLSX.utils.json_to_sheet(sheetData);
  
  // Получаем все колонки и сортируем их так, чтобы колонки цен были в конце
  const allKeys = Object.keys(sheetData[0] || {});
  const originalKeys = allKeys.filter(key => 
    !key.startsWith('Min_') && 
    !key.startsWith('Max_') && 
    !key.startsWith('Avg_') && 
    !key.startsWith('Currency_')
  );
  
  // Добавляем колонки цен в правильном порядке в конец
  const priceKeys = [
    priceColumns.min,
    priceColumns.max, 
    priceColumns.avg,
    priceColumns.currency
  ].filter(key => allKeys.includes(key));
  
  const orderedKeys = [...originalKeys, ...priceKeys];
  
  // Пересоздаем лист с правильным порядком колонок
  const orderedData = sheetData.map(row => {
    const newRow = {};
    for (const key of orderedKeys) {
      newRow[key] = row[key] || '';
    }
    return newRow;
  });
  
  const orderedWs = XLSX.utils.json_to_sheet(orderedData);
  workbook.Sheets[sheetName] = orderedWs;
}

function downloadXlsx() {
if (!workbook) return;
rebuildWorksheetFromData();
const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const url = URL.createObjectURL(blob);
chrome.downloads.download({
url,
filename: addSuffix(originalFileName || 'result.xlsx', '_with_prices.xlsx')
});
}

function downloadCsv() {
if (!workbook) return;
rebuildWorksheetFromData();
const ws = workbook.Sheets[sheetName];
const csv = XLSX.utils.sheet_to_csv(ws);
const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
const url = URL.createObjectURL(blob);
chrome.downloads.download({
url,
filename: addSuffix((originalFileName || 'result.xlsx').replace(/\.xlsx?$/i, '.csv'), '_with_prices.csv')
});
}

function addSuffix(name, suffix) {
const dot = name.lastIndexOf('.');
if (dot === -1) return name + suffix;
return name.slice(0, dot) + suffix;
}

function populateColumnSelect() {
  const sel = dom.columnSelect;
  sel.innerHTML = '';
  if (!Array.isArray(sheetData) || sheetData.length === 0) return;
  const keys = Object.keys(sheetData[0] || {});
  
  // Исключаем служебные колонки для результатов парсинга
  const excludePatterns = ['Min_', 'Max_', 'Avg_', 'Currency_', '_EMPTY'];
  const filteredKeys = keys.filter(key => 
    !excludePatterns.some(pattern => key.startsWith(pattern))
  );
  
  for (const k of filteredKeys) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
  dom.columnRow.classList.toggle('hidden', filteredKeys.length <= 1);
}

function cleanColumnHeaders(data) {
  if (!Array.isArray(data) || !data.length) return data;
  
  // Получаем первую строку (заголовки)
  const firstRow = data[0];
  const keyMapping = {}; // маппинг старых ключей на новые
  const usedKeys = new Set(); // для избежания дублирования ключей
  
  // Создаем маппинг старых ключей на очищенные
  for (const [oldKey, value] of Object.entries(firstRow)) {
    // Очищаем заголовок от переносов строк и лишних пробелов
    // Используем oldKey (название колонки), а не value (содержимое ячейки)
    let cleanedKey = String(oldKey)
      .replace(/_x000d_/g, ' ')     // заменяем HTML-коды переносов строк
      .replace(/_x000a_/g, ' ')     // заменяем HTML-коды переносов строк
      .replace(/_x0009_/g, ' ')     // заменяем HTML-коды табов
      .replace(/[\r\n\t]/g, ' ')    // заменяем обычные переносы строк и табы на пробелы
      .replace(/\s+/g, ' ')         // заменяем множественные пробелы на одинарные
      .replace(/[,\s]+/g, ', ')     // нормализуем запятые с пробелами
      .trim();                      // убираем пробелы в начале и конце
    
    // Если очищенный ключ пустой или уже используется, используем оригинальный ключ
    if (!cleanedKey || usedKeys.has(cleanedKey)) {
      cleanedKey = oldKey;
    }
    
    keyMapping[oldKey] = cleanedKey;
    usedKeys.add(cleanedKey);
  }
  
  // Создаем новый массив с очищенными заголовками
  return data.map((row) => {
    const newRow = {};
    for (const [oldKey, value] of Object.entries(row)) {
      const newKey = keyMapping[oldKey] || oldKey;
      newRow[newKey] = value;
    }
    return newRow;
  });
}

function readFile(file) {
  originalFileName = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      workbook = XLSX.read(data, { type: 'array' });
      sheetName = workbook.SheetNames[0];
      const ws = workbook.Sheets[sheetName];
      const rawData = XLSX.utils.sheet_to_json(ws, { defval: '' });
      
      // Очищаем заголовки колонок от переносов строк
      sheetData = cleanColumnHeaders(rawData);
      
      // Сбрасываем состояние кнопок
      dom.startBtn.disabled = false;
      dom.pauseBtn.disabled = true;
      dom.resumeBtn.disabled = true;
      dom.stopBtn.disabled = true;
      dom.downloadXlsx.disabled = true;
      dom.downloadCsv.disabled = true;
      
      // Определяем названия для новых колонок один раз
      definePriceColumns();
      
      populateColumnSelect();
      // авто-выбор колонки
      const guess = inferColumnName();
      if (guess) dom.columnSelect.value = guess;
      dom.startBtn.disabled = sheetData.length === 0;
      log(`Файл загружен: ${file.name}. Строк: ${sheetData.length}`);
      // Если фон уже накопил результаты — сольём сразу
      chrome.runtime.sendMessage({ type: 'queue:getStatus' }, (resp) => {
        try {
          if (chrome.runtime.lastError) {
            console.log('Background script not available:', chrome.runtime.lastError.message);
            return;
          }
          if (resp && resp.results) {
            mergeResultsIntoSheet(resp.results);
            if (Object.keys(resp.results).length) {
              dom.downloadXlsx.disabled = false;
              dom.downloadCsv.disabled = false;
            }
          }
        } catch (_e) {
          console.log('Error processing background response:', _e);
        }
      });
      debounceSave();
    } catch (err) {
      log('Ошибка чтения файла: ' + (err && err.message || err));
    }
  };
  reader.readAsArrayBuffer(file);
}

function attachEvents() {
  dom.fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) readFile(f);
  });

  dom.autoDetect.addEventListener('click', () => {
    const guess = inferColumnName();
    if (guess) {
      dom.columnSelect.value = guess;
      log('Колонка определена автоматически: ' + guess);
    } else {
      log('Не удалось определить колонку с наименованием. Выберите вручную.');
    }
  });

  dom.startBtn.addEventListener('click', () => {
    if (!sheetData.length) return;
    const key = dom.columnSelect.value || inferColumnName();
    const items = sheetData.map(row => String(row[key] ?? '')).filter(Boolean);
    const delayMs = Math.max(1000, Number(dom.delaySec.value || 3) * 1000);
    const cfg = {
      engine: dom.engineSelect.value,
      delayMs,
      useQuotes: dom.useQuotes.checked,
      limitCount: Number(dom.limitCount.value || 100),
      googleHl: dom.googleHl.value || 'ru',
      googleGl: dom.googleGl.value || 'ru'
    };
    dom.startBtn.disabled = true;
    dom.pauseBtn.disabled = false;
    dom.stopBtn.disabled = false;
    dom.downloadXlsx.disabled = true;
    dom.downloadCsv.disabled = true;
    setProgress(0, items.length);
    log(`Старт: ${items.length} запросов, движок: ${cfg.engine}`);
    chrome.runtime.sendMessage({ type: 'queue:start', items, cfg }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Background script not available:', chrome.runtime.lastError.message);
        log('Ошибка: background script недоступен');
        dom.startBtn.disabled = false;
        dom.pauseBtn.disabled = true;
        dom.stopBtn.disabled = true;
      }
    });
    debounceSave();
  });

  dom.pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'queue:pause' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Background script not available:', chrome.runtime.lastError.message);
      }
    });
    debounceSave();
  });
  dom.resumeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'queue:resume' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Background script not available:', chrome.runtime.lastError.message);
      }
    });
    debounceSave();
  });
  dom.stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'queue:stop' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Background script not available:', chrome.runtime.lastError.message);
      }
    });
    debounceSave();
  });

  dom.downloadXlsx.addEventListener('click', downloadXlsx);
  dom.downloadCsv.addEventListener('click', downloadCsv);
}

// Сообщения от background
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'queue:state') {
    const { state } = msg;
    dom.pauseBtn.disabled = state !== 'running';
    dom.resumeBtn.disabled = state !== 'paused';
    if (state === 'idle') {
      dom.stopBtn.disabled = true;
      dom.startBtn.disabled = false;
    }
  }
  if (msg.type === 'queue:tick') {
    const { i, total, task, result } = msg;
    setProgress(i, total);
    if (result) {
      // Расширяем текущие данные таблицы новыми колонками справа
      const key = dom.columnSelect.value || inferColumnName();
      const row = sheetData.find(r => String(r[key]) === String(task));
      if (row) {
        row[priceColumns.min] = result.min;
        row[priceColumns.max] = result.max;
        row[priceColumns.avg] = result.avg;
        row[priceColumns.currency] = result.currency;
      }
      log(`OK: ${task} → ${result.currency} min=${result.min}, avg=${result.avg}, max=${result.max}`);
      debounceSave();
    } else {
      log(`Нет данных: ${task}`);
    }
  }
  if (msg.type === 'queue:done') {
    dom.pauseBtn.disabled = true;
    dom.resumeBtn.disabled = true;
    dom.stopBtn.disabled = true;
    dom.startBtn.disabled = false;
    dom.downloadXlsx.disabled = false;
    dom.downloadCsv.disabled = false;
    log('Готово. Можно скачать результат.');
    debounceSave();
  }
  if (msg.type === 'queue:captcha') {
    log('Похоже, капча. Процесс поставлен на паузу. Решите капчу и нажмите «Продолжить».');
    dom.pauseBtn.disabled = true;
    dom.resumeBtn.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await restoreState();
  
  // Разрешаем кнопке Пуск активироваться только после выбора файла
  dom.fileInput.addEventListener('change', function(){
    dom.startBtn.disabled = !dom.fileInput.files || dom.fileInput.files.length === 0;
  });
  
  attachEvents();
});