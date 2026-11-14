// The page's language. Loaded before livemap.js: it picks the language, loads that language's table
// (lang/<code>.js, which calls fumsLang with it) and gives the page t() and tp() to look its words up in.
// Every word on the page is written in English in the page itself; a table maps that English to its own language,
// and anything a table hasn't got stays in English.
(function () {
  'use strict';
  // the languages there are, by their own names; English has no table
  const LANGS = [['en', 'English'], ['ru', 'Русский'], ['zh', '简体中文'], ['de', 'Deutsch'], ['fr', 'Français'],
    ['es', 'Español'], ['pt', 'Português (Brasil)'], ['pl', 'Polski'], ['ja', '日本語'], ['ko', '한국어']];
  // what the browser and the page call each one (for <html lang>, numbers and plurals)
  const TAGS = { en: 'en', ru: 'ru', zh: 'zh-CN', de: 'de', fr: 'fr', es: 'es', pt: 'pt-BR', pl: 'pl', ja: 'ja', ko: 'ko' };
  const known = code => LANGS.some(l => l[0] === code);

  // The one picked in the page (kept with its other settings), else ?lang=, else the browser's own if there's a
  // table for it, else English. ?lang=xx: every word looked up is shown in ⟦ ⟧, to find any that never are.
  const asked = new URLSearchParams(location.search).get('lang');
  let picked = null;
  try { picked = (JSON.parse(localStorage.getItem('livemap') || '{}') || {}).lang || null; } catch (e) { /* none kept */ }
  const fromBrowser = () => {
    for (const tag of navigator.languages || [navigator.language || 'en']) {
      const code = String(tag).toLowerCase().split('-')[0];
      if (known(code)) return code;
    }
    return 'en';
  };
  const pseudo = asked === 'xx';
  const code = known(asked) ? asked : known(picked) ? picked : fromBrowser();

  let table = {};
  window.fumsLang = words => { table = words || {}; };
  const plural = new Intl.PluralRules(TAGS[code]);
  // the English with the {names} in it filled in
  const fill = (text, vars) => !vars ? text : text.replace(/\{(\w+)\}/g, (all, k) => vars[k] !== undefined ? vars[k] : all);
  const mark = text => pseudo ? '⟦' + text + '⟧' : text;
  // T('Floor {n} of {of}', { n: 2, of: 5 }). Where one English word means two things, the key says which first:
  // T('difficulty|Hard') is shown as "Hard" in English.
  const t = (english, vars) => {
    if (!english) return english;
    const found = table[english];
    const text = typeof found === 'string' && found ? found : english.includes('|') ? english.slice(english.indexOf('|') + 1) : english;
    return mark(fill(text, vars));
  };
  // a count: TP(n, '{n} thing', '{n} things'). A table has the second as the key, and either one word for every
  // count or one for each of the language's forms ({ one, few, many, other }).
  const tp = (n, one, other, vars) => {
    const all = Object.assign({ n }, vars);
    const found = table[other];
    if (found && typeof found === 'object') {
      const form = found[plural.select(n)] || found.other || other;
      return mark(fill(form, all));
    }
    if (typeof found === 'string' && found) return mark(fill(found, all));
    return mark(fill(n === 1 ? one : other, all));
  };

  // Every word written in the page itself (index.html): its text, and what's said when the pointer is over a thing
  // (title), in a box before anything is typed (placeholder) and to a screen reader (aria-label). Done once, at the
  // start; what the page writes later it looks up itself.
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const wordy = s => /\p{L}{2}/u.test(s);
  function translatePage(root) {
    if (code === 'en' && !pseudo) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentNode && /^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    while (walk.nextNode()) nodes.push(walk.currentNode);
    for (const n of nodes) {
      const raw = n.nodeValue, text = raw.trim();
      if (!text || !wordy(text)) continue;
      const lead = raw.slice(0, raw.indexOf(text)), tail = raw.slice(raw.indexOf(text) + text.length);
      n.nodeValue = lead + t(text.replace(/\s+/g, ' ')) + tail;
    }
    for (const a of ATTRS) {
      for (const e of root.querySelectorAll('[' + a + ']')) {
        const v = e.getAttribute(a);
        if (v && wordy(v)) e.setAttribute(a, t(v.replace(/[ \t]*\n[ \t]*/g, '\n').trim()));
      }
    }
  }

  window.T = t;
  window.TP = tp;
  window.fumsLangs = { code, tag: TAGS[code], list: LANGS, pseudo, translatePage };
  document.documentElement.lang = TAGS[code];
  // the table, before livemap.js runs (it builds what it shows as it starts)
  if (code !== 'en') document.write('<script src="lang/' + code + '.js"><\/script>');
})();
