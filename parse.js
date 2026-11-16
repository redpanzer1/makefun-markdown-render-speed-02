// parse.js — a CommonMark 0.31.2 + GFM 0.29 markdown renderer, written from scratch.
// Dependency-free ES module. parse(markdown) returns the HTML that marked 18.1.3
// produces with its default options (gfm on, breaks off, pedantic off, async off).
//
// The implementation is my own: a line-aware block lexer, a two-phase inline
// lexer (flat atoms, then delimiter processing for emphasis / strikethrough),
// and a small renderer. No lookup of case outputs, no cross-call state.

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const REPLACEMENT = '\uFFFD';

// Decode a numeric character reference body (the digits after &# or &#x).
// Mirrors the HTML numeric-reference rules: 0, surrogates and values above
// U+10FFFF become U+FFFD; anything else becomes that code point.
function decodeNumeric(isHex, digits) {
  let cp = 0;
  if (isHex) {
    for (let i = 0; i < digits.length; i++) {
      const c = digits.charCodeAt(i);
      const v = c >= 48 && c <= 57 ? c - 48
        : c >= 97 && c <= 102 ? c - 87
        : c - 55;
      cp = cp * 16 + v;
      if (cp > 0x10ffff) return REPLACEMENT;
    }
  } else {
    for (let i = 0; i < digits.length; i++) {
      cp = cp * 10 + (digits.charCodeAt(i) - 48);
      if (cp > 0x10ffff) return REPLACEMENT;
    }
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(cp);
}

// Escape plain text for HTML output. Numeric character references are decoded
// first (&#169; -> the character, invalid ones -> U+FFFD); named entities such
// as &copy; pass through untouched; a bare & or an & that does not start a
// valid entity becomes &amp;. < > " ' are always escaped.
// True when a link label contains a nested reference that itself resolves
// to a link: a shortcut [x], a collapsed [x][], or a full [x][y] whose
// reference is defined. A link may not contain another link, so the outer
// bracket pair must not become a link in that case. Groups that are an
// image's label (![...] before a destination) are skipped: an image is
// allowed inside a link.
function labelHasResolvedRef(label, links) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    const c = label.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 91) { // [
      const isImg = i > 0 && label.charCodeAt(i - 1) === 33;
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        const d = label.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === 91) depth++;
        else if (d === 93) depth--;
        j++;
      }
      if (depth === 0) {
        const inner = label.slice(i + 1, j - 1);
        if (!isImg && links.has(normLabel(inner))) return true;
        if (label.charCodeAt(j) === 91) {
          let depth2 = 1, k = j + 1;
          while (k < n && depth2 > 0) {
            const d = label.charCodeAt(k);
            if (d === 92) { k += 2; continue; }
            if (d === 91) depth2++;
            else if (d === 93) depth2--;
            k++;
          }
          if (depth2 === 0) {
            const ref = label.slice(j + 1, k - 1);
            const key = ref === '' ? inner : ref;
            if (links.has(normLabel(key))) return true;
          }
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  return false;
}

// Plain-text rendering of a link label, for image alt text: emphasis,
// strong, strikethrough and links contribute only their text, code spans
// contribute their (escaped) content, and a nested image contributes its
// own alt text.
function labelPlainText(label, links) {
  let out = '';
  const walkList = (head) => {
    for (let p = head; p; p = p.next) {
      if (p.t === 0 || p.t === 2) out += p.s;
      else if (p.t === 1) out += escAll(p.s);
      else if (p.t === 4 || p.t === 7 || p.t === 8 || p.t === 9) {
        if (p.kids && p.kids.length > 0) walkList(resolveDelimiters(p.kids));
      } else if (p.t === 5) out += p.alt;
      else if (p.t === 6) {
        for (let i = 0; i < p.len; i++) out += p.ch;
      }
    }
  };
  walkList(resolveDelimiters(inlineAtoms(label, links, false, false)));
  return out;
}

// True when a label contains a nested inline link [x](...) that is not an
// image (![x](...)). A link may not contain another link, but an image's
// label may hold one (its text becomes part of the alt text).
function labelHasInlineLink(label) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    const c = label.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 96) { // backtick: skip the code span
      let j = i + 1;
      while (j < n && label.charCodeAt(j) !== 96) j++;
      i = j + 1;
      continue;
    }
    if (c === 91) { // [
      const isImg = i > 0 && label.charCodeAt(i - 1) === 33;
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        const d = label.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === 91) depth++;
        else if (d === 93) depth--;
        j++;
      }
      if (depth === 0 && !isImg && label.charCodeAt(j) === 40) return true; // (
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

// Is the label's closing ] (at closeIdx) inside an HTML tag? Scans the
// label text for <...> spans, respecting quoted attribute values. A ]
// inside a tag's attribute value does not close the label, so a match
// ending there is not a link at all.
function closerInTag(text, openIdx, closeIdx) {
  let i = openIdx;
  while (i < closeIdx) {
    if (text.charCodeAt(i) === 60) { // <
      const nx = text[i + 1];
      if (nx && (/[A-Za-z]/.test(nx) || nx === '/' || nx === '!' || nx === '?')) {
        let j = i + 1;
        let quote = 0;
        while (j < closeIdx) {
          const c = text.charCodeAt(j);
          if (quote !== 0) {
            if (c === quote) quote = 0;
          } else if (c === 34 || c === 39) {
            quote = c;
          } else if (c === 62) {
            break; // > closes the tag
          }
          j++;
        }
        if (j >= closeIdx) return true; // no > before the ]: ] is inside the tag
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return false;
}

function escText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      // Try a numeric reference: &#digits; (1-7) or &#x hex; (1-6).
      if (i + 2 < n && s.charCodeAt(i + 1) === 35) { // #
        let j = i + 2;
        let hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        const d0 = j;
        while (j < n) {
          const d = s.charCodeAt(j);
          const ok = hex
            ? (d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)
            : (d >= 48 && d <= 57);
          if (!ok) break;
          j++;
        }
        const dlen = j - d0;
        const maxLen = hex ? 6 : 7;
        if (dlen >= 1 && dlen <= maxLen && j < n && s.charCodeAt(j) === 59) { // ;
          const dec = decodeNumeric(hex, s.slice(d0, j));
          // A decoded character that is itself special is escaped.
          if (dec === '&') out += '&amp;';
          else if (dec === '<') out += '&lt;';
          else if (dec === '>') out += '&gt;';
          else if (dec === '"') out += '&quot;';
          else if (dec === "'") out += '&#39;';
          else out += dec;
          i = j + 1;
          continue;
        }
      }
      // Named entity: &word; passes through.
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122))) break;
        j++;
      }
      if (j > i + 1 && j < n && s.charCodeAt(j) === 59) {
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; } // <
    if (c === 62) { out += '&gt;'; i++; continue; } // >
    if (c === 34) { out += '&quot;'; i++; continue; } // "
    if (c === 39) { out += '&#39;'; i++; continue; } // '
    out += s[i];
    i++;
  }
  return out;
}

// Escape for code content: every & < > " ' is escaped, no entity decoding
// and no named-entity passthrough.
function escAll(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; continue; }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i];
    i++;
  }
  return out;
}

// Escape for href / title attributes: like escText but without decoding
// numeric references; a & that begins something looking like an entity
// (named, or numeric with 1-7 decimal / 1-6 hex digits and a ;) is kept.
function escAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      let j = i + 1;
      let kept = false;
      if (j < n && s.charCodeAt(j) === 35) { // # numeric
        j++;
        let hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        const d0 = j;
        while (j < n) {
          const d = s.charCodeAt(j);
          const ok = hex
            ? (d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)
            : (d >= 48 && d <= 57);
          if (!ok) break;
          j++;
        }
        if (j > d0 && j - d0 <= (hex ? 6 : 7) && j < n && s.charCodeAt(j) === 59) kept = true;
      } else {
        while (j < n) {
          const d = s.charCodeAt(j);
          if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122))) break;
          j++;
        }
        if (j > i + 1 && j < n && s.charCodeAt(j) === 59) kept = true;
      }
      if (kept) {
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i];
    i++;
  }
  return out;
}

// Clean a link destination the way browsers do for href attributes.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Is this single character ASCII punctuation?
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Normalize a link reference label: unescape backslash escapes, collapse
// runs of whitespace to one space, trim, lowercase.
function normLabel(s) {
  // Link labels are compared after collapsing whitespace and Unicode case
  // folding. Backslash escapes are NOT removed: the raw label text is what
  // is compared, so [foo\!] does not match a [foo!] definition.
  // Case folding: capital sharp S and sharp S both fold to "ss", and the
  // Greek final sigma folds to sigma.
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ẞ/g, 'ss').replace(/ς/g, 'σ');
}

// Find the index of the bracket that closes an opener at level 0, or -1.
// `b` is a two-character string like '()'. Backslash escapes are skipped.
// Used to balance parentheses inside link destinations.
function findClosingBracket(str, b) {
  if (str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return -1;
}

// Are the (unescaped) parentheses in a bare link destination balanced?
function parenBalanced(str) {
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === '(') level++;
    else if (str[i] === ')') { level--; if (level < 0) return false; }
  }
  return level === 0;
}

// Is this character Unicode whitespace?
function isSpaceCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

// Is this character Unicode punctuation? (Approximation covering the
// punctuation blocks that occur in practice; good enough for flanking.)
// CommonMark punctuation: ASCII punctuation plus Unicode general
// categories P (punctuation) and S (symbols), e.g. currency signs.
const RE_UNI_PUNCT = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  if (ch === undefined) return false;
  const c = ch.codePointAt(0);
  if (c < 128) return isAsciiPunct(ch);
  return RE_UNI_PUNCT.test(ch);
}

// ---------------------------------------------------------------------------
// Inline lexing
// ---------------------------------------------------------------------------
//
// Two phases. Phase A scans the text left to right and produces a flat list
// of atoms: text, raw html, code spans, links, images, hard breaks, and
// delimiter runs (*, _, ~). Phase B resolves the delimiter runs into
// emphasis / strong / strikethrough nodes with the CommonMark delimiter
// algorithm (with the extra rule that ~ runs must match in length).
//
// Atom shapes (plain objects, `t` is the kind):
//   { t: 0, s }            text, already HTML-escaped (or raw in raw blocks)
//   { t: 1, s }            raw html tag, emitted as-is
//   { t: 2, s }            code span content, already escaped
//   { t: 3 }               hard break <br>
//   { t: 4, href, title, kids }   link; kids is an atom list
//   { t: 5, href, title, alt }    image; alt is an escaped string
//   { t: 6, ch, len, open, close } delimiter run (resolved in phase B)
//   { t: 7, kids }         <em>
//   { t: 8, kids }         <strong>
//   { t: 9, kids }         <del>

const BT = String.fromCharCode(96);

// A link label: nested [...] groups (one level deep), HTML tags (a ]
// inside a tag's attribute value does not close the label), backslash
// escapes, `code` spans, or plain text. A nested group may be followed
// by ( — whether that makes an inline link inside the label is decided
// when the link is created (a link may not contain a link; an image's
// label may).
const LABEL_SRC = '(?:\\[(?:\\[(?:\\\\.|[^\\[\\]\\\\])*\\]|\\\\.|[^\\[\\]\\\\])*\\]|<\\/?[A-Za-z][^>]*>|\\\\.|' +
  BT + '[^' + BT + ']*' + BT + '|[^\\[\\]\\\\' + BT + '])*?';;
const HREF_SRC = '<(?:\\\\.|[^\\n<>\\\\])*>|(?!<)[^ \\t\\r\\n\\x00-\\x1f]*';
const TITLE_SRC = '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|\\((?:\\\\.|[^()\\\\])*\\)';

const RE_LINK = new RegExp('^!?\\[(' + LABEL_SRC + ')\\]\\([ \\t\\r\\n]*(' + HREF_SRC + ')(?:[ \\t\\r\\n]+(' + TITLE_SRC + '))?[ \\t\\r\\n]*\\)');
const RE_REFLINK = new RegExp('^!?\\[(' + LABEL_SRC + ')\\]\\[(' + LABEL_SRC + ')\\]');
const RE_NOLINK = /^!?\[((?:\[[^\[\]]*\]|\\[\[\]]|[^\[\]])*)\]/;
const RE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^ <>]*|[^ <>\\]+@[^ <>\\]+)>/;
const RE_TAG = new RegExp(
  '^<!-->' + '|' + '^<!--->' + '|' + '^<!--' + '[\\s\\S]*?' + '-->' + '|' +
  '^<[a-zA-Z][\\w-]*(?:\\s+[a-zA-Z_:][\\w.:-]*(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?)*\\s*/?>' + '|' +
  '^</[a-zA-Z][\\w-]*\\s*>' + '|' +
  '^<\\?[\\s\\S]*?\\?>' + '|' +
  '^<![A-Za-z]+\\s[\\s\\S]*?>' + '|' +
  '^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
);
const RE_URL = /^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._%+\-]+(@)[A-Za-z0-9.\-]+\.[A-Za-z]+/;
const RE_URL_SCHEME = /^(?:ftp|https?):\/\//i;

// Unescape backslash escapes (backslash + ASCII punctuation -> the punct).
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Trim a GFM extended autolink to its valid end: drop trailing punctuation
// (?, !, ., ,, :, ;, *, _, ~), drop a trailing entity-like ; run, drop
// unbalanced closing parens, and cut before a last unmatched opening paren.
function trimUrl(u) {
  let prev;
  do {
    prev = u;
    // Entity-like tail (&word; or &#...;) at the very end is not part of
    // it. This runs before the punctuation trim, so the trailing ';' of
    // an entity is not eaten first.
    if (u.endsWith(';')) {
      const amp = u.lastIndexOf('&', u.length - 2);
      if (amp !== -1) {
        const body = u.slice(amp + 1, -1);
        if (/^(?:#\d+|#[Xx][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*)$/.test(body)) {
          u = u.slice(0, amp);
          continue;
        }
      }
    }
    while (u.length > 0) {
      const c = u.charCodeAt(u.length - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
        c === 42 || c === 95 || c === 126) {
        u = u.slice(0, -1);
      } else break;
    }
    if (u.endsWith(')')) {
      let open = 0, close = 0;
      for (let i = 0; i < u.length; i++) {
        if (u[i] === '(') open++;
        else if (u[i] === ')') close++;
      }
      if (close > open) {
        u = u.slice(0, -1);
        continue;
      }
    }
    // A last '(' with no ')' after it cannot stand: cut before it.
    const lp = u.lastIndexOf('(');
    if (lp !== -1 && u.indexOf(')', lp) === -1) {
      u = u.slice(0, lp);
      continue;
    }
  } while (u !== prev);
  return u;
}

// Is the character before a `www.` start a word character?
function isWordCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) || c === 95;
}

// Is this code unit allowed inside an email local part?
function isEmailLocalCh(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 37 || c === 43 || c === 45 || c === 33 ||
    c === 35 || c === 36 || c === 38 || c === 39 || c === 42 || c === 47 ||
    c === 61 || c === 63 || c === 94 || c === 96 || c === 123 || c === 124 ||
    c === 125 || c === 126;
}

// Is the character at `pos` escaped by an odd run of backslashes?
function isEscaped(text, pos) {
  let n = 0, j = pos - 1;
  while (j >= 0 && text.charCodeAt(j) === 92) { n++; j--; }
  return n % 2 === 1;
}

// Collect up to `len` characters from the end of the processed content
// (textBuf + trailing text atoms and dead delimiter runs), without
// changing anything. Returns the collected string, or null when the
// content runs into an atom that is not plain text.
function trailingText(atoms, textBuf, len) {
  let out = '';
  let need = len;
  if (textBuf.length > 0) {
    const take = Math.min(need, textBuf.length);
    out = textBuf.slice(textBuf.length - take) + out;
    need -= take;
  }
  let idx = atoms.length - 1;
  while (need > 0 && idx >= 0) {
    const a = atoms[idx];
    if (a.t === 0) {
      const take = Math.min(need, a.s.length);
      out = a.s.slice(a.s.length - take) + out;
      need -= take;
    } else if (a.t === 6 && !a.open && !a.close) {
      const take = Math.min(need, a.len);
      out = a.ch.repeat(take) + out;
      need -= take;
    } else {
      return null;
    }
    idx--;
  }
  return need === 0 ? out : null;
}

// Remove `len` characters from the end of the processed content (the
// caller has already verified trailingText matches). Mutates atoms and
// returns the new textBuf.
function removeTrailing(atoms, textBuf, len) {
  let need = len;
  if (textBuf.length > 0) {
    const take = Math.min(need, textBuf.length);
    textBuf = textBuf.slice(0, textBuf.length - take);
    need -= take;
  }
  while (need > 0 && atoms.length > 0) {
    const a = atoms[atoms.length - 1];
    if (a.t === 0) {
      const take = Math.min(need, a.s.length);
      if (take === a.s.length) atoms.pop();
      else a.s = a.s.slice(0, a.s.length - take);
      need -= take;
    } else if (a.t === 6 && !a.open && !a.close) {
      const take = Math.min(need, a.len);
      if (take === a.len) atoms.pop();
      else a.len -= take;
      need -= take;
    } else {
      break;
    }
  }
  return textBuf;
}

// Match a GFM scheme/www autolink starting at `i` in `text`.
// Returns { url, len, isWww } with the url already backpedal-trimmed, or null.
function matchSchemeUrl(text, i) {
  // www. — lowercase only, and not preceded by a word character.
  if (text.charCodeAt(i) === 119 && text.startsWith('www.', i)) {
    if (isWordCh(i > 0 ? text[i - 1] : undefined)) return null;
    const m = /^(?:[A-Za-z0-9\-]+\.?)+[^\s<]*/.exec(text.slice(i + 4));
    if (!m) return null;
    const raw = 'www.' + m[0];
    const url = trimUrl(raw);
    if (url.length <= 4) return null;
    return { url, len: url.length, isWww: true };
  }
  // scheme:// — case-insensitive scheme.
  const sm = /^(?:ftp|https?):\/\//i.exec(text.slice(i));
  if (sm) {
    const m = /^(?:[A-Za-z0-9\-]+\.?)+[^\s<]*/.exec(text.slice(i + sm[0].length));
    if (!m) return null;
    const raw = sm[0] + m[0];
    const url = trimUrl(raw);
    if (url.length <= sm[0].length) return null;
    return { url, len: url.length, isWww: false };
  }
  return null;
}

// Phase A: scan text into a flat atom list. `links` maps normalized labels
// to { href, title }. `inLink` forbids nested links. `rawBlock` means the
// text sits inside <pre>/<code>/<kbd>/<script>/<style>, so it is not escaped.
function inlineAtoms(text, links, inLink, rawBlock) {
  const atoms = [];
  let textBuf = '';
  const flushText = () => {
    if (textBuf.length > 0) {
      atoms.push({ t: 0, s: rawBlock ? textBuf : escText(textBuf) });
      textBuf = '';
    }
  };
  // Track raw-block state (toggled by pre/code/kbd/script/style tags).
  let inRaw = rawBlock;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    // Backslash escape, or backslash-newline hard break.
    if (code === 92) { // backslash
      const nx = text[i + 1];
      if (nx === '\n') {
        flushText();
        atoms.push({ t: 3 });
        i += 2;
        // A hard break strips all leading spaces/tabs of the next line.
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        // The escaped character is its own atom, so a later & cannot be
        // mistaken for an entity start (e.g. \&ouml; stays literal).
        flushText();
        textBuf += nx;
        flushText();
        i += 2;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }

    // Code span.
    if (code === 96) { // backtick
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j;
      let close = -1;
      while (k < n) {
        if (text.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === run) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close !== -1) {
        let content = text.slice(j, close).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flushText();
        atoms.push({ t: 2, s: escAll(content) });
        i = close + run;
        continue;
      }
      // No matching closer: the whole backtick run is literal text.
      textBuf += text.slice(i, j);
      i = j;
      continue;
    }

    // Delimiter runs: * _ ~
    if (code === 42 || code === 95 || code === 126) { // * _ ~
      let j = i;
      while (j < n && text.charCodeAt(j) === code) j++;
      const run = j - i;
      const before = i > 0 ? text[i - 1] : undefined;
      const after = j < n ? text[j] : undefined;
      const beforeSpace = before === undefined || isSpaceCh(before);
      const afterSpace = after === undefined || isSpaceCh(after);
      const beforePunct = before !== undefined && isPunctCh(before);
      const afterPunct = after !== undefined && isPunctCh(after);
      const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
      const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
      let canOpen, canClose;
      if (code === 95) { // _ has the extra intraword rule
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flushText();
      atoms.push({ t: 6, ch, len: run, open: canOpen, close: canClose });
      i = j;
      continue;
    }

    // Hard break: two or more spaces before a newline (not at the very end).
    if (code === 32) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && text.charCodeAt(j) === 10) {
        // Only a break when something non-space follows the newline.
        let k = j + 1;
        while (k < n && isSpaceCh(text[k])) k++;
        if (k < n) {
          flushText();
          atoms.push({ t: 3 });
          i = j + 1;
          // A hard break strips all leading spaces/tabs of the next line.
          while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
          continue;
        }
      }
      textBuf += text.slice(i, j);
      i = j;
      continue;
    }

    // Autolink <...> and inline html tags.
    if (code === 60) { // <
      const rest = text.slice(i);
      const am = RE_AUTOLINK.exec(rest);
      if (am) {
        flushText();
        const raw = am[1];
        const disp = escText(raw);
        // A scheme autolink (<scheme:...>) keeps its text as the href; a
        // bare <user@host> gets mailto: prepended.
        const isScheme = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(raw);
        const href = isScheme ? disp : 'mailto:' + disp;
        atoms.push({ t: 4, href, title: null, kids: [{ t: 0, s: disp }] });
        i += am[0].length;
        continue;
      }
      const tm = RE_TAG.exec(rest);
      if (tm) {
        flushText();
        const tag = tm[0];
        atoms.push({ t: 1, s: tag });
        if (!inRaw && /^<(pre|code|kbd|script|style)[\s/>]/i.test(tag)) inRaw = true;
        else if (inRaw && /^<\/(pre|code|kbd|script|style)\s*>/i.test(tag)) inRaw = false;
        i += tag.length;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }

    // Links and images. A link may not contain another link, but it may
    // contain an image.
    if (code === 91 || (code === 33 && text.charCodeAt(i + 1) === 91)) { // [ or ![
      if (!inLink || code === 33) {
        const rest = text.slice(i);
        let lm = RE_LINK.exec(rest);
        // A ] inside an HTML tag does not close the label: not a link.
        if (lm) {
          const openLen = rest.charCodeAt(0) === 33 ? 2 : 1;
          if (closerInTag(rest, openLen, openLen + lm[1].length)) lm = null;
        }
        // A bare destination with unbalanced parentheses is not a link.
        if (lm) {
          let href0 = lm[2];
          const lp0 = href0.charCodeAt(0) === 60 ? -1 : findClosingBracket(href0, '()');
          if (lp0 > -1) href0 = href0.substring(0, lp0);
          if (href0.charCodeAt(0) !== 60 && !parenBalanced(href0)) lm = null;
        }
        // A label holding a reference that itself resolves is not a link.
        if (lm && labelHasResolvedRef(lm[1], links)) lm = null;
        // A link label holding an inline link is not a link (an image's
        // label may hold one).
        if (lm && rest.charCodeAt(0) !== 33 && labelHasInlineLink(lm[1])) lm = null;
        if (lm) {
          let href = lm[2];
          let title = lm[3] !== undefined ? lm[3] : null;
          let rawLen = lm[0].length;
          // Balance parentheses inside a bare destination; a paren
          // inside <...> is literal and never ends the destination.
          const lastParen = href.charCodeAt(0) === 60 ? -1 : findClosingBracket(href, '()');
          if (lastParen > -1) {
            const start = rest.charCodeAt(0) === 33 ? 5 : 4;
            const linkLen = start + lm[1].length + lastParen;
            href = href.substring(0, lastParen);
            rawLen = linkLen;
            title = null;
          }
          if (href.length >= 2 && href[0] === '<' && href[href.length - 1] === '>') {
            href = href.slice(1, -1);
          }
          href = unescapeBackslashes(href);
          if (title !== null) {
            const q = title[0];
            title = unescapeBackslashes(title.slice(1, -1));
            void q;
          }
          flushText();
          const isImg = rest.charCodeAt(0) === 33;
          if (isImg) {
            atoms.push({ t: 5, href, title, alt: labelPlainText(lm[1], links) });
          } else {
            const kids = inlineAtoms(lm[1], links, true, inRaw);
            atoms.push({ t: 4, href, title, kids });
          }
          i += rawLen;
          continue;
        }
        const rm = RE_REFLINK.exec(rest);
        if (rm) {
          const openLen = rest.charCodeAt(0) === 33 ? 2 : 1;
          if (closerInTag(rest, openLen, openLen + rm[1].length)) {
            // The first ] is inside an HTML tag: the whole [x][y] is
            // literal, and [x] does not fall back to a shortcut.
            textBuf += ch;
            i++;
            continue;
          }
          // A [x][y] that matched syntactically is resolved here or not at
          // all: [x] never falls back to being a shortcut link, and a label
          // holding a reference that itself resolves, or (for a link) an
          // inline link, is never a link.
          const badLabel = labelHasResolvedRef(rm[1], links) ||
            (rest.charCodeAt(0) !== 33 && labelHasInlineLink(rm[1]));
          if (!badLabel) {
            const label = rm[2] !== '' ? rm[2] : rm[1];
            const def = links.get(normLabel(label));
            if (def) {
              flushText();
              const isImg = rest.charCodeAt(0) === 33;
              if (isImg) {
                atoms.push({ t: 5, href: def.href, title: def.title, alt: labelPlainText(rm[1], links) });
              } else {
                const kids = inlineAtoms(rm[1], links, true, inRaw);
                atoms.push({ t: 4, href: def.href, title: def.title, kids });
              }
              i += rm[0].length;
              continue;
            }
          }
          textBuf += ch;
          i++;
          continue;
        }
        const nm = RE_NOLINK.exec(rest);
        if (nm && !closerInTag(rest, rest.charCodeAt(0) === 33 ? 2 : 1, (rest.charCodeAt(0) === 33 ? 2 : 1) + nm[1].length) && !labelHasResolvedRef(nm[1], links) &&
          !(rest.charCodeAt(0) !== 33 && labelHasInlineLink(nm[1]))) {
          const def = links.get(normLabel(nm[1]));
          if (def) {
            flushText();
            const isImg = rest.charCodeAt(0) === 33;
            if (isImg) {
              atoms.push({ t: 5, href: def.href, title: def.title, alt: labelPlainText(nm[1], links) });
            } else {
              const kids = inlineAtoms(nm[1], links, true, inRaw);
              atoms.push({ t: 4, href: def.href, title: def.title, kids });
            }
            i += nm[0].length;
            continue;
          }
        }
      }
      textBuf += ch;
      i++;
      continue;
    }

    // GFM extended autolinks: www. / scheme:// (checked at their first char).
    if (code === 119 || code === 104 || code === 102 || code === 72 || code === 70) {
      const hit = matchSchemeUrl(text, i);
      if (hit) {
        flushText();
        const disp = escText(hit.url);
        const href = hit.isWww ? 'http://' + disp : disp;
        atoms.push({ t: 4, href, title: null, kids: [{ t: 0, s: disp }] });
        i += hit.len;
        continue;
      }
      // fall through to plain text
    }
    // An email address: the local part is found by scanning back over the
    // raw text, and it may span trailing text atoms and dead delimiter
    // runs (e.g. the intraword _ in a.b-c_d@a.b).
    if (code === 64) { // @
      let ls = i - 1;
      while (ls >= 0 && isEmailLocalCh(text.charCodeAt(ls)) && !isEscaped(text, ls)) ls--;
      ls++;
      const localRaw = text.slice(ls, i);
      if (localRaw.length > 0) {
        const after = text.slice(i + 1);
        const dm = /^[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+/.exec(after);
        if (dm) {
          // A domain followed at once by - or _ is not an email at all
          // (the label would continue and end invalidly).
          const afterDomain = text[i + 1 + dm[0].length];
          if (afterDomain !== '-' && afterDomain !== '_') {
            // A mailto: or xmpp: prefix immediately before the local
            // part (at a word boundary) belongs to the autolink. An
            // xmpp: link also takes one path segment after the domain.
            let prefix = '';
            let claimLen = localRaw.length;
            let path = '';
            if (ls >= 7 && text.slice(ls - 7, ls).toLowerCase() === 'mailto:') {
              const beforeMailto = ls - 8 >= 0 ? text[ls - 8] : undefined;
              if (beforeMailto === undefined || !isWordCh(beforeMailto)) {
                prefix = text.slice(ls - 7, ls);
                claimLen += 7;
              }
            } else if (ls >= 5 && text.slice(ls - 5, ls).toLowerCase() === 'xmpp:') {
              const beforeXmpp = ls - 6 >= 0 ? text[ls - 6] : undefined;
              if (beforeXmpp === undefined || !isWordCh(beforeXmpp)) {
                prefix = text.slice(ls - 5, ls);
                claimLen += 5;
                const pm = /^\/[^\s<>\/]*/.exec(text.slice(i + 1 + dm[0].length));
                if (pm) path = pm[0];
              }
            }
            const got = trailingText(atoms, textBuf, claimLen);
            if (got !== null && got === prefix + localRaw) {
              textBuf = removeTrailing(atoms, textBuf, claimLen);
              flushText();
              const url = prefix + localRaw + '@' + dm[0] + path;
              const disp = escText(url);
              const href = prefix ? disp : 'mailto:' + disp;
              atoms.push({ t: 4, href, title: null, kids: [{ t: 0, s: disp }] });
              i += 1 + dm[0].length + path.length;
              continue;
            }
          }
        }
      }
      textBuf += ch;
      i++;
      continue;
    }

    textBuf += ch;
    i++;
  }
  flushText();
  return atoms;
}

// Phase B: resolve delimiter runs into em / strong / del nodes.
// Operates on a doubly linked list built from the atom array.
function resolveDelimiters(atoms) {
  // Build the linked list.
  let head = null, tail = null;
  for (const a of atoms) {
    const node = { ...a, prev: tail, next: null };
    if (tail) tail.next = node; else head = node;
    tail = node;
  }
  if (!head) return head;
  // Collect delimiter nodes in order.
  const delims = [];
  for (let p = head; p; p = p.next) if (p.t === 6) delims.push(p);
  if (delims.length === 0) return head;

  const removeNode = (node) => {
    if (node.prev) node.prev.next = node.next; else head = node.next;
    if (node.next) node.next.prev = node.prev; else tail = node.prev;
    node.prev = node.next = null;
  };
  const insertBefore = (node, before) => {
    node.prev = before.prev;
    node.next = before;
    if (before.prev) before.prev.next = node; else head = node;
    before.prev = node;
  };

  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer || closer.t !== 6 || closer.len === 0 || !closer.close) continue;
    // Find the matching opener: nearest preceding delimiter of the same char
    // that can open, subject to the odd/even rule for * and _.
    while (closer.len > 0 && closer.close) {
      let opener = null;
      for (let oi = di - 1; oi >= 0; oi--) {
        const cand = delims[oi];
        if (!cand || cand.t !== 6 || cand.len === 0 || cand.ch !== closer.ch || !cand.open) continue;
        // Skip a delimiter already swallowed into a wrapper (orphaned).
        if (cand.prev === null && cand.next === null && head !== cand) continue;
        if (cand.ch === '~') { // ~ requires equal lengths, and only 1 or 2
          if (cand.len !== closer.len || cand.len > 2) continue;
        } else {
          // Rule of three: when either delimiter can both open and close,
          // a sum divisible by 3 is forbidden unless both lengths are
          // multiples of 3.
          if ((cand.open && cand.close) || (closer.open && closer.close)) {
            const sum = cand.len + closer.len;
            if (sum % 3 === 0 && (cand.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
          }
        }
        opener = cand;
        break;
      }
      if (!opener) break;
      let use;
      if (opener.ch === '~') use = opener.len; // equal by the check above
      else use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const kind = opener.ch === '~' ? 9 : (use === 2 ? 8 : 7);
      // Gather the kids between opener and closer.
      const kids = [];
      for (let p = opener.next; p && p !== closer; p = p.next) kids.push(p);
      const wrap = { t: kind, kids, prev: null, next: null };
      // Remove the kids from the list (they live inside the wrapper now).
      for (const k of kids) removeNode(k);
      // Leftover delimiter text stays as plain delimiter atoms.
      opener.len -= use;
      closer.len -= use;
      if (opener.len === 0) removeNode(opener);
      // The wrapper goes right before the closer in all cases.
      insertBefore(wrap, closer);
      if (closer.len === 0) {
        removeNode(closer);
        break;
      }
    }
  }
  return head;
}

// Render an atom linked list to HTML.
function renderInlineList(head) {
  let out = '';
  for (let p = head; p; p = p.next) {
    out += renderAtom(p);
  }
  return out;
}

function renderAtom(a) {
  switch (a.t) {
    case 0: return a.s;
    case 1: return a.s;
    case 2: return '<code>' + a.s + '</code>';
    case 3: return '<br>';
    case 4: {
      const text = renderKids(a.kids);
      const clean = cleanUrl(a.href);
      if (clean === null) return text;
      let out = '<a href="' + escAttr(clean) + '"';
      if (a.title) out += ' title="' + escAttr(a.title) + '"';
      return out + '>' + text + '</a>';
    }
    case 5: {
      const clean = cleanUrl(a.href);
      if (clean === null) return a.alt;
      let out = '<img src="' + escAttr(clean) + '" alt="' + a.alt + '"';
      if (a.title) out += ' title="' + escAttr(a.title) + '"';
      return out + '>';
    }
    case 6: {
      let s = '';
      const ch = a.ch;
      for (let i = 0; i < a.len; i++) s += ch;
      return s;
    }
    case 7: return '<em>' + renderKids(a.kids) + '</em>';
    case 8: return '<strong>' + renderKids(a.kids) + '</strong>';
    case 9: return '<del>' + renderKids(a.kids) + '</del>';
    default: return '';
  }
}

// Render a wrapper's kids: resolve any delimiters inside them first.
function renderKids(kids) {
  if (!kids || kids.length === 0) return '';
  return renderInlineList(resolveDelimiters(kids));
}

// Turn a plain atom array (kids of a link / emphasis node) into a linked
// list; delimiter atoms inside have already been resolved by the caller.
function listFromAtoms(atoms) {
  if (!atoms || atoms.length === 0) return null;
  let head = null, tail = null;
  for (const a of atoms) {
    const node = { ...a, prev: tail, next: null };
    if (tail) tail.next = node; else head = node;
    tail = node;
  }
  return head;
}

// Full inline parse: atoms, delimiter resolution, render.
function parseInline(text, links) {
  if (text === '') return '';
  const atoms = inlineAtoms(text, links, false, false);
  const head = resolveDelimiters(atoms);
  return renderInlineList(head);
}

// ---------------------------------------------------------------------------
// Block lexing
// ---------------------------------------------------------------------------
//
// Block token shapes (`t` is the kind):
//   { t: 'space' }
//   { t: 'code', text, lang, fenced }
//   { t: 'heading', depth, text }
//   { t: 'hr' }
//   { t: 'blockquote', tokens }
//   { t: 'list', ordered, start, loose, items }  items: [{ tokens, task, checked }]
//   { t: 'html', text }
//   { t: 'paragraph', text }
//   { t: 'table', head, rows }  head/rows: [{ text, align }]
//   { t: 'text', text }
// Defs (link reference definitions) are collected into `links` and emit nothing.

// Index of the newline ending the line that starts at i, or src.length.
function lineEnd(src, i) {
  const j = src.indexOf('\n', i);
  return j === -1 ? src.length : j;
}

// Is the line [i, end) blank (only spaces/tabs)?
// Is the whole string blank (only spaces/tabs/newlines)?
function isBlankLineStr(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

function isBlankLine(src, i, end) {
  for (let k = i; k < end; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Leading whitespace of the line starting at i: its width in columns
// (a tab advances to the next multiple of 4) and the index of the first
// non-whitespace character.
function leadInfo(src, i, end) {
  let col = 0, k = i;
  while (k < end) {
    const c = src.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  return { col, next: k };
}

// The line [i, end) with `cols` columns of leading whitespace removed.
// A tab cut through mid-way becomes spaces for the remainder.
function stripCols(src, i, end, cols) {
  let col = 0, k = i;
  while (k < end && col < cols) {
    const c = src.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) {
      const adv = 4 - (col % 4);
      if (col + adv <= cols) { col += adv; k++; }
      else return ' '.repeat(col + adv - cols) + src.slice(k + 1, end);
    } else break;
  }
  return src.slice(k, end);
}

// Strip one blockquote marker from a line: up to 3 leading spaces, '>',
// then one space (a leading tab is expanded column-aware first).
function stripBlockquoteMarker(line) {
  let k = 0;
  const n = line.length;
  while (k < n && k < 3 && line.charCodeAt(k) === 32) k++;
  if (k >= n || line.charCodeAt(k) !== 62) return null; // not '>'
  k++;
  // Expand leading whitespace of the remainder column-aware, then drop 1 space.
  let rest = line.slice(k);
  let col = k;
  let r = 0;
  let spaces = '';
  while (r < rest.length) {
    const c = rest.charCodeAt(r);
    if (c === 32) { spaces += ' '; col++; r++; }
    else if (c === 9) { const adv = 4 - (col % 4); spaces += ' '.repeat(adv); col += adv; r++; }
    else break;
  }
  if (spaces.length > 0) spaces = spaces.slice(1);
  return spaces + rest.slice(r);
}

// Block-level html tag names that start a type-6 html block.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match an html block start at line [i, end). Returns the block kind
// (1..7) and the tag name for kind 1, or null.
function htmlBlockStart(src, i, end) {
  let k = i;
  let spaces = 0;
  while (k < end && spaces < 4 && src.charCodeAt(k) === 32) { k++; spaces++; }
  if (spaces >= 4 || k >= end || src.charCodeAt(k) !== 60) return null; // not '<'
  const rest = src.slice(k, end);
  let m;
  if ((m = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(rest))) return { kind: 1, tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { kind: 2, tag: null };
  if (rest.startsWith('<?')) return { kind: 3, tag: null };
  if (/^<![A-Za-z]/.test(rest)) return { kind: 4, tag: null };
  if (rest.startsWith('<![CDATA[')) return { kind: 5, tag: null };
  if ((m = /^<\/?([A-Za-z][\w-]*)(?:[ \t/>]|$)/.exec(rest))) {
    const name = m[1].toLowerCase();
    if (BLOCK_TAGS.has(name)) return { kind: 6, tag: name };
    // Kind 7 (any other tag) needs the tag closed on this line and
    // nothing but whitespace after it; otherwise it is a paragraph.
    // The tag itself must be well formed (proper attribute syntax);
    // a malformed tag such as <a h*#ref="hi"> is not an HTML block.
    const m7 = /^(?:<[a-zA-Z][\w-]*(?:\s+[a-zA-Z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[a-zA-Z][\w-]*\s*>)/.exec(rest);
    if (m7 && /^[ \t]*$/.test(rest.slice(m7[0].length))) return { kind: 7, tag: name };
    return null;
  }
  return null;
}

// Scan a fenced code block starting at line i. Returns { lang, text, next }
// or null when the line is not a fence.
function matchFences(src, i) {
  const end = lineEnd(src, i);
  const li = leadInfo(src, i, end);
  if (li.col > 3) return null;
  let k = li.next;
  const fenceCh = src.charCodeAt(k);
  if (fenceCh !== 96 && fenceCh !== 126) return null; // not ` or ~
  let run = 0;
  while (k < end && src.charCodeAt(k) === fenceCh) { run++; k++; }
  if (run < 3) return null;
  const info = src.slice(k, end);
  if (fenceCh === 96 && info.indexOf('`') !== -1) return null;
  // The language is the first word of the info string.
  const infoTrim = info.trim();
  const lang = infoTrim ? unescapeBackslashes(infoTrim.split(/\s+/)[0]) : '';
  const fenceIndent = li.col;
  // Find the closing fence: a line with <=3 spaces indent, the same char,
  // a run at least as long, then only spaces.
  let j = end + 1;
  const n = src.length;
  let closeStart = -1;
  while (j < n) {
    const le = lineEnd(src, j);
    const l2 = leadInfo(src, j, le);
    if (l2.col <= 3 && !isBlankLine(src, j, le)) {
      let m = l2.next;
      let r2 = 0;
      while (m < le && src.charCodeAt(m) === fenceCh) { r2++; m++; }
      if (r2 >= run) {
        let onlySpace = true;
        for (let q = m; q < le; q++) if (src.charCodeAt(q) !== 32 && src.charCodeAt(q) !== 9) { onlySpace = false; break; }
        if (onlySpace) { closeStart = j; break; }
      }
    }
    j = le + 1;
  }
  const contentStart = end + 1 <= n ? end + 1 : n;
  let text, next;
  if (closeStart !== -1) {
    text = stripFenceIndent(src, contentStart, closeStart, fenceIndent);
    // The newline immediately before the closing fence is not part of
    // the code; the text still ends with exactly one newline.
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    next = lineEnd(src, closeStart) + 1;
  } else {
    text = stripFenceIndent(src, contentStart, n, fenceIndent);
    next = n;
    // The code text always ends with a newline (even when the fence is
    // unclosed and the input ends without one).
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  }
  return { lang, text, next };
}

// The fenced code content: each line has the opening fence's indent
// stripped (up to that many columns).
function stripFenceIndent(src, from, to, indent) {
  if (indent === 0) return src.slice(from, to);
  let out = '';
  let j = from;
  while (j < to) {
    const le = lineEnd(src, j);
    out += stripCols(src, j, Math.min(le, to), indent);
    if (le < to) out += '\n';
    j = le + 1;
  }
  return out;
}

// Match an indented code block starting at line i. Returns { text, next }.
function matchIndentedCode(src, i) {
  const n = src.length;
  let text = '';
  let any = false;
  let j = i;
  while (j < n) {
    const le = lineEnd(src, j);
    if (isBlankLine(src, j, le)) {
      // A blank line belongs to the block only if a later indented line follows.
      // Each blank line contributes its own text with 4 columns stripped.
      let k = le + 1;
      let found = false;
      const blankLines = [];
      blankLines.push(stripCols(src, j, le, 4));
      while (k < n) {
        const le2 = lineEnd(src, k);
        if (isBlankLine(src, k, le2)) { blankLines.push(stripCols(src, k, le2, 4)); k = le2 + 1; continue; }
        const li2 = leadInfo(src, k, le2);
        if (li2.col >= 4) found = true;
        break;
      }
      if (!found) break;
      for (const b of blankLines) {
        text += b;
        text += '\n';
      }
      j = k;
      continue;
    }
    const li = leadInfo(src, j, le);
    if (li.col < 4) break;
    text += stripCols(src, j, le, 4);
    text += '\n';
    any = true;
    j = le + 1;
  }
  if (!any) return null;
  return { text, next: j };
}

// Match an ATX heading at line i. Returns { depth, text, next }.
function matchHeading(src, i) {
  const end = lineEnd(src, i);
  const li = leadInfo(src, i, end);
  if (li.col > 3) return null;
  let k = li.next;
  if (src.charCodeAt(k) !== 35) return null; // not '#'
  let depth = 0;
  while (k < end && src.charCodeAt(k) === 35) { depth++; k++; }
  if (depth > 6) return null;
  if (k < end && src.charCodeAt(k) !== 32 && src.charCodeAt(k) !== 9) return null;
  let text = src.slice(k, end);
  // Strip leading/trailing whitespace and a closing run of #s. The closing
  // run is stripped when it is preceded by a space, or when it is the
  // whole text (e.g. "### ###" is an empty h3).
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  return { depth, text, next: end + 1 };
}

// Is the line [i, end) a thematic break?
function isHrLine(src, i, end) {
  const li = leadInfo(src, i, end);
  if (li.col > 3) return false;
  let k = li.next;
  if (k >= end) return false;
  const c = src.charCodeAt(k);
  if (c !== 42 && c !== 45 && c !== 95) return false; // * - _
  let count = 0;
  while (k < end) {
    const d = src.charCodeAt(k);
    if (d === c) { count++; k++; }
    else if (d === 32 || d === 9) k++;
    else return false;
  }
  return count >= 3;
}

// Match a link reference definition at position i. Returns { next } and
// records the definition in links, or null.
function matchDef(src, i, links) {
  const n = src.length;
  const end = lineEnd(src, i);
  const li = leadInfo(src, i, end);
  if (li.col > 3) return null;
  let k = li.next;
  if (src.charCodeAt(k) !== 91) return null; // not '['
  // Label: no unescaped brackets inside (a \] is part of the label).
  // The label may span lines, but not a blank line.
  let l = k + 1;
  let label = '';
  while (l < n) {
    const c = src.charCodeAt(l);
    if (c === 92 && l + 1 < n) { // backslash: keep the escape pair
      label += src[l] + src[l + 1];
      l += 2;
      continue;
    }
    if (c === 91) return null; // unescaped '[' inside the label: not a def
    if (c === 93) break; // ]
    if (c === 10) {
      let r = l + 1;
      while (r < n && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
      if (r >= n || src.charCodeAt(r) === 10) return null; // blank line
    }
    label += src[l];
    l++;
  }
  if (l >= n || label.length === 0) return null;
  l++; // past ]
  if (l >= n || src.charCodeAt(l) !== 58) return null; // not ':'
  l++;
  // Optional whitespace, possibly across one newline.
  let p = l;
  while (p < n && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  if (p < n && src.charCodeAt(p) === 10) {
    p++;
    while (p < n && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  }
  if (p >= n) return null;
  // Destination: <...> or a run of non-space chars.
  let href;
  if (src.charCodeAt(p) === 60) { // <
    const gt = src.indexOf('>', p);
    const le = lineEnd(src, p);
    if (gt === -1 || gt > le) return null;
    href = src.slice(p + 1, gt);
    if (/[\n<>\\]/.test(href)) return null;
    p = gt + 1;
  } else {
    let q = p;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10) break;
      q++;
    }
    href = src.slice(p, q);
    if (href.length === 0) return null;
    p = q;
  }
  href = unescapeBackslashes(href);
  // Optional title on the same line, or on the next line if indented.
  let title = null;
  let after = p;
  // Skip spaces on this line.
  while (after < n && (src.charCodeAt(after) === 32 || src.charCodeAt(after) === 9)) after++;
  const tryTitle = (pos) => {
    if (pos >= n) return null;
    const c = src.charCodeAt(pos);
    if (c !== 34 && c !== 39 && c !== 40) return null; // " ' (
    const closeCh = c === 40 ? 41 : c;
    // A title may span lines, but not a blank line.
    let q = pos + 1;
    while (q < n) {
      if (src.charCodeAt(q) === 92) { q += 2; continue; } // backslash
      if (src.charCodeAt(q) === closeCh) {
        return { title: unescapeBackslashes(src.slice(pos + 1, q)), end: q + 1 };
      }
      if (src.charCodeAt(q) === 10) {
        // A blank line ends the title.
        let r = q + 1;
        while (r < n && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
        if (r >= n || src.charCodeAt(r) === 10) return null;
      }
      q++;
    }
    return null;
  };
  let t = tryTitle(after);
  // A same-line title needs whitespace between it and the destination.
  if (t && after === p) return null;
  let endPos;
  if (t) {
    title = t.title;
    endPos = t.end;
    // After the title only spaces to end of line.
    let r = endPos;
    const le = lineEnd(src, endPos);
    while (r < le && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
    if (r < le) return null;
    endPos = le + 1;
  } else {
    // No title on this line: maybe on the next line.
    const le = lineEnd(src, p);
    let r = p;
    while (r < le && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
    if (r < le) return null; // junk after the destination
    // Look at the next line for a title. Junk after it means the
    // definition simply has no title; the line stays a paragraph.
    const nl = le + 1;
    if (nl < n) {
      const le2 = lineEnd(src, nl);
      let s2 = nl;
      while (s2 < le2 && (src.charCodeAt(s2) === 32 || src.charCodeAt(s2) === 9)) s2++;
      const t2 = tryTitle(s2);
      if (t2) {
        let r2 = t2.end;
        while (r2 < le2 && (src.charCodeAt(r2) === 32 || src.charCodeAt(r2) === 9)) r2++;
        if (r2 < le2) {
          endPos = le + 1;
        } else {
          title = t2.title;
          endPos = le2 + 1;
        }
      } else {
        endPos = le + 1;
      }
    } else {
      endPos = le + 1;
    }
  }
  const key = normLabel(label);
  if (key.length === 0) return null; // a label that folds to empty is not a def
  if (!links.has(key)) {
    links.set(key, { href, title });
  }
  return { next: endPos };
}

// ---------------------------------------------------------------------------
// Paragraph scanning, setext headings, tables
// ---------------------------------------------------------------------------

// Is the line at j a table header (contains |) followed by a delimiter row?
// Number of cells in a table row line (split on |, dropping a leading
// empty cell when the row starts with a pipe and a trailing one when it
// ends with one). Used to check the header against the delimiter row.
function rowCellCount(line) {
  let cells = splitTableRow(line);
  if (line.replace(/^[ \t]+/, '').startsWith('|') && cells.length > 0 && cells[0].trim() === '') cells = cells.slice(1);
  if (line.replace(/[ \t]+$/, '').endsWith('|') && cells.length > 0 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  return cells.length;
}

function isTableStart(src, j) {
  const le = lineEnd(src, j);
  if (src.slice(j, le).indexOf('|') === -1) return false;
  const nl = le + 1;
  if (nl >= src.length) return false;
  const le2 = lineEnd(src, nl);
  const aligns = parseDelimRow(src.slice(nl, le2));
  if (aligns === null) return false;
  return rowCellCount(src.slice(j, le)) === aligns.length;
}

// Parse a table delimiter row into alignments, or null when it is not one.
// The row must contain at least one pipe; each cell is dashes with optional
// colons.
function parseDelimRow(line) {
  let s = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (s.indexOf('|') === -1) return null;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = s.split('|');
  const aligns = [];
  for (const cell of cells) {
    const c = cell.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':') && c.length > 1) aligns.push('center');
    else if (c.startsWith(':')) aligns.push('left');
    else if (c.endsWith(':')) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// Split a table row into cell texts, honouring \| escapes and `code spans`
// (a | inside a code span is not a separator).
function splitTableRow(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = row.length;
  while (i < n) {
    const c = row[i];
    if (c === '\\' && i + 1 < n && row[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && row[j] === '`') j++;
      const run = j - i;
      let k = j;
      let close = -1;
      while (k < n) {
        if (row[k] === '`') {
          let m = k;
          while (m < n && row[m] === '`') m++;
          if (m - k === run) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close !== -1) {
        // Copy the span verbatim, except that \| is still an escaped
        // pipe here (it becomes a literal | in the cell text).
        cur += row.slice(i, close + run).replace(/\\\|/g, '|');
        i = close + run;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  return cells;
}

// Normalize a table row's cells: drop empty edge cells from outer pipes,
// trim, and unescape \| (already handled in the split).
function tableCells(row, count) {
  let cells = splitTableRow(row);
  // Drop a leading empty cell when the row starts with a pipe, and a
  // trailing one when it ends with one.
  if (row.replace(/^[ \t]+/, '').startsWith('|') && cells.length > 0 && cells[0].trim() === '') cells = cells.slice(1);
  if (row.replace(/[ \t]+$/, '').endsWith('|') && cells.length > 0 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  cells = cells.map((c) => c.trim());
  while (cells.length < count) cells.push('');
  if (cells.length > count) cells = cells.slice(0, count);
  return cells;
}

// Does the line at j start a block that interrupts a paragraph?
function interruptAt(src, j) {
  const le = lineEnd(src, j);
  if (isBlankLine(src, j, le)) return true;
  const li = leadInfo(src, j, le);
  if (li.col > 3) return false;
  const rest = src.slice(li.next, le);
  if (rest.length === 0) return true;
  const c0 = rest.charCodeAt(0);
  // ATX heading
  if (c0 === 35) {
    let d = 0;
    while (d < rest.length && rest.charCodeAt(d) === 35) d++;
    if (d >= 1 && d <= 6 && (d === rest.length || rest.charCodeAt(d) === 32 || rest.charCodeAt(d) === 9)) return true;
  }
  if (isHrLine(src, j, le)) return true;
  // Fenced code
  if (c0 === 96 || c0 === 126) {
    let r = 0;
    while (r < rest.length && rest.charCodeAt(r) === c0) r++;
    if (r >= 3) {
      if (c0 === 126) return true;
      if (rest.slice(r).indexOf('`') === -1) return true;
    }
  }
  // Blockquote
  if (c0 === 62) return true;
  // List (bullet, or ordered starting with exactly 1) — but an empty
  // item does not interrupt a paragraph.
  const lm = matchListMarker(src, j);
  if (lm && !lm.empty && (!lm.ordered || lm.bullet === '1.' || lm.bullet === '1)')) return true;
  // Html block, types 1-6 only
  const hb = htmlBlockStart(src, j, le);
  if (hb && hb.kind <= 6) return true;
  // Table
  if (rest.indexOf('|') !== -1 && isTableStart(src, j)) return true;
  return false;
}

// Scan paragraph lines from i. Returns { text, next }.
function scanParagraph(src, i, noSetext, lazySet) {
  const lines = [];
  let j = i;
  const n = src.length;
  while (j < n) {
    const le = lineEnd(src, j);
    // A whitespace-only line ends the paragraph, unless it is the last
    // line of the input without a terminating newline (then it is the
    // paragraph's trailing whitespace).
    if (isBlankLine(src, j, le) && le < n) break;
    // A setext underline ends the paragraph (the heading check runs next),
    // unless the line is a protected lazy line. A lazy continuation line
    // never interrupts the paragraph, even if it looks like a block start.
    // (A blank line reaching here is the last line at EOF: paragraph
    // content, not an interruption.)
    if (lines.length > 0 && !isBlankLine(src, j, le) && !(lazySet && lazySet.has(j)) && (interruptAt(src, j) || (setextDepth(src, j) > 0 && !(noSetext && noSetext.has(j))))) break;
    lines.push(src.slice(j, le));
    j = le + 1;
  }
  return { text: lines.join('\n'), next: j };
}

// Is the line at pos a setext underline? Returns the depth or 0.
function setextDepth(src, pos) {
  if (pos >= src.length) return 0;
  const le = lineEnd(src, pos);
  const li = leadInfo(src, pos, le);
  if (li.col > 3) return 0;
  let k = li.next;
  if (k >= le) return 0;
  const c = src.charCodeAt(k);
  if (c !== 61 && c !== 45) return 0; // = or -
  let r = k;
  while (r < le && src.charCodeAt(r) === c) r++;
  for (let q = r; q < le; q++) {
    if (src.charCodeAt(q) !== 32 && src.charCodeAt(q) !== 9) return 0;
  }
  return c === 61 ? 1 : 2;
}

// Match a table starting at line i. Returns { head, rows, next } or null.
function matchTable(src, i) {
  const le = lineEnd(src, i);
  const headerLine = src.slice(i, le);
  if (headerLine.indexOf('|') === -1) return null;
  const nl = le + 1;
  if (nl >= src.length) return null;
  const le2 = lineEnd(src, nl);
  const aligns = parseDelimRow(src.slice(nl, le2));
  if (!aligns) return null;
  if (rowCellCount(headerLine) !== aligns.length) return null;
  const count = aligns.length;
  const head = tableCells(headerLine, count).map((text, idx) => ({ text, align: aligns[idx] }));
  const rows = [];
  let j = le2 + 1;
  const n = src.length;
  while (j < n) {
    const le3 = lineEnd(src, j);
    if (isBlankLine(src, j, le3)) break;
    // A line that starts another block (blockquote, heading, fence,
    // list, html block) ends the table; a plain line, with or without
    // pipes, is a row (a missing cell is empty).
    if (interruptAt(src, j)) break;
    const rowLine = src.slice(j, le3);
    rows.push(tableCells(rowLine, count).map((text, idx) => ({ text, align: aligns[idx] })));
    j = le3 + 1;
  }
  return { head, rows, next: j };
}

// Match an html block starting at line i. Returns { text, next } or null.
function matchHtmlBlock(src, i, isInner) {
  const n = src.length;
  const end = lineEnd(src, i);
  const start = htmlBlockStart(src, i, end);
  if (!start) return null;
  const kind = start.kind;
  // For kinds 2-5 the raw text runs to the end of the line holding the
  // closing delimiter, including its newline — unless the next line is
  // blank, in which case the newline is dropped.
  const endOfCloseLine = (idx) => {
    const le = lineEnd(src, idx);
    const nl = le + 1;
    if (nl < n && isBlankLine(src, nl, lineEnd(src, nl))) {
      return { text: src.slice(i, le), next: nl };
    }
    return { text: src.slice(i, le < n ? le + 1 : le), next: le < n ? le + 1 : le };
  };
  if (kind === 2) { // comment, ends at -->
    // An empty comment <!--> or <!---> ends at once; the rest of the
    // line is a separate block.
    let k = i;
    while (k < n && src.charCodeAt(k) === 32) k++;
    if (src.startsWith('<!-->', k)) return { text: src.slice(i, k + 5), next: k + 5 };
    if (src.startsWith('<!--->', k)) return { text: src.slice(i, k + 6), next: k + 6 };
    const idx = src.indexOf('-->', i);
    if (idx === -1) return { text: src.slice(i), next: n };
    return endOfCloseLine(idx);
  }
  if (kind === 3) { // <? ... ?>
    const idx = src.indexOf('?>', i);
    if (idx === -1) return { text: src.slice(i), next: n };
    return endOfCloseLine(idx);
  }
  if (kind === 4) { // <!A ... >
    const idx = src.indexOf('>', i);
    if (idx === -1) return { text: src.slice(i), next: n };
    return endOfCloseLine(idx);
  }
  if (kind === 5) { // <![CDATA[ ... ]]>
    const idx = src.indexOf(']]>', i);
    if (idx === -1) return { text: src.slice(i), next: n };
    return endOfCloseLine(idx);
  }
  if (kind === 1) { // script/pre/style/textarea, ends at the closing tag line
    const closeRe = new RegExp('</' + start.tag + '[\\s>]', 'i');
    let j = i;
    while (j < n) {
      const le = lineEnd(src, j);
      if (closeRe.test(src.slice(j, le))) {
        return { text: src.slice(i, le + 1 <= n ? le + 1 : le), next: le + 1 };
      }
      j = le + 1;
    }
    return { text: src.slice(i), next: n };
  }
  // kinds 6 and 7: lines until a blank line or end of input. The raw text
  // drops the final newline when a blank line ends the block.
  let lastEnd = end;
  let j = end + 1;
  while (j < n) {
    const le = lineEnd(src, j);
    if (isBlankLine(src, j, le)) {
      return { text: src.slice(i, lastEnd), next: j };
    }
    lastEnd = le;
    j = le + 1;
  }
  return { text: src.slice(i), next: n };
}

// ---------------------------------------------------------------------------
// Blockquote and list
// ---------------------------------------------------------------------------

// Is a stripped (inner) line able to continue a paragraph lazily?
function lazyOk(line) {
  if (line.length === 0) return false;
  if (isBlankLineStr(line)) return false;
  // Use interruptAt on the line as a one-line source.
  return !interruptAt(line, 0);
}

// Whether the content so far ends with an open paragraph, given a new
// content line (already stripped of its container marker). Indented code
// closes a paragraph; a nested blockquote / list may end with one.
function paraOpenAfter(line, paraOpen) {
  if (isBlankLineStr(line)) return false;
  const sli = leadInfo(line, 0, line.length);
  if (sli.col >= 4 && !paraOpen) return false; // indented code block
  if (line.charCodeAt(sli.next) === 62 || matchListMarker(line, 0)) return true;
  if (interruptAt(line, 0)) return false;
  return true;
}

// If the line is a fenced-code fence line (indent <= 3, a run of 3+
// backticks or tildes), return { ch, run, end, closerOk } where closerOk
// means only whitespace follows the run. Otherwise null.
function fenceLineInfo(line) {
  const le = line.length;
  const li = leadInfo(line, 0, le);
  if (li.col > 3) return null;
  let k = li.next;
  const c = line.charCodeAt(k);
  if (c !== 96 && c !== 126) return null;
  let run = 0;
  while (k < le && line.charCodeAt(k) === c) { run++; k++; }
  if (run < 3) return null;
  let closerOk = true;
  for (let q = k; q < le; q++) {
    if (line.charCodeAt(q) !== 32 && line.charCodeAt(q) !== 9) { closerOk = false; break; }
  }
  return { ch: c, run, end: k, closerOk };
}

function matchBlockquote(src, i) {
  const n = src.length;
  const inner = [];
  const lazyFlags = []; // true when the inner line came from a lazy line
  let j = i;
  let paraOpen = false;
  // Whether the inner content is inside a fenced code block: lazy lines
  // never continue one, they end the blockquote.
  let inFence = null;
  while (j < n) {
    const le = lineEnd(src, j);
    const line = src.slice(j, le);
    const stripped = stripBlockquoteMarker(line);
    if (stripped !== null) {
      if (inFence) {
        const fi = fenceLineInfo(stripped);
        if (fi && fi.ch === inFence.ch && fi.run >= inFence.run && fi.closerOk) inFence = null;
      } else if (!paraOpen) {
        const fi = fenceLineInfo(stripped);
        if (fi && !(fi.ch === 96 && stripped.indexOf('`', fi.end) !== -1)) {
          inFence = { ch: fi.ch, run: fi.run };
        }
      }
      paraOpen = paraOpenAfter(stripped, paraOpen);
      inner.push(stripped);
      lazyFlags.push(false);
      j = le + 1;
      continue;
    }
    if (paraOpen && !inFence && !isBlankLine(src, j, le) && lazyOk(line)) {
      // A lazy line indented 4+ columns loses that indent.
      const lli = leadInfo(line, 0, line.length);
      let content = line;
      if (lli.col >= 4) content = stripCols(line, 0, line.length, 4);
      inner.push(content);
      lazyFlags.push(true);
      j = le + 1;
      continue;
    }
    break;
  }
  if (inner.length === 0) return null;
  // A lazy line that looks like a setext underline never becomes one.
  // When the previous inner line was also lazy it is indented by 4
  // spaces; otherwise it stays as-is but is marked protected.
  for (let a = 0; a < inner.length; a++) {
    if (lazyFlags[a] && setextDepth(inner[a], 0) > 0 && a > 0 && lazyFlags[a - 1]) {
      inner[a] = '    ' + inner[a];
    }
  }
  const noSetext = new Set();
  const lazySet = new Set();
  let off = 0;
  for (let a = 0; a < inner.length; a++) {
    if (lazyFlags[a]) {
      lazySet.add(off);
      if (setextDepth(inner[a], 0) > 0) noSetext.add(off);
    }
    off += inner[a].length + 1;
  }
  return { text: inner.join('\n'), next: j, noSetext: noSetext.size > 0 ? noSetext : null, lazySet: lazySet.size > 0 ? lazySet : null };
}

// Parse a list marker at the start of a line. Returns null or:
// { ordered, start, bullet, markerEndCol, contentIndent, contentStart, endCol }
function matchListMarker(src, i) {
  const le = lineEnd(src, i);
  const li = leadInfo(src, i, le);
  if (li.col > 3) return null;
  let k = li.next;
  const c = src.charCodeAt(k);
  let ordered = false;
  let start = 0;
  let bullet = '';
  let delim = '';
  let markerLen = 0;
  if (c === 42 || c === 43 || c === 45) {
    bullet = src[k];
    delim = src[k];
    markerLen = 1;
    k++;
  } else if (c >= 48 && c <= 57) {
    let d = k;
    while (d < le && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
    if (d - k > 9) return null;
    if (d < le && (src.charCodeAt(d) === 46 || src.charCodeAt(d) === 41)) {
      ordered = true;
      start = parseInt(src.slice(k, d), 10);
      bullet = src.slice(k, d + 1);
      delim = src[d];
      markerLen = d + 1 - k;
      k = d + 1;
    } else return null;
  } else return null;
  const markerEndCol = li.col + markerLen;
  // Whitespace after the marker. A marker not followed by whitespace (or
  // end of line) is not a list marker at all (e.g. "*foo" is emphasis).
  let col = markerEndCol;
  let idx = k;
  let spaces = 0;
  while (idx < le && (src.charCodeAt(idx) === 32 || src.charCodeAt(idx) === 9)) {
    if (src.charCodeAt(idx) === 32) { col++; spaces++; idx++; }
    else { const adv = 4 - (col % 4); col += adv; spaces += adv; idx++; }
  }
  if (spaces === 0 && idx < le) return null;
  if (idx >= le) {
    // Empty item: content indent is marker width + 1.
    return { ordered, start, bullet, delim, markerEndCol, contentIndent: markerEndCol + 1, content: '', empty: true };
  }
  // The first line's content: the whitespace run after the marker is
  // expanded to spaces (tabs measured from the line start), then the
  // content indent is dropped from it.
  let contentIndent;
  if (spaces >= 5) contentIndent = markerEndCol + 1;
  else contentIndent = col;
  let expandedWs = '';
  let wcol = markerEndCol;
  for (let w = k; w < idx; w++) {
    if (src.charCodeAt(w) === 32) { expandedWs += ' '; wcol++; }
    else { const adv = 4 - (wcol % 4); expandedWs += ' '.repeat(adv); wcol += adv; }
  }
  const content = expandedWs.slice(contentIndent - markerEndCol) + src.slice(idx, le);
  return { ordered, start, bullet, delim, markerEndCol, contentIndent, content, empty: false };
}

// Strip `cols` columns from the start of a line's leading whitespace.
// The leading whitespace is expanded to spaces first (a tab goes to the
// next multiple of 4 columns, measured from the line start), then `cols`
// columns are dropped; the rest of the line is kept as-is.
function stripIndentCols(line, cols) {
  let col = 0;
  let idx = 0;
  const n = line.length;
  let expanded = '';
  while (idx < n) {
    const c = line.charCodeAt(idx);
    if (c === 32) { expanded += ' '; col++; idx++; }
    else if (c === 9) { const adv = 4 - (col % 4); expanded += ' '.repeat(adv); col += adv; idx++; }
    else break;
  }
  return expanded.slice(cols) + line.slice(idx);
}

// Match a list starting at line i. Returns null or
// { ordered, start, items: [{ text, task, checked }], next, loose }.
function matchList(src, i, links) {
  const first = matchListMarker(src, i);
  if (!first) return null;
  const n = src.length;
  const items = [];
  let j = i;
  let loose = false;
  let prevItemEndedBlank = false;
  while (j < n) {
    const le = lineEnd(src, j);
    // A thematic break line ends the list (it is not a new item).
    if (isHrLine(src, j, le)) break;
    const m = matchListMarker(src, j);
    if (m && m.ordered === first.ordered && m.delim === first.delim) {
      // New item. A blank line between items makes the list loose.
      if (items.length > 0 && prevItemEndedBlank) loose = true;
      const itemLines = [];
      const itemLazy = [];
      const content = m.content;
      // Task list marker.
      let task = false;
      let checked = false;
      let firstContent = content;
      const tm = /^\[([ xX])\](?:[ \t]|$)/.exec(content);
      if (tm) {
        task = true;
        checked = tm[1] === 'x' || tm[1] === 'X';
        firstContent = content.slice(3);
        // The task marker is followed by spaces; the item's first line
        // content starts after the marker.
        if (firstContent.startsWith(' ')) firstContent = firstContent.slice(1);
      }
      itemLines.push(firstContent);
      itemLazy.push(false);
      const cIndent = m.contentIndent;
      let itemEndedBlank = false;
      // Whether the item has any non-blank content yet, and whether a
      // blank line has been seen: an empty item followed by a blank line
      // cannot take an indented line as its content.
      let itemHasContent = !isBlankLineStr(firstContent);
      let itemSawBlank = false;
      j = le + 1;
      // Continuation lines.
      let paraOpen = !isBlankLineStr(firstContent) && !interruptAt(firstContent, 0);
      while (j < n) {
        const le2 = lineEnd(src, j);
        const line2 = src.slice(j, le2);
        // Blank line: keep it in the item, remember it.
        if (isBlankLine(src, j, le2)) {
          itemLines.push('');
          itemLazy.push(false);
          itemEndedBlank = true;
          itemSawBlank = true;
          paraOpen = false;
          j = le2 + 1;
          continue;
        }
        const li2 = leadInfo(src, j, le2);
        // A list marker indented less than the content indent ends this
        // item: it is either a new item of this list or a new list.
        const m2 = matchListMarker(src, j);
        if (m2 && li2.col < cIndent) break;
        // Indented continuation: strip the content indent. An empty item
        // after a blank line does not take an indented line.
        if (li2.col >= cIndent) {
          if (!itemHasContent && itemSawBlank) break;
          itemLines.push(stripIndentCols(line2, cIndent));
          itemLazy.push(false);
          itemEndedBlank = false;
          itemHasContent = true;
          const s = itemLines[itemLines.length - 1];
          paraOpen = paraOpenAfter(s, paraOpen);
          j = le2 + 1;
          continue;
        }
        // Lazy continuation of a paragraph (the content indent is
        // stripped, as for blockquote lazy lines).
        if (paraOpen && lazyOk(line2)) {
          itemLines.push(stripIndentCols(line2, cIndent));
          itemLazy.push(true);
          itemEndedBlank = false;
          itemHasContent = true;
          j = le2 + 1;
          continue;
        }
        break;
      }
      // An item whose lines contain a blank line between two blocks is
      // loose; checked when lexing (tokens contain a space token).
      items.push({ lines: itemLines, lazy: itemLazy, task, checked, cIndent, endedBlank: itemEndedBlank });
      prevItemEndedBlank = itemEndedBlank;
      continue;
    }
    break;
  }
  if (items.length === 0) return null;
  // Lex each item's lines and decide loose/tight.
  const outItems = [];
  for (let a = 0; a < items.length; a++) {
    const it = items[a];
    const text = it.lines.join('\n');
    // A blank line inside the item separating two blocks makes the list
    // loose. This catches blank lines a nested block swallowed (a
    // trailing blank line of a nested list item still separates the
    // nested list from the next block of this item). Only a blank line
    // at the item's own level counts: one followed by an indented line
    // lives inside a nested block, and one inside a fenced code block
    // is fence content, not a separator.
    let hasBlankThenContent = false;
    {
      let inFence = false;
      let fenceCh = 0;
      let fenceLen = 0;
      const fenceStates = [];
      for (let k = 0; k < it.lines.length; k++) {
        const ln = it.lines[k];
        const m = /^(?: {0,3})(`{3,}|~{3,})/.exec(ln);
        if (m && !inFence) {
          inFence = true;
          fenceCh = m[1].charCodeAt(0);
          fenceLen = m[1].length;
        } else if (m && inFence && m[1].charCodeAt(0) === fenceCh && m[1].length >= fenceLen && (fenceCh !== 96 || ln.slice(m[0].length).indexOf('`') === -1)) {
          inFence = false;
        }
        fenceStates.push(inFence);
      }
      for (let k = 0; k < it.lines.length; k++) {
        if (it.lines[k] === '' && !fenceStates[k]) {
          let hasBefore = false, hasAfter = false;
          for (let m = 0; m < k; m++) if (it.lines[m] !== '') { hasBefore = true; break; }
          for (let m = k + 1; m < it.lines.length; m++) {
            if (it.lines[m] !== '') {
              const firstCh = it.lines[m].charCodeAt(0);
              if (firstCh !== 32 && firstCh !== 9) hasAfter = true;
              break;
            }
          }
          if (hasBefore && hasAfter) { hasBlankThenContent = true; break; }
        }
      }
    }
    if (hasBlankThenContent) loose = true;
    // Byte offsets of lazy continuation lines in the item text.
    let lazySet = null;
    if (it.lazy && it.lazy.some(Boolean)) {
      lazySet = new Set();
      let off = 0;
      for (let k = 0; k < it.lines.length; k++) {
        if (it.lazy[k]) lazySet.add(off);
        off += it.lines[k].length + 1;
      }
    }
    const toks = lexBlocks(text, links, true, undefined, lazySet);
    // Loose if a space token sits between two non-space tokens.
    for (let b = 1; b < toks.length - 1; b++) {
      if (toks[b].t === 'space') { loose = true; break; }
    }
    outItems.push({ tokens: toks, task: it.task, checked: it.checked });
  }
  return { ordered: first.ordered, start: first.start, items: outItems, next: j, loose };
}

// ---------------------------------------------------------------------------
// Block lexer: turns source text into a token list.
// ---------------------------------------------------------------------------

function lexBlocks(src, links, isInner, noSetext, lazySet) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    // Skip blank lines (one space token per run, if we are mid-document).
    if (isBlankLine(src, i, lineEnd(src, i))) {
      let j = i;
      while (j < n && isBlankLine(src, j, lineEnd(src, j))) j = lineEnd(src, j) + 1;
      if (toks.length > 0) toks.push({ t: 'space' });
      i = j;
      continue;
    }
    const le = lineEnd(src, i);
    const li = leadInfo(src, i, le);
    // Indented code (indent >= 4).
    if (li.col >= 4) {
      const code = matchIndentedCode(src, i);
      if (code) {
        toks.push({ t: 'code', text: code.text });
        i = code.next;
        continue;
      }
    }
    // Fenced code.
    const fence = matchFences(src, i);
    if (fence) {
      toks.push({ t: 'code', lang: fence.lang, text: fence.text });
      i = fence.next;
      continue;
    }
    // ATX heading.
    const atx = matchHeading(src, i);
    if (atx) {
      toks.push({ t: 'heading', depth: atx.depth, text: atx.text });
      i = atx.next;
      continue;
    }
    // Horizontal rule.
    if (isHrLine(src, i, le)) {
      toks.push({ t: 'hr' });
      i = le + 1;
      continue;
    }
    // Blockquote.
    if (li.col <= 3) {
      const rest0 = src.slice(li.next, le);
      if (rest0.charCodeAt(0) === 62) {
        const bq = matchBlockquote(src, i);
        if (bq) {
          toks.push({ t: 'blockquote', tokens: lexBlocks(bq.text, links, true, bq.noSetext, bq.lazySet) });
          i = bq.next;
          continue;
        }
      }
    }
    // List.
    if (li.col <= 3) {
      const lst = matchList(src, i, links);
      if (lst) {
        toks.push({ t: 'list', ordered: lst.ordered, start: lst.start, loose: lst.loose, items: lst.items });
        i = lst.next;
        continue;
      }
    }
    // Html block.
    if (li.col <= 3) {
      const html = matchHtmlBlock(src, i, isInner);
      if (html) {
        toks.push({ t: 'html', text: html.text });
        i = html.next;
        continue;
      }
    }
    // Link reference definition: consumed, but kept as a token so a
    // blank line next to it still counts for loose/tight lists.
    const def = matchDef(src, i, links);
    if (def) {
      toks.push({ t: 'def' });
      i = def.next;
      continue;
    }
    // Table.
    if (li.col <= 3) {
      const tbl = matchTable(src, i);
      if (tbl) {
        toks.push({ t: 'table', head: tbl.head, rows: tbl.rows });
        i = tbl.next;
        continue;
      }
    }
    // Paragraph, or setext heading.
    const para = scanParagraph(src, i, noSetext, lazySet);
    const sd = (noSetext && noSetext.has(para.next)) ? 0 : setextDepth(src, para.next);
    if (sd > 0) {
      // The heading text drops the first line's leading and the last
      // line's trailing whitespace.
      const headingText = para.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      toks.push({ t: 'heading', depth: sd, text: headingText });
      i = lineEnd(src, para.next) + 1;
      continue;
    }
    toks.push({ t: 'paragraph', text: para.text });
    i = para.next;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderBlocks(toks, links, out) {
  for (const tok of toks) {
    switch (tok.t) {
      case 'space': break;
      case 'def': break;
      case 'hr': out.push('<hr>\n'); break;
      case 'heading':
        out.push('<h' + tok.depth + '>' + parseInline(tok.text, links) + '</h' + tok.depth + '>\n');
        break;
      case 'code':
        if (tok.lang) {
          out.push('<pre><code class="language-' + escAttr(tok.lang) + '">' + escAll(tok.text) + '</code></pre>\n');
        } else {
          out.push('<pre><code>' + escAll(tok.text) + '</code></pre>\n');
        }
        break;
      case 'blockquote': {
        out.push('<blockquote>\n');
        renderBlocks(tok.tokens, links, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'html':
        out.push(tok.text);
        break;
      case 'paragraph':
        out.push('<p>' + parseInline(tok.text, links) + '</p>\n');
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out.push('<' + tag + startAttr + '>\n');
        for (const item of tok.items) {
          let body = '';
          const checkbox = item.task ? '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ' : '';
          if (checkbox && tok.loose && item.tokens.length > 0 && item.tokens[0].t === 'paragraph') {
            // In a loose list the checkbox lives inside the first
            // paragraph, not before it.
            const first = item.tokens[0];
            const rest = renderTokensToString(item.tokens.slice(1), links, tok.loose);
            body += '<p>' + checkbox + parseInline(first.text, links) + '</p>\n' + rest;
          } else {
            if (checkbox) body += checkbox;
            body += renderTokensToString(item.tokens, links, tok.loose);
          }
          out.push('<li>' + body + '</li>\n');
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (const cell of tok.head) {
          out.push('<th' + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + parseInline(cell.text, links) + '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (tok.rows.length > 0) {
          out.push('<tbody>');
          for (const row of tok.rows) {
            out.push('<tr>\n');
            for (const cell of row) {
              out.push('<td' + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + parseInline(cell.text, links) + '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody></table>\n');
        } else {
          out.push('</table>\n');
        }
        break;
      }
    }
  }
}

function renderTokensToString(toks, links, loose) {
  const out = [];
  for (const tok of toks) {
    if (tok.t === 'paragraph') {
      if (loose) out.push('<p>' + parseInline(tok.text, links) + '</p>\n');
      else out.push(parseInline(tok.text, links));
    } else {
      renderBlocks([tok], links, out);
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const links = new Map();
  const toks = lexBlocks(src, links);
  const out = [];
  renderBlocks(toks, links, out);
  return out.join('');
}
