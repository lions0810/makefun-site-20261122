// A fast drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns, byte for byte, but faster.
//
// How it gets there (all semantics are makefun-site's own, as its README and code state them):
//  - Templates are compiled once per case into plain JavaScript functions (via the
//    Function constructor) with includes inlined up to the 8-deep cap, loop variables
//    resolved to locals at compile time, and values read with direct property access
//    instead of a node walk with a scope chain.
//  - Markdown is rendered in one fused pass over the lines (no token list), with a
//    single-pass inline renderer that keeps literal runs as slices and only escapes
//    where the escape table says so.
//  - Front matter is parsed with hand-rolled scans instead of a regex per line, and
//    slugs are cached per build (tag names repeat a lot).
//  - Nothing is cached from one case to the next: every run() rebuilds everything.
//
// Node 22 stdlib only. No network, clock, environment or randomness is read.

const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_REPLACE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The slug of `text`, cached per build in `cache`. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    // Plain ASCII: NFKD is the identity and there are no combining marks to drop.
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = `${slug}-${n++}`;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

/** Whether the code unit is JavaScript whitespace (\s). */
function isWSCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 ||
    c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 ||
    c === 12288 || c === 65279;
}

/** Whether `line` holds only spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** `text` with its trailing spaces and tabs dropped. */
function stripTrailingWS(text) {
  let b = text.length;
  while (b > 0 && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
  return b === text.length ? text : text.slice(0, b);
}

// ---------------------------------------------------------------- front matter

const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERROR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyName(key) {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

function isTemplateName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  if (raw.charCodeAt(0) === 45 || raw.charCodeAt(raw.length - 1) === 45) return false;
  let prevDash = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function parseStringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (ch === '"') return { error: 'a quoted string holds a stray quote' };
      else out += ch;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function parseDateValue(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERROR };
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return { error: DATE_ERROR };
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return { error: DATE_ERROR };
  return { value: raw };
}

function parseTagsValue(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = inner.split(',').map((t) => t.trim());
  for (const t of tags) {
    if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
  }
  return { value: tags };
}

/** One key's value, or why it is refused. */
function parseKeyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseStringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return parseDateValue(raw);
    case 'tags':
      return parseTagsValue(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const firstEnd = nl0 === -1 ? text.length : nl0;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  // The closing line is a line that is exactly '---': find it by scanning for '\n---' starts.
  let closeStart = -1;
  let search = firstEnd;
  for (;;) {
    const idx = text.indexOf('\n---', search);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx + 1;
      break;
    }
    search = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const closeEnd = closeStart + 3;
  const data = {};
  const fmText = text.slice(firstEnd + 1, closeStart - 1);
  const fmLines = fmText.split('\n');
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci < 1) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, ci);
    if (!isKeyName(key)) return { error: `line ${j + 2} is not "key: value"` };
    const rest = line.slice(ci + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = stripTrailingWS(rest.slice(1));
    else return { error: `line ${j + 2} is not "key: value"` };
    if (!KNOWN_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = parseKeyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  let body = text.slice(closeEnd);
  if (body.charCodeAt(0) === 10) body = body.slice(1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

/** The language of a fence-opening line, or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (line.charCodeAt(k) === 35) k++;
  if (k < 1 || k > 6) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let a = k;
  while (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { depth: k, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.startsWith('---') || line.startsWith('***')) {
    for (let k = 3; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return false;
}

/** A bullet list item's text, or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list item's start number and text, or null. */
function orderedItem(line) {
  let d = 0;
  while (d < 9) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let k = 0;
  while (line.charCodeAt(k) === 32) k++;
  if (k < 2) return false;
  const c = line.charCodeAt(k);
  return !Number.isNaN(c) && !isWSCode(c);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

const ESCAPABLES = '\\`*_[]()#+-.!>';
const ESCAPABLE_CC = new Uint8Array(128);
for (const ch of ESCAPABLES) ESCAPABLE_CC[ch.charCodeAt(0)] = 1;
const ESC_ENT = [];
ESC_ENT[38] = '&amp;';
ESC_ENT[60] = '&lt;';
ESC_ENT[62] = '&gt;';
ESC_ENT[34] = '&quot;';
ESC_ENT[39] = '&#39;';
const WS_RE = /\s/;
/** The next inline-special character: a backslash, backtick, *, [, or an HTML-special character. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * or -1. A match is escaped when an odd run of backslashes stands right before it
 * (backslashes pair up left to right, so an even run leaves it unescaped).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let r = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      r++;
      k--;
    }
    if (r % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let r = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      r++;
      k--;
    }
    if (r % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. A single regex scan
 * jumps between the characters that can start a construct, so long literal runs
 * are sliced whole instead of stepped through character by character. The shared
 * regex's position is saved and restored around the recursive calls (a strong,
 * emphasis or link body is rendered by the same function).
 */
function inline(s, link) {
  const out = [];
  let lit = 0;
  const n = s.length;
  const saved = SPECIAL_RE.lastIndex;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    const cc = s.charCodeAt(i);
    if (cc === 92) {
      // Backslash: escapes one of the escapable characters (only '>' of those is HTML-special).
      if (i + 1 < n && ESCAPABLE_CC[s.charCodeAt(i + 1)] === 1) {
        if (i > lit) out.push(s.slice(lit, i));
        out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
        lit = i + 2;
        SPECIAL_RE.lastIndex = i + 2;
      } else {
        SPECIAL_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (cc === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > lit) out.push(s.slice(lit, i));
        out.push('<code>', escHtml(s.slice(i + 1, j)), '</code>');
        lit = j + 1;
        SPECIAL_RE.lastIndex = j + 1;
      } else {
        SPECIAL_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (cc === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > lit) out.push(s.slice(lit, i));
          out.push('<strong>', inline(s.slice(i + 2, j), link), '</strong>');
          lit = j + 2;
          SPECIAL_RE.lastIndex = j + 2;
        } else {
          SPECIAL_RE.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > lit) out.push(s.slice(lit, i));
        out.push('<em>', inline(s.slice(i + 1, j), link), '</em>');
        lit = j + 1;
        SPECIAL_RE.lastIndex = j + 1;
      } else {
        SPECIAL_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (cc === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > lit) out.push(s.slice(lit, i));
        out.push('<a href="', escHtml(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
        lit = mm + 1;
        SPECIAL_RE.lastIndex = mm + 1;
      } else {
        SPECIAL_RE.lastIndex = i + 1;
      }
      continue;
    }
    // An HTML-special character on its own.
    if (i > lit) out.push(s.slice(lit, i));
    out.push(ESC_ENT[cc]);
    lit = i + 1;
    SPECIAL_RE.lastIndex = i + 1;
  }
  if (n > lit) out.push(s.slice(lit, n));
  SPECIAL_RE.lastIndex = saved;
  return out.join('');
}

/**
 * `src` rendered in one fused pass: its HTML, its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = lang === '' ? '<pre><code>' : `<pre><code class="language-${escHtml(lang)}">`;
      for (const l of body) {
        code += escHtml(l);
        code += '\n';
      }
      code += '</code></pre>';
      blocks.push(code);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.startsWith('> ') ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        if (isOrdered) {
          const m = orderedItem(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const t = bulletText(lines[i]);
          if (t !== null) {
            items.push([trimLine(t)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const w = c > 32
      ? !(c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279)
      : !((c >= 9 && c <= 13) || c === 32);
    if (w && !inWord) count++;
    inWord = w;
  }
  return count;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function templateTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(templateTextOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function templateTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a template (and, inlined, everything it includes, up to the depth cap)
 * into a function (R, O, esc, textOf, truthy) that appends its rendering to O.
 * Loop variables are resolved to locals at compile time; a first name no enclosing
 * loop binds is read from the root values R, guarded by hasOwn so prototype names
 * behave as undefined, exactly as the scope-chain lookup does. Straight-line text
 * and value nodes are batched into one push call each.
 */
function compileTemplate(templates, name) {
  let uid = 0;
  const code = [];
  const bindings = [];
  let pending = [];
  let pendingOut = null;
  function flush() {
    if (pending.length === 0) return;
    code.push(`${pendingOut}.push(${pending.join(', ')});`);
    pending = [];
    pendingOut = null;
  }
  function addPush(out, expr) {
    if (pendingOut !== null && pendingOut !== out) flush();
    pendingOut = out;
    pending.push(expr);
  }
  function pathExpr(path) {
    const first = path[0];
    let expr;
    for (let b = bindings.length - 1; b >= 0; b--) {
      if (bindings[b].tpl === first) {
        expr = bindings[b].gen;
        break;
      }
    }
    if (expr === undefined) expr = `(Object.hasOwn(R,${JSON.stringify(first)}) ? R[${JSON.stringify(first)}] : undefined)`;
    if (path.length === 1) return expr;
    const t = `t${uid++}`;
    code.push(`let ${t} = ${expr};`);
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      code.push(`${t} = (${t} !== null && typeof ${t} === 'object' && Object.hasOwn(${t}, ${seg})) ? ${t}[${seg}] : undefined;`);
    }
    return t;
  }
  function genNodes(nodes, depth, out) {
    for (const n of nodes) {
      if (n.kind === 'text') {
        addPush(out, JSON.stringify(n.text));
      } else if (n.kind === 'var') {
        const e = pathExpr(n.path);
        addPush(out, `esc(textOf(${e}))`);
      } else if (n.kind === 'raw') {
        const e = pathExpr(n.path);
        addPush(out, `textOf(${e})`);
      } else if (n.kind === 'if') {
        flush();
        const e = pathExpr(n.path);
        code.push(`if (truthy(${e}) !== ${n.not}) {`);
        genNodes(n.then, depth, out);
        if (n.else !== null) {
          code.push('} else {');
          genNodes(n.else, depth, out);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        flush();
        const e = pathExpr(n.path);
        const id = uid++;
        const xs = `x${id}`;
        const kk = `k${id}`;
        const ll = `l${id}`;
        const vv = `v${id}`;
        code.push(`const ${xs} = ${e};`);
        code.push(`if (Array.isArray(${xs})) {`);
        code.push(`const ${ll} = { index: 0, first: false, last: false, length: ${xs}.length };`);
        code.push(`for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) {`);
        code.push(`const ${vv} = ${xs}[${kk}]; ${ll}.index = ${kk} + 1; ${ll}.first = ${kk} === 0; ${ll}.last = ${kk} === ${xs}.length - 1;`);
        bindings.push({ tpl: n.name, gen: vv }, { tpl: 'loop', gen: ll });
        genNodes(n.body, depth, out);
        bindings.pop();
        bindings.pop();
        code.push('}');
        code.push('}');
      } else if (n.kind === 'include') {
        if (depth < INCLUDE_DEPTH && templates.has(n.name)) genNodes(templates.get(n.name), depth + 1, out);
      }
    }
    flush();
  }
  genNodes(templates.get(name), 0, 'O');
  return new Function('R', 'O', 'esc', 'textOf', 'truthy', code.join('\n'));
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, cards) {
  const card = s.post ? cards.get(s) : cardOf(s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = input.files.slice().sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const compiled = new Map();
  // One root-values object per build, reused across renders: the page values are
  // reset to null before each render (null behaves exactly like an absent value
  // for every template operation: text, truthiness, array test and path lookup).
  const rootVars = { site, tags: allTags, recent, page: null, posts: null, pager: null, tag: null };
  const outBuf = [];
  const render = (name, vars) => {
    let fn = compiled.get(name);
    if (fn === undefined) {
      if (!templates.has(name)) return null;
      fn = compileTemplate(templates, name);
      compiled.set(name, fn);
    }
    rootVars.page = vars.page ?? null;
    rootVars.posts = vars.posts ?? null;
    rootVars.pager = vars.pager ?? null;
    rootVars.tag = vars.tag ?? null;
    outBuf.length = 0;
    fn(rootVars, outBuf, escHtml, templateTextOf, templateTruthy);
    return outBuf.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
