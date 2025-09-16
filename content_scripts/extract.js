// extract.js — выполняется в контексте страницы поиска. Возвращает сгруппированные по валюте цены.
 (function(){
const containers = [
 '#search', // Google
 '#b_content, #b_results', // Bing
 'main, #search-result, #search-result-aside, .serp-list', // Yandex
 '#links, #web_content_wrapper' // DuckDuckGo
];


const root = document.querySelector(containers.join(',')) || document.body;


// Собираем текст из блоков результатов и отбрасываем навигацию/футер
const blacklistSelectors = ['nav', 'header', 'footer', 'form', 'input', 'button', 'script', 'style'];
blacklistSelectors.forEach(sel => root.querySelectorAll(sel).forEach(el => el.remove()));


const text = root.innerText || '';


// Парсинг цен. Ищем ₽, руб, $, €, ₴, ₸, byn/usd/eur
// Захватываем как «₽ 12 345,67», так и «12 345 руб.» и с тонкими пробелами.
const nbsp = '\\u00A0\\u202F';
const curLeft = '(?:[€$₽₴₸])|(?:\\b(?:usd|eur|byn)\\b)';
const curRight = '(?:[€$₽₴₸]|руб(?:\\.|лей|)\\b|грн\\b|тенге\\b|byn\\b|usd\\b|eur\\b)';
const num = `\\d{1,3}(?:[ ${nbsp}]?\\d{3})*(?:[.,]\\d{2})?`;
const re = new RegExp(`(?:(?:${curLeft})[ ]?(${num})|(${num})[ ]?(?:${curRight}))`, 'gim');


const currencyFromToken = (tok) => {
tok = (tok || '').toLowerCase();
if (/₽|руб/.test(tok)) return 'RUB';
if (/\$|usd/.test(tok)) return 'USD';
if (/€|eur/.test(tok)) return 'EUR';
if (/₴|грн/.test(tok)) return 'UAH';
if (/₸|тенге/.test(tok)) return 'KZT';
if (/byn/.test(tok)) return 'BYN';
return 'UNK';
};


const grouped = { RUB: {values:[], samples:[]}, USD:{values:[],samples:[]}, EUR:{values:[],samples:[]}, UAH:{values:[],samples:[]}, KZT:{values:[],samples:[]}, BYN:{values:[],samples:[]}, UNK:{values:[],samples:[]} };


// Чтобы понять валюту, пробежимся по матчу и возьмем соседние символы
let m;
const contextWindow = 6; // символов слева и справа для детекции знака валюты
while ((m = re.exec(text)) !== null) {
const idx = m.index;
const s = Math.max(0, idx - contextWindow);
const e = Math.min(text.length, re.lastIndex + contextWindow);
const ctx = text.slice(s, e);


// токены слева/справа больше не используются напрямую, оставлено для читаемости


const rawNum = (m[1] || m[2] || '').replace(new RegExp(`[ ${nbsp}]`, 'g'), '').replace(/,(\d{2})$/, '.$1');
if (!rawNum) continue;
const val = Number(rawNum);
if (!isFinite(val) || val <= 0) continue;


const cur = currencyFromToken(ctx) || 'UNK';
if (!grouped[cur]) grouped[cur] = { values: [], samples: [] };
// Дедуп по значению (приближенно)
const already = grouped[cur].values.some(v => Math.abs(v - val) < 0.009);
if (!already) {
grouped[cur].values.push(val);
grouped[cur].samples.push(ctx.replace(/\n/g,' ').trim());
}
}


// Немного почистим от совсем странных значений (телефоны и т.п.)
const prune = (arr) => arr.filter(v => v >= 1 && v <= 1e8);
Object.values(grouped).forEach(g => { g.values = prune(g.values); });


return { captcha: false, grouped };
})();