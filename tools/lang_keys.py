# Every English text the page looks up (T, TP in web/livemap.js; the words written in web/index.html; the tables
# whose words are looked up as they're shown), and a check of each language's table against them.
#   python tools/lang_keys.py              list them (web/lang/keys.json: key -> what it is)
#   python tools/lang_keys.py check        every language's table: missing words, extra words, {names} that differ
import json, os, re, sys
from html.parser import HTMLParser

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
js = open(os.path.join(root, 'livemap.js'), encoding='utf-8').read()
html = open(os.path.join(root, 'index.html'), encoding='utf-8').read()

keys = {}          # English -> a hint of where it's used
plurals = {}       # the "other" English of a count -> its "one"


def unquote(q):
    body = q[1:-1]
    return re.sub(r"\\(.)", r"\1", body)


STR = r"""('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")"""
for m in re.finditer(r"\bT\(\s*" + STR, js):
    k = unquote(m.group(1))
    if k:
        keys.setdefault(k, 'script')
for m in re.finditer(r"\bTP\(\s*[^,]+,\s*" + STR + r",\s*" + STR, js):
    one, other = unquote(m.group(1)), unquote(m.group(2))
    plurals[other] = one
    keys.setdefault(other, 'count')
# a lock's kind, looked up by name in a table of its own
for m in re.finditer(r"const lockName = kind => T\(\{(.*?)\}", js):
    for v in re.findall(r":\s*" + STR, m.group(1)):
        keys.setdefault(unquote(v), 'lock kind')
# the words of the tables looked up as they're shown: the rows of buttons (segment), the bot mods
for name in ['LOOT_MODES', 'INTEL']:
    block = re.search(r"const " + name + r" = \[(.*?)\];", js, re.S).group(1)
    for row in re.finditer(r"\[\s*" + STR + r",\s*" + STR + r",\s*" + STR + r"\s*\]", block):
        keys.setdefault(unquote(row.group(2)), 'button')
        keys.setdefault(unquote(row.group(3)), 'button tooltip')
# the events panel's row of buttons: [value, words]
block = re.search(r"const EVENT_KINDS = \[(.*?)\];", js, re.S).group(1)
for row in re.finditer(r"\[\s*" + STR + r",\s*" + STR + r"\s*\]", block):
    keys.setdefault(unquote(row.group(2)), 'button')
block = re.search(r"const BOT_MODS = \{(.*?)\};", js, re.S).group(1)
for v in re.findall(r"\w+:\s*" + STR, block):
    keys.setdefault(unquote(v), 'tooltip')
# map names, as the maps have them (meta.json "name")
for k in ['Customs', 'Factory', 'Ground Zero', 'Icebreaker', 'Interchange', 'Lighthouse', 'Reserve', 'Shoreline',
          'Streets of Tarkov', 'Terminal', 'The Lab', 'The Labyrinth', 'Woods']:
    keys.setdefault(k, 'map name')


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        for a, v in attrs:
            if a in ('title', 'placeholder', 'aria-label') and v and re.search(r'\w\w', v):
                keys.setdefault(re.sub(r'[ \t]*\n[ \t]*', '\n', v).strip(), 'page ' + a)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip -= 1

    def handle_data(self, data):
        if self.skip:
            return
        s = data.strip()
        if s and re.search(r'[^\W\d_]{2}', s):
            keys.setdefault(re.sub(r'\s+', ' ', s), 'page text')


Page().feed(html)
# the page's title and the language picker's own names aren't looked up
for k in ['Satellite', 'ORBIT']:
    keys.pop(k, None)

LANGS = ['ru', 'zh', 'de', 'fr', 'es', 'pt', 'pl', 'ja', 'ko']
names = lambda s: sorted(set(re.findall(r'\{(\w+)\}', s)))

if len(sys.argv) > 1 and sys.argv[1] == 'check':
    bad = 0
    for code in LANGS:
        path = os.path.join(root, 'lang', code + '.js')
        if not os.path.exists(path):
            print(code, 'NO FILE')
            bad += 1
            continue
        src = open(path, encoding='utf-8').read()
        body = src[src.index('fumsLang(') + len('fumsLang('):src.rindex(')')]
        table = json.loads(body)
        missing = [k for k in keys if k not in table]
        extra = [k for k in table if k not in keys]
        wrong = []
        for k, v in table.items():
            forms = v.values() if isinstance(v, dict) else [v]
            for f in forms:
                if names(f) != names(k):
                    wrong.append(k)
        print(code, len(table), 'words;', len(missing), 'missing;', len(extra), 'not used;', len(wrong), 'with other {names}')
        for k in missing[:15]:
            print('   missing:', k[:100])
        for k in extra[:10]:
            print('   not used:', k[:100])
        for k in wrong[:10]:
            print('   {names}:', k[:100])
        bad += len(missing) + len(wrong)
    sys.exit(1 if bad else 0)

os.makedirs(os.path.join(root, 'lang'), exist_ok=True)
out = {k: (v if k not in plurals else 'count; one: ' + plurals[k]) for k, v in keys.items()}
sys.stdout.reconfigure(encoding='utf-8')
print(len(out), 'words,', sum(len(k) for k in out), 'letters')
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lang_keys.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
