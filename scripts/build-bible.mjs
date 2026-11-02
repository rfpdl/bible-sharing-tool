// Builds public/bible/<id>-ot.json and public/bible/<id>-nt.json: the whole Old and New Testament of each
// public-domain translation, which the app saves on the device in the background so the whole Bible works
// offline. Made from the Free Use Bible API's whole-translation downloads (https://bible.helloao.org).
//
//   node scripts/build-bible.mjs
//
// Each file is { BOOK: [chapter 1 verses, chapter 2 verses, …] }. A verse is [number, ...parts], where a part
// is a string, or a one-string array for the words of Jesus (marked in WEB and KJV), e.g. [15, ["Allow it now…"]].
// getChapter in public/index.html reads the same API's single chapters into this shape until then.
import { mkdir, rm, writeFile } from 'node:fs/promises';

const API = 'https://bible.helloao.org/api';
const OUT = new URL('../public/bible/', import.meta.url);
// app id -> API translation id (the `api` ids in INLINE in public/index.html)
const TRANSLATIONS = { bsb: 'BSB', web: 'ENGWEBP', kjv: 'eng_kjv' };

function verse(x) {
  // Content is strings and {text, wordsOfJesus?} parts; {noteId} and {lineBreak} parts carry no text.
  const parts = [];
  for (const p of x.content) {
    // KJV marks paragraphs with "¶"; the app doesn't lay out paragraphs, so drop it.
    const text = (typeof p === 'string' ? p : p.text || '').replace(/¶/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const jesus = typeof p === 'object' && !!p.wordsOfJesus;
    const last = parts[parts.length - 1];
    if (last && last.jesus === jesus) last.text += ' ' + text;
    else parts.push({ text, jesus });
  }
  return [x.number, ...parts.map(p => (p.jesus ? [p.text] : p.text))];
}

// Download and check everything first, so a failed run leaves the current files untouched.
const files = {};
for (const [id, api] of Object.entries(TRANSLATIONS)) {
  const res = await fetch(`${API}/${api}/complete.json`);
  if (!res.ok) throw new Error(`${api}: HTTP ${res.status}`);
  const { books } = await res.json();
  if (books.length !== 66 || books[39].id !== 'MAT') throw new Error(`${api}: unexpected book list`);
  const parts = { ot: {}, nt: {} };
  books.forEach((book, i) => {
    const chapters = parts[i < 39 ? 'ot' : 'nt'][book.id] = [];
    for (const { chapter } of book.chapters) {
      if (chapter.number !== chapters.length + 1) throw new Error(`${id} ${book.id}: chapter ${chapter.number} out of order`);
      chapters.push(chapter.content.filter(x => x.type === 'verse').map(verse));
    }
  });
  for (const [part, whole] of Object.entries(parts)) files[`${id}-${part}.json`] = JSON.stringify(whole);
}
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const [name, json] of Object.entries(files)) {
  await writeFile(new URL(name, OUT), json);
  console.log(name, (json.length / 1e6).toFixed(2), 'MB');
}
console.log('If the text changed, bump BIBLE_CACHE in public/index.html and BIBLE in public/sw.js so devices save it again.');
