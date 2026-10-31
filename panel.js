// What Was That File: semantic search over your Google Drive, with the AI model running in this panel.
// Flow: list Drive files -> export text -> split into passages -> embed locally -> store in IndexedDB -> search.
import { pipeline, env } from './lib/transformers.min.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const MAX_FILES = 500;          // most recently edited files to index
const MAX_DOWNLOAD = 20e6;      // skip uploaded files above 20 MB
const CHUNK = 700;              // characters per passage
const BATCH = 8;                // small batches so a query never waits long behind indexing
const MIMES = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'text/plain': 'Text',
};
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { files: new Map(), mode: 'meaning', modelPct: 0, modelState: 'loading', syncing: null, lastSync: 0 };

/* ---------------- storage ---------------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('wwtf-drive', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('files', mode); const q = fn(t.objectStore('files')); let out;
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
  });
}
const dbPut = f => tx('readwrite', st => { st.put(f); });
const dbDel = id => tx('readwrite', st => { st.delete(id); });
const dbAll = () => tx('readonly', st => st.getAll());
const dbClear = () => tx('readwrite', st => { st.clear(); });

/* ---------------- model (local, warm, priority queue) ---------------- */
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = true; // run inference in a worker so the search box stays responsive

const modelReady = pipeline('feature-extraction', MODEL, {
  dtype: 'q8',
  progress_callback: p => {
    if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) { S.modelPct = Math.round(p.progress || 0); renderStatus(); }
  },
}).then(async m => {
  await m(['warm up'], { pooling: 'mean', normalize: true }); // first call compiles; do it before the user types
  S.modelState = 'ready'; renderStatus(); return m;
}).catch(e => { S.modelState = 'error'; S.modelErr = e.message || String(e); renderStatus(); throw e; });

const jobs = []; let busy = false;
function embed(texts, priority = false) {
  return new Promise((res, rej) => { const j = { texts, res, rej }; priority ? jobs.unshift(j) : jobs.push(j); pump(); });
}
async function pump() {
  if (busy) return; busy = true;
  while (jobs.length) {
    const j = jobs.shift();
    try {
      const m = await modelReady;
      const out = await m(j.texts, { pooling: 'mean', normalize: true });
      j.res(out.data instanceof Float32Array ? out.data : Float32Array.from(out.data));
    } catch (e) { j.rej(e); }
  }
  busy = false;
}
const qCache = new Map();
async function embedQuery(q) {
  if (qCache.has(q)) return qCache.get(q);
  const v = await embed([q], true);
  qCache.set(q, v); if (qCache.size > 50) qCache.delete(qCache.keys().next().value);
  return v;
}

/* ---------------- Google Drive ---------------- */
const placeholder = () => chrome.runtime.getManifest().oauth2.client_id.startsWith('PASTE');
async function getToken(interactive) {
  const r = await chrome.identity.getAuthToken({ interactive });
  const t = typeof r === 'string' ? r : r && r.token;
  if (!t) throw new Error('Not connected to Google Drive.');
  return t;
}
async function gfetch(url, as = 'json', retry = true) {
  const token = await getToken(false);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401 && retry) { await chrome.identity.removeCachedAuthToken({ token }); return gfetch(url, as, false); }
  if (!r.ok) {
    let msg = 'Drive error ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  return as === 'json' ? r.json() : as === 'text' ? r.text() : r.arrayBuffer();
}
const API = 'https://www.googleapis.com/drive/v3/files';
async function listFiles() {
  const q = 'trashed=false and (' + Object.keys(MIMES).map(m => `mimeType='${m}'`).join(' or ') + ')';
  const out = []; let page = '';
  do {
    const u = new URL(API);
    u.searchParams.set('q', q); u.searchParams.set('orderBy', 'modifiedTime desc');
    u.searchParams.set('pageSize', '100'); u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size)');
    u.searchParams.set('supportsAllDrives', 'true'); u.searchParams.set('includeItemsFromAllDrives', 'true');
    if (page) u.searchParams.set('pageToken', page);
    const j = await gfetch(u.toString());
    out.push(...j.files); page = j.nextPageToken;
  } while (page && out.length < MAX_FILES);
  return out.slice(0, MAX_FILES);
}
async function fetchSegments(f) {
  const exp = mime => gfetch(`${API}/${f.id}/export?mimeType=${encodeURIComponent(mime)}`, mime === XLSX_MIME ? 'buf' : 'text');
  const media = as => {
    if (f.size && +f.size > MAX_DOWNLOAD) throw new Error('Skipped: larger than 20 MB.');
    return gfetch(`${API}/${f.id}?alt=media&supportsAllDrives=true`, as);
  };
  switch (f.mimeType) {
    case 'application/vnd.google-apps.document': return paras(await exp('text/plain'));
    case 'application/vnd.google-apps.presentation': return paras(await exp('text/plain'));
    case 'application/vnd.google-apps.spreadsheet': return sheets(await exp(XLSX_MIME));
    case XLSX_MIME: return sheets(await media('buf'));
    case 'text/plain': return paras(await media('text'));
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return paras((await window.mammoth.extractRawText({ arrayBuffer: await media('buf') })).value);
    case 'application/pdf': {
      const pdfjs = await import('./lib/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');
      const pdf = await pdfjs.getDocument({ data: await media('buf') }).promise; const segs = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        segs.push({ text: tc.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join(''), loc: `Page ${p}` });
      }
      if (!segs.some(s => s.text.trim())) throw new Error('No text layer (scanned PDF).');
      return segs;
    }
  }
  return [];
}
const paras = t => t.split(/\n\s*\n/).map(text => ({ text, loc: null }));
function sheets(buf) {
  const wb = window.XLSX.read(buf, { type: 'array' }); const segs = [];
  for (const name of wb.SheetNames) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    const head = rows[0].map(String);
    if (rows.length === 1) { segs.push({ text: head.join(', '), loc: `Sheet "${name}"` }); continue; }
    for (let i = 1; i < rows.length; i += 12) {
      const lines = rows.slice(i, i + 12).map(r => r.map((v, k) => (String(v).trim() ? `${head[k] || 'Column ' + (k + 1)}: ${v}` : '')).filter(Boolean).join('; ') + '.');
      segs.push({ text: (i === 1 ? head.join(', ') + '. ' : '') + lines.join(' '), loc: `Sheet "${name}", rows ${i + 1}–${Math.min(i + 12, rows.length)}` });
    }
  }
  return segs;
}
function chunk(segs) {
  const out = []; let n = 0, cur = '', curLoc;
  const push = (t, loc) => { if (t.trim()) out.push({ text: t.trim(), loc: loc || `Passage ${++n}` }); };
  for (const s of segs) {
    const text = (s.text || '').replace(/\s+/g, ' ').trim(); if (!text) continue;
    if (s.loc !== curLoc && cur) { push(cur, curLoc); cur = ''; }
    curLoc = s.loc;
    let sents = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    sents = sents.flatMap(st => st.length <= CHUNK ? [st] : st.match(new RegExp(`.{1,${CHUNK}}(\\s|$)`, 'g')) || [st]);
    for (const st of sents) {
      if (cur && (cur + st).length > CHUNK) {
        push(cur, curLoc);
        const last = cur.match(/[^.!?]+[.!?]*\s*$/);
        cur = last && last[0].length < 200 ? last[0] + st : st;
      } else cur += st;
    }
    if (curLoc) { push(cur, curLoc); cur = ''; }
  }
  push(cur, curLoc);
  return out;
}

/* ---------------- sync ---------------- */
async function sync() {
  if (S.syncing) return;
  S.syncing = { done: 0, total: 0, phase: 'Checking Drive for changes…' }; renderStatus();
  try {
    const listed = await listFiles();
    const ids = new Set(listed.map(f => f.id));
    for (const id of [...S.files.keys()]) if (!ids.has(id)) { S.files.delete(id); dbDel(id); }
    for (const f of listed) {                           // keep names and links fresh even if content is unchanged
      const old = S.files.get(f.id);
      if (old && old.modifiedTime === f.modifiedTime) { old.name = f.name; old.link = f.webViewLink; }
    }
    const todo = listed.filter(f => { const o = S.files.get(f.id); return !o || o.modifiedTime !== f.modifiedTime || (!o.vecs && o.chunks.length && S.modelState === 'ready'); });
    S.syncing = { done: 0, total: todo.length }; renderStatus(); markDirty();
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const f = todo[next++];
        const rec = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, link: f.webViewLink, chunks: [], vecs: null, err: '' };
        try {
          rec.chunks = chunk(await fetchSegments(f));
          const vecs = new Float32Array(rec.chunks.length * DIM);
          for (let i = 0; i < rec.chunks.length; i += BATCH) {
            vecs.set(await embed(rec.chunks.slice(i, i + BATCH).map(c => c.text)), i * DIM);
          }
          rec.vecs = vecs;
        } catch (e) { rec.err = e.message || String(e); }
        S.files.set(rec.id, rec); await dbPut(rec);
        S.syncing.done++; markDirty(); renderStatus(); refreshSoon();
      }
    };
    await Promise.all([worker(), worker(), worker()]);  // downloads run in parallel; the model queue keeps embedding in order
    S.lastSync = Date.now(); try { await chrome.storage.local.set({ lastSync: S.lastSync }); } catch (e) {}
  } catch (e) {
    S.syncError = e.message || String(e);
  } finally { S.syncing = null; renderStatus(); refreshSoon(); }
}

/* ---------------- in-memory index ---------------- */
const STOP = new Set('a an the and or of to in on for with is was were be been it this that where which what when did do i my me we our you your find file files document documents doc sheet show had have has from at by about as are any one there here can could'.split(' '));
const tokens = s => (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.,]*%?/gu) || []).map(t => t.replace(/[.,]+$/, '')).filter(t => t && !STOP.has(t));
const IDX = { dirty: true };
const markDirty = () => { IDX.dirty = true; };
function rebuild() {
  const refs = [], inv = new Map(); let vecRows = 0, totalLen = 0;
  for (const f of S.files.values()) if (f.vecs) vecRows += f.chunks.length;
  const mat = new Float32Array(vecRows * DIM); let row = 0;
  for (const f of S.files.values()) {
    f.chunks.forEach((c, i) => {
      const r = { f, c, row: -1, len: 0 };
      if (f.vecs) { mat.set(f.vecs.subarray(i * DIM, (i + 1) * DIM), row * DIM); r.row = row++; }
      const t = tokens(c.text + ' ' + f.name); r.len = t.length; totalLen += t.length;
      const tf = new Map(); for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
      const k = refs.length; for (const [w, n] of tf) { if (!inv.has(w)) inv.set(w, []); inv.get(w).push([k, n]); }
      refs.push(r);
    });
  }
  Object.assign(IDX, { refs, inv, mat, rows: row, avg: totalLen / (refs.length || 1), dirty: false });
}

/* ---------------- search ---------------- */
function bm25(qt) {
  const N = IDX.refs.length, k1 = 1.4, b = 0.75, sc = new Float32Array(N);
  for (const w of new Set(qt)) {
    const post = IDX.inv.get(w); if (!post) continue;
    const idf = Math.log(1 + (N - post.length + 0.5) / (post.length + 0.5));
    for (const [k, f] of post) sc[k] += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * IDX.refs[k].len / IDX.avg));
  }
  return sc;
}
async function search(q) {
  const qt = tokens(q), t0 = performance.now();
  const useSem = S.mode === 'meaning' && S.modelState === 'ready';
  let qv = null, embedMs = 0;
  if (useSem) { const te = performance.now(); qv = await embedQuery(q); embedMs = performance.now() - te; }
  if (IDX.dirty) rebuild();                       // rebuild after the await so scores and passages line up
  const ts = performance.now();
  const kw = bm25(qt); let kwMax = 0; for (const v of kw) if (v > kwMax) kwMax = v;
  const semantic = useSem && IDX.rows > 0;
  const hits = [];
  if (semantic) {
    const { mat, refs } = IDX;
    for (let k = 0; k < refs.length; k++) {
      const r = refs[k]; if (r.row < 0) continue;
      let dot = 0; const o = r.row * DIM; for (let d = 0; d < DIM; d++) dot += qv[d] * mat[o + d];
      const kwn = kwMax ? kw[k] / kwMax : 0;
      if (dot > 0.2 || kwn > 0.5) hits.push({ r, sem: dot, score: dot + 0.15 * kwn });
    }
  } else {
    for (let k = 0; k < kw.length; k++) if (kw[k] > 0) hits.push({ r: IDX.refs[k], score: kw[k] });
  }
  hits.sort((a, b) => b.score - a.score);
  const per = new Map(), out = [];
  for (const h of hits) { const n = per.get(h.r.f) || 0; if (n >= 2) continue; per.set(h.r.f, n + 1); out.push(h); if (out.length >= 10) break; }
  return { out, qt, embedMs, scanMs: performance.now() - ts, semantic, t0 };
}
function snippet(text, qt) {
  const words = [...new Set(qt)].filter(w => w.length > 1).sort((a, b) => b.length - a.length);
  let start = 0; const lower = text.toLowerCase();
  const pos = words.map(w => lower.indexOf(w)).filter(p => p >= 0); if (pos.length) start = Math.max(0, Math.min(...pos) - 60);
  let s = text.slice(start, start + 260);
  if (start > 0) s = '…' + s.replace(/^\S*\s/, '');
  if (start + 260 < text.length) s = s.replace(/\s\S*$/, '') + '…';
  let h = esc(s);
  if (words.length) h = h.replace(new RegExp('(' + words.map(w => esc(w).replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')).join('|') + ')', 'gi'), '<mark>$1</mark>');
  return h;
}
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
let tokenSeq = 0;
async function runSearch() {
  const q = $('q').value.trim(), my = ++tokenSeq;
  if (!q) { $('results').innerHTML = S.files.size ? '<div class="empty">Type what you remember. For example: "the sheet where I worked out the launch costs".</div>' : ''; $('timing').textContent = ''; return; }
  const r = await search(q); if (my !== tokenSeq) return;
  $('timing').textContent = r.semantic
    ? `${Math.round(r.embedMs)} ms + ${Math.round(r.scanMs)} ms · ${IDX.rows.toLocaleString()} passages`
    : `${Math.round(r.scanMs)} ms · ${IDX.refs.length.toLocaleString()} passages`;
  let note = '';
  if (S.mode === 'meaning' && !r.semantic) note = S.modelState === 'error' ? 'The AI model did not load. Showing exact-word matches.'
    : S.modelState !== 'ready' ? 'The AI model is still loading. Showing exact-word matches for now.'
    : 'No passages have AI embeddings yet (indexing not finished, or it failed). Showing exact-word matches. Try Re-index.';
  if (!r.out.length) { $('results').innerHTML = (note ? `<div class="empty">${note}</div>` : '') + `<div class="empty">${r.semantic ? 'Nothing close in meaning. Try describing it another way.' : 'No file has these exact words.'}</div>`; return; }
  $('results').innerHTML = (note ? `<div class="empty">${note}</div>` : '') + r.out.map(h => {
    const sc = h.sem === undefined ? '' : ` (meaning score ${h.sem.toFixed(2)})`;
    const strength = h.sem === undefined ? ' · exact-word match' : (h.sem > 0.5 ? ' · <span class="strong">strong match</span>' : h.sem > 0.33 ? ' · <span class="good">good match</span>' : ' · possible match') + sc;
    return `<button class="hit" data-link="${esc(h.r.f.link)}">
      <div class="hit-top"><span class="kind">${esc(MIMES[h.r.f.mimeType] || 'File')}</span><span class="hit-name">${esc(h.r.f.name)}</span></div>
      <div class="hit-meta">${esc(h.r.c.loc)} · edited ${esc(fmtDate(h.r.f.modifiedTime))}${strength}</div>
      <p>${snippet(h.r.c.text, r.qt)}</p></button>`;
  }).join('');
}
let refreshT; const refreshSoon = () => { clearTimeout(refreshT); refreshT = setTimeout(runSearch, 600); };

/* ---------------- status ---------------- */
function renderStatus() {
  const parts = [];
  if (S.modelState === 'loading') parts.push(`Loading AI model${S.modelPct ? ' ' + S.modelPct + '%' : ''} (one-time 23 MB download)`);
  if (S.modelState === 'error') parts.push(`AI model failed to load: ${esc(S.modelErr)}`);
  if (S.syncing) parts.push(S.syncing.phase || `Indexing ${S.syncing.done} of ${S.syncing.total} files`);
  else if (S.files.size) {
    const ok = [...S.files.values()].filter(f => f.vecs).length;
    const ago = S.lastSync ? Math.max(1, Math.round((Date.now() - S.lastSync) / 60000)) : 0;
    parts.push(`${ok} files searchable${ago ? ` · synced ${ago} min ago` : ''}`);
  }
  if (S.syncError && !S.syncing) parts.push(`<span class="err">${esc(S.syncError)}</span>`);
  $('status').innerHTML = parts.join(' · ');
}

/* ---------------- events + start ---------------- */
let deb;
$('q').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(runSearch, 120); });
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(deb); runSearch(); } });
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  S.mode = b.dataset.mode;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  runSearch();
}));
$('results').addEventListener('click', e => { const h = e.target.closest('.hit'); if (h) chrome.tabs.create({ url: h.dataset.link }); });
$('syncBtn').addEventListener('click', () => { S.syncError = ''; sync(); });
$('resetBtn').addEventListener('click', async () => { S.files.clear(); await dbClear(); markDirty(); renderStatus(); runSearch(); sync(); });
$('extid').textContent = chrome.runtime.id;
$('extid').addEventListener('click', () => navigator.clipboard.writeText(chrome.runtime.id).catch(() => {}));
$('signinBtn').addEventListener('click', async () => {
  try { await getToken(true); showMain(); sync(); }
  catch (e) { $('signinErr').textContent = (e.message || String(e)) + ' Check the setup steps, then try again.'; }
});
function showMain() { $('signin').hidden = true; $('syncBtn').hidden = false; $('resetBtn').hidden = false; $('q').focus(); }

(async function start() {
  renderStatus();
  for (const f of (await dbAll()) || []) S.files.set(f.id, f);
  try { S.lastSync = (await chrome.storage.local.get('lastSync')).lastSync || 0; } catch (e) {}
  markDirty(); renderStatus();
  if (placeholder()) { $('setup').hidden = false; return; }
  try { await getToken(false); showMain(); }
  catch (e) { $('signin').hidden = false; return; }
  runSearch();
  if (Date.now() - S.lastSync > 10 * 60 * 1000) sync();   // refresh at most every 10 minutes on open
})();
