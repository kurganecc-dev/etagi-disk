/* Интерфейс «Файлов с Диска»: ссылка → проверка папки → выбор места → загрузка. */

import {
  parsePublicLink, scanFolder, DownloadRun, FolderSink, DownloadsSink, CaptureSink,
  makeReport, parseReport, reportText, formatBytes, filesWord, foldersWord, DiskError,
  PART_SUFFIX, VERSION
} from './engine.js';

const $ = id => document.getElementById(id);

const els = {
  form: $('link-form'), link: $('link'), analyze: $('analyze'), linkHint: $('link-hint'),
  linkError: $('link-error'),
  resume: $('resume-banner'), resumeTitle: $('resume-title'), resumeMeta: $('resume-meta'),
  resumeGo: $('resume-go'), resumeDrop: $('resume-drop'),
  pickFolder: $('pick-folder'), useDownloads: $('use-downloads'),
  folderValue: $('folder-value'), downloadsValue: $('downloads-value'), destHint: $('dest-hint'),
  scanCard: $('scan-card'), scanEyebrow: $('scan-eyebrow'), scanTitle: $('scan-title'), scanStats: $('scan-stats'),
  filter: $('filter'), selectAll: $('select-all'), selectNone: $('select-none'),
  rows: $('file-rows'), listCount: $('list-count'), more: $('more'),
  runCard: $('run-card'), concurrency: $('concurrency'),
  progressBar: $('progress-bar'), progressText: $('progress-text'), progressBytes: $('progress-bytes'),
  start: $('start'), pause: $('pause'), stop: $('stop'), runHint: $('run-hint'),
  activeList: $('active-list'),
  errorsCard: $('errors-card'), errorList: $('error-list'), reportSummary: $('report-summary'),
  reportNote: $('report-note'), retryErrors: $('retry-errors'),
  saveReport: $('save-report'), saveReportTxt: $('save-report-txt'),
  reportFile: $('report-file'), importError: $('import-error')
};

const DEFAULT_HINT = els.linkHint.textContent;
const HISTORY_KEY = 'etagi-disk.history.v1';

const state = {
  link: '', parsed: null, scan: null, run: null,
  sinkKind: 'none', folderHandle: null,
  selected: new Set(), visible: 100, filter: '',
  concurrency: 5, busy: false, lastReport: null
};

/* ---------- история: что уже скачано ---------- */

const history = {
  all() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {}; }
    catch { return {}; }
  },
  save(data) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(data)); } catch { /* приватный режим */ }
  },
  record(key, rel, size) {
    if (!key) return;
    const data = this.all();
    const entry = data[key] || { files: {} };
    entry.files[rel] = size ?? null;
    entry.updatedAt = new Date().toISOString();
    data[key] = entry;
    const keys = Object.keys(data);
    for (const k of keys.slice(0, Math.max(0, keys.length - 3))) delete data[k];
    this.save(data);
  },
  has(key, rel, size) {
    const entry = this.all()[key];
    if (!entry || !(rel in entry.files)) return false;
    const known = entry.files[rel];
    return known == null || size == null || known === size;
  }
};

class HistorySink {
  constructor(inner, key) { this.inner = inner; this.key = key; }
  get kind() { return this.inner.kind; }
  get name() { return this.inner.name; }
  async exists(rel, item) {
    // в выбранной папке правда — сам диск: размер сверяем с Диском
    if (this.inner.kind === 'folder') return this.inner.exists(rel, item);
    // в «Загрузках» проверить нечего — опираемся на историю прошлых запусков
    return history.has(this.key, rel, item?.size ?? null);
  }
  async write(rel, response, item) {
    const done = await this.inner.write(rel, response, item);
    history.record(this.key, rel, item?.size ?? null);
    return done;
  }
  async writeText(fileName, text) {
    if (typeof this.inner.writeText === 'function') return this.inner.writeText(fileName, text);
  }
}

/* ---------- сессия: переживает перезагрузку страницы ---------- */

const DB_NAME = 'etagi-disk';
const DB_STORE = 'session';

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB занята другой вкладкой')); };
    });
  }
  return dbPromise;
}

async function dbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const session = {
  timer: 0,
  id: null,

  payload() {
    if (!state.scan || !state.parsed) return null;
    const run = state.run;
    // задача = файлы текущего прогона; до старта — вся найденная папка
    const source = run
      ? run.items.map(it => ({ rel: it.rel, path: it.path, size: it.size ?? null, status: it.status }))
      : state.scan.files.map(f => ({ rel: f.rel, path: f.path, size: f.size ?? null, status: 'pending' }));
    const files = source;
    const left = files.some(f => !['done', 'skipped'].includes(f.status));
    return {
      id: this.id, link: state.link, publicKey: state.scan.publicKey,
      rootName: state.scan.root?.name || '', bytesTotal: run ? run.bytesTotal : (state.scan.bytes || 0),
      folders: state.scan.folders || 0,
      files, concurrency: state.concurrency, sinkKind: state.sinkKind,
      phase: run ? run.phase : 'ready', finished: !left, updatedAt: Date.now(),
      report: state.lastReport || null
    };
  },

  schedule() {
    if (this.timer) return;                       // троттлинг: первое изменение запускает таймер
    this.timer = setTimeout(() => { this.timer = 0; this.saveNow(); }, 1500);
  },

  async saveNow(force = false) {
    clearTimeout(this.timer);
    this.timer = 0;
    const data = this.payload();
    if (!data) return;
    const c = state.run?.counts;
    const signature = data.finished + '|' + (c ? `${c.done}:${c.failed}:${c.skipped}:${c.stopped}` : 'ready') + '|' + (data.report?.createdAt || '');
    if (!force && signature === this.signature) return;
    this.signature = signature;
    try { await dbPut('task', data); } catch { /* приватный режим */ }
  },

  async saveHandle(handle) {
    try { await dbPut('handle', handle); } catch { /* не критично */ }
  },

  async load() {
    try { return await dbGet('task'); } catch { return null; }
  },

  async loadHandle() {
    try { return await dbGet('handle'); } catch { return null; }
  },

  async clear() {
    clearTimeout(this.timer);
    try { await dbDelete('task'); } catch { /* ignore */ }
    this.id = null;
  }
};

/* ---------- мелкие помощники ---------- */

function showError(target, message) {
  if (!target) return;
  target.textContent = message || '';
  target.hidden = !message;
}

function basename(rel) { return rel.split('/').pop(); }
function dirname(rel) { const p = rel.split('/'); p.pop(); return p.join(' / '); }

const STATUS = {
  pending: ['в очереди', ''],
  active: ['качается', 'pill--active'],
  done: ['готово', 'pill--done'],
  skipped: ['пропущен', ''],
  failed: ['ошибка', 'pill--failed'],
  stopped: ['остановлен', '']
};

function statusPill(item) {
  const [label, cls] = STATUS[item.status] || ['—', ''];
  const p = document.createElement('span');
  p.className = 'pill ' + cls;
  if (item.status === 'active') {
    const pct = item.size ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : null;
    p.textContent = pct != null ? `${pct}%` : 'качается';
  } else {
    p.textContent = label;
  }
  return p;
}

/* ---------- выбор места ---------- */

function supportsFolders() {
  return typeof window.showDirectoryPicker === 'function';
}

function selectDestination(kind) {
  state.sinkKind = kind;
  els.pickFolder.classList.toggle('is-on', kind === 'folder');
  els.useDownloads.classList.toggle('is-on', kind === 'downloads');
  els.downloadsValue.hidden = kind !== 'downloads';
  els.folderValue.hidden = kind !== 'folder';
  if (kind === 'folder') {
    if (state.folderHandle) {
      els.folderValue.textContent = state.folderHandle.name;
      els.destHint.textContent = 'Файлы лягут в выбранную папку с той же структурой вложенных папок, что на Диске.';
    } else {
      els.destHint.textContent = 'Нажмите «Папка на компьютере»: Chrome спросит разрешение один раз, файлы лягут с той же структурой, что на Диске.';
    }
  } else {
    els.destHint.textContent = 'Файлы уйдут в «Загрузки» без вложенных папок: путь попадёт в имя через « · ». Структуру сохраняет выбор папки.';
  }
  updateCounters();
}

async function chooseFolder() {
  showError(els.linkError, '');
  if (!supportsFolders()) {
    els.destHint.textContent = 'Этот браузер не умеет писать в выбранную папку. Откройте страницу в Chrome или сохраните в «Загрузки».';
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'etagi-disk', mode: 'readwrite', startIn: 'downloads' });
    state.folderHandle = handle;
    selectDestination('folder');
    els.destHint.textContent = 'Файлы лягут в выбранную папку с той же структурой вложенных папок, что на Диске.';
    session.saveHandle(handle);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    els.destHint.textContent = 'Папку выбрать не удалось: ' + (err?.message || 'нет доступа') + '. Можно сохранить в «Загрузки».';
  }
}

/* ---------- список файлов ---------- */

function filteredFiles() {
  const q = state.filter.trim().toLowerCase();
  const files = state.scan ? state.scan.files : [];
  if (!q) return files;
  return files.filter(f => f.rel.toLowerCase().includes(q));
}

function renderList() {
  if (!state.scan) return;
  const files = filteredFiles();
  const shown = files.slice(0, state.visible);
  els.rows.textContent = '';

  const runIndex = new Map();
  if (state.run) for (const it of state.run.items) runIndex.set(it.rel, it);

  const frag = document.createDocumentFragment();
  for (const file of shown) {
    const tr = document.createElement('tr');
    tr.dataset.rel = file.rel;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'c-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(file.rel);
    cb.setAttribute('aria-label', 'Выбрать ' + file.rel);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(file.rel); else state.selected.delete(file.rel);
      updateCounters();
    });
    tdCheck.append(cb);

    const tdName = document.createElement('td');
    tdName.className = 'c-name';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = basename(file.rel);
    const path = document.createElement('span');
    path.className = 'fpath';
    path.textContent = dirname(file.rel) || 'корень папки';
    tdName.append(name, path);

    const tdSize = document.createElement('td');
    tdSize.className = 'c-size';
    tdSize.textContent = formatBytes(file.size);

    const tdState = document.createElement('td');
    tdState.className = 'c-state';
    const item = runIndex.get(file.rel);
    tdState.append(statusPill(item || { status: 'pending', size: file.size, loaded: 0 }));

    tr.append(tdCheck, tdName, tdSize, tdState);
    frag.append(tr);
  }
  els.rows.append(frag);

  els.listCount.textContent = files.length
    ? `Показано ${shown.length} из ${files.length} ${filesWord(files.length)}`
    : 'Ничего не нашлось — измените запрос.';
  els.more.hidden = shown.length >= files.length;
  if (!els.more.hidden) els.more.textContent = `Показать все ${files.length}`;
}

function renderScan() {
  const scan = state.scan;
  if (!scan) return;
  els.scanCard.hidden = false;
  els.scanEyebrow.textContent = scan.root.type === 'file' ? 'Файл' : 'Папка на Диске';
  els.scanTitle.textContent = scan.root.name;

  const stats = document.createElement('div');
  stats.className = 'stats';
  const parts = [
    [scan.files.length, filesWord(scan.files.length)],
    [scan.folders, foldersWord(scan.folders)],
    [formatBytes(scan.bytes), '']
  ];
  for (const [value, word] of parts) {
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = String(value);
    s.append(b, document.createTextNode(' ' + word));
    stats.append(s);
  }
  els.scanStats.replaceChildren(stats);

  state.visible = 12;
  renderList();
  updateCounters();
}

function updateCounters() {
  const total = state.scan ? state.scan.files.length : 0;
  const chosen = state.selected.size;
  const needFolder = state.sinkKind === 'folder' && !state.folderHandle;
  els.start.disabled = state.busy || chosen === 0 || total === 0 || needFolder;
  els.start.textContent = needFolder
    ? 'Выберите папку'
    : chosen === total && total ? `Скачать всё (${total})` : `Скачать выбранные (${chosen})`;
  if (!state.run) {
    els.runHint.textContent = needFolder
      ? 'Осталось выбрать папку в блоке «Куда сохранять» выше — или переключиться на «Загрузки браузера».'
      : 'Остановка не перезапускает загрузки сама — так ничего не теряется.';
  }
}

/* ---------- анализ ---------- */

async function analyze(rawLink) {
  showError(els.linkError, '');
  let parsed;
  try {
    parsed = parsePublicLink(rawLink);
  } catch (err) {
    showError(els.linkError, err.message);
    return;
  }

  state.link = rawLink.trim();
  state.parsed = parsed;
  state.scan = null;
  state.run = null;
  state.selected.clear();
  state.busy = true;
  els.analyze.disabled = true;
  els.analyze.textContent = 'Смотрим папки…';
  els.link.disabled = true;
  els.linkHint.textContent = 'Обходим вложенные папки — на больших папках это занимает минуту.';
  els.scanCard.hidden = true;
  els.runCard.hidden = true;
  els.errorsCard.hidden = true;

  try {
    const scan = await scanFolder({
      publicKey: parsed.publicKey,
      path: parsed.path,
      onProgress: p => {
        els.linkHint.textContent = `Обходим папки: ${p.folders} ${foldersWord(p.folders)}, ${p.files} ${filesWord(p.files)}…`;
      }
    });

    if (!scan.files.length) {
      showError(els.linkError, 'В этой папке нет файлов — скачивать нечего.');
      return;
    }
    state.scan = scan;
    for (const f of scan.files) state.selected.add(f.rel);
    els.linkHint.textContent = `Ссылка открыта: ${scan.files.length} ${filesWord(scan.files.length)}, ${scan.folders} ${foldersWord(scan.folders)} — проверьте список и выберите место.`;
    renderScan();
    els.runCard.hidden = false;
    els.errorsCard.hidden = true;
    els.reportNote.hidden = true;
    renderRun(state.run ? state.run.snapshot() : null);
    if (state.sinkKind === 'none') selectDestination(supportsFolders() ? 'folder' : 'downloads');
    updateCounters();
    els.resume.hidden = true;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    showError(els.linkError, err?.message || 'Не удалось прочитать папку.');
    els.linkHint.textContent = DEFAULT_HINT;
  } finally {
    state.busy = false;
    els.analyze.disabled = false;
    els.analyze.textContent = 'Проверить папку';
    els.link.disabled = false;
    updateCounters();
  }
}

/* ---------- загрузка ---------- */

function buildSink() {
  const key = state.scan?.publicKey || state.parsed?.publicKey;
  if (state.sinkKind === 'folder' && state.folderHandle) {
    return new HistorySink(new FolderSink(state.folderHandle), key);
  }
  return new HistorySink(new DownloadsSink(), key);
}

function startRun(files, { retry = false } = {}) {
  if (!files.length) return;
  showError(els.importError, '');
  const publicKey = state.scan?.publicKey || state.parsed?.publicKey;
  if (!publicKey) { showError(els.linkError, 'Сначала вставьте ссылку и проверьте папку.'); return; }

  const sink = buildSink();
  const run = new DownloadRun({
    publicKey, files, sink, concurrency: state.concurrency, skipExisting: true,
    onUpdate: snapshot => { renderRun(snapshot); session.schedule(); }
  });
  state.run = run;
  state.lastReport = null;
  if (!session.id) session.id = crypto.randomUUID();
  session.signature = '';
  els.runHint.textContent = 'Идёт загрузка. Вкладку можно свернуть, но не закрывать: после перезагрузки предложим продолжить.';

  if (!retry) {
    els.runCard.hidden = false;
    els.runCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  renderList();
  renderRun(run.snapshot());
  session.saveNow();

  (async () => {
    await cleanPartials(files, sink);
    await run.start();
    finishRun(run);
  })();
}

/* От прошлого запуска в папке могли остаться «*.etagi-part» — убираем, чтобы не копился мусор. */
async function cleanPartials(files, sink) {
  const folder = sink?.inner;
  if (!folder || folder.kind !== 'folder' || typeof folder.removePartial !== 'function') return;
  for (const f of files) await folder.removePartial(f.rel);
}

function finishRun(run) {
  if (state.run !== run) return;
  renderRun(run.snapshot());
  renderList();

  const report = makeReport(run, {
    link: state.link, folder: state.scan?.root?.name, destination: run.sink?.name
  });
  state.lastReport = report;
  renderReport(run, report);
  saveReportIntoFolder(report);
  const c = run.counts;
  if (!c.failed && !c.stopped) session.clear();
  else session.saveNow(true);
  els.resume.hidden = true;

  if (!c.failed && !c.stopped) {
    els.runHint.textContent = c.done + c.skipped
      ? `Готово: ${c.done} ${filesWord(c.done)} скачано${c.skipped ? `, ${c.skipped} пропущено` : ''}.`
      : 'Готово.';
  } else {
    els.runHint.textContent = `Не всё получилось: ${c.failed + c.stopped} ${filesWord(c.failed + c.stopped)} не скачалось. Отчёт ниже, повтор — по кнопке.`;
  }
}

/* Отчёт кладём рядом с файлами: он не потеряется даже если закрыть вкладку. */
async function saveReportIntoFolder(report) {
  const sink = state.run?.sink;
  if (!sink || sink.kind !== 'folder' || typeof sink.writeText !== 'function') return;
  try {
    await sink.writeText('_Отчёт.txt', reportText(report));
    await sink.writeText('_Отчёт.json', JSON.stringify(report, null, 2));
    els.reportNote.textContent = 'Копия отчёта лежит в выбранной папке: «_Отчёт.txt» и «_Отчёт.json».';
    els.reportNote.hidden = false;
  } catch { /* запись отчёта не должна ломать загрузку */ }
}

function renderRun(snapshot) {
  const run = state.run;
  if (!run) {
    els.progressBar.style.width = '0%';
    els.progressText.textContent = 'Готово к старту';
    els.progressBytes.textContent = '';
    els.pause.hidden = true;
    els.stop.hidden = true;
    updateCounters();
    return;
  }

  const c = snapshot.counts;
  const total = c.total || 1;
  const pct = snapshot.bytesTotal
    ? Math.min(100, (c.bytesDone / snapshot.bytesTotal) * 100)
    : Math.min(100, ((c.done + c.skipped + c.failed + c.stopped) / total) * 100);
  els.progressBar.style.width = pct.toFixed(1) + '%';
  els.progressBytes.textContent = snapshot.bytesTotal
    ? `${formatBytes(c.bytesDone)} из ${formatBytes(snapshot.bytesTotal)}`
    : '';

  const finished = ['done', 'stopped', 'finished-with-errors'].includes(snapshot.phase);
  const active = run.items.filter(it => it.status === 'active');

  if (snapshot.phase === 'running') {
    els.progressText.textContent = snapshot.paused
      ? `Пауза · сделано ${c.done} из ${c.total}`
      : `Скачано ${c.done} из ${c.total}${c.failed ? ` · ошибок ${c.failed}` : ''}`;
  } else if (finished) {
    els.progressText.textContent = `Готово: ${c.done} из ${c.total}${c.skipped ? ` · пропущено ${c.skipped}` : ''}${c.failed ? ` · ошибок ${c.failed}` : ''}`;
  } else {
    els.progressText.textContent = `Выбрано ${c.total} ${filesWord(c.total)}`;
  }

  els.pause.hidden = !(snapshot.phase === 'running');
  els.pause.textContent = snapshot.paused ? 'Продолжить' : 'Пауза';
  els.stop.hidden = !(snapshot.phase === 'running');
  if (snapshot.phase === 'running') {
    els.start.disabled = true;
    els.start.textContent = 'Идёт загрузка';
  } else {
    updateCounters();
  }

  // активные загрузки
  els.activeList.textContent = '';
  if (active.length) {
    els.activeList.hidden = false;
    for (const item of active.slice(0, 4)) {
      const li = document.createElement('li');
      li.className = 'active__item';
      const name = document.createElement('span');
      name.className = 'active__name';
      name.textContent = item.rel;
      name.title = item.rel;
      const meta = document.createElement('span');
      meta.className = 'active__meta';
      const percent = item.size ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : null;
      meta.textContent = item.size
        ? `${formatBytes(item.loaded)} из ${formatBytes(item.size)}${percent != null ? ` · ${percent}%` : ''}`
        : formatBytes(item.loaded);
      const bar = document.createElement('span');
      bar.className = 'active__bar';
      const fill = document.createElement('i');
      fill.style.width = (percent ?? 8) + '%';
      bar.append(fill);
      li.append(name, meta, bar);
      els.activeList.append(li);
    }
    if (active.length > 4) {
      const li = document.createElement('li');
      li.className = 'active__item';
      li.innerHTML = `<span class="active__meta">и ещё ${active.length - 4} ${filesWord(active.length - 4)}</span>`;
      els.activeList.append(li);
    }
  } else {
    els.activeList.hidden = true;
  }

  // точечно обновляем статусы в таблице
  const runIndex = new Map(run.items.map(it => [it.rel, it]));
  for (const tr of els.rows.children) {
    const rel = tr.dataset.rel;
    const item = runIndex.get(rel);
    if (!item) continue;
    const cell = tr.querySelector('.c-state');
    if (cell) cell.replaceChildren(statusPill(item));
  }
}

function renderReport(run, report) {
  const c = run.counts;
  const failed = c.failed + c.stopped;
  els.errorsCard.hidden = false;
  els.reportNote.hidden = true;
  renderSummary(c.done, c.total, c.skipped, failed, run.bytesTotal);
  renderFailures(run.errors.slice().reverse().map(e => ({ rel: e.rel, size: e.size, code: e.code, message: e.message, attempts: e.attempts })));
  els.saveReport.disabled = false;
  els.saveReportTxt.disabled = false;
}

/* Отчёт из прошлой сессии: показываем после перезагрузки, когда прогона уже нет. */
function renderStoredReport(report) {
  const s = report.stats || {};
  const total = s.files ?? 0;
  const failed = (s.failed ?? 0) + (s.stopped ?? 0);
  state.lastReport = report;
  els.errorsCard.hidden = false;
  els.reportNote.hidden = true;
  renderSummary(s.done ?? 0, total, s.skipped ?? 0, failed, s.bytes || 0);
  renderFailures((report.failed || []).map(f => ({ ...f, attempts: null })));
  els.saveReport.disabled = false;
  els.saveReportTxt.disabled = false;
}

function renderSummary(done, total, skipped, failed, bytes) {
  const onPlace = done + skipped;
  const parts = done > 0
    ? [['Скачано ', `${done} из ${total}`]]
    : [['На месте ', `${onPlace} из ${total}`]];
  if (skipped) parts.push([' · пропущено ', String(skipped)]);
  parts.push([' · не скачалось ', String(failed)]);
  if (bytes) parts.push([' · ', formatBytes(bytes)]);
  els.reportSummary.textContent = '';
  for (const [label, value] of parts) {
    els.reportSummary.append(document.createTextNode(label));
    const b = document.createElement('b');
    b.textContent = value;
    els.reportSummary.append(b);
  }
}

function renderFailures(list) {
  els.errorList.textContent = '';
  if (!list.length) {
    const li = document.createElement('li');
    const ok = document.createElement('div');
    ok.className = 'errors__path';
    ok.textContent = 'Все файлы скачаны полностью — повторить нечего.';
    li.append(ok);
    els.errorList.append(li);
  }
  for (const e of list.slice(0, 300)) {
    const li = document.createElement('li');
    const path = document.createElement('div');
    path.className = 'errors__path';
    path.textContent = e.rel;
    const why = document.createElement('div');
    why.className = 'errors__why';
    why.textContent = e.message;
    const code = document.createElement('div');
    code.className = 'errors__code';
    code.textContent = e.attempts != null ? `${e.code} · попыток: ${e.attempts}` : `${e.code || 'UNKNOWN'}`;
    li.append(path, why, code);
    els.errorList.append(li);
  }
  if (list.length > 300) {
    const li = document.createElement('li');
    li.className = 'errors__code';
    li.textContent = `…и ещё ${list.length - 300} ${filesWord(list.length - 300)} — полный список в отчёте.`;
    els.errorList.append(li);
  }
  els.retryErrors.textContent = `Повторить ошибки (${list.length})`;
  els.retryErrors.disabled = !list.length;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function currentReport() {
  if (state.lastReport) return state.lastReport;
  const run = state.run;
  if (!run) return null;
  return makeReport(run, { link: state.link, folder: state.scan?.root?.name, destination: run.sink?.name });
}

function reportFileName(ext) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safe = (state.scan?.root?.name || 'диск').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 40);
  return `Отчёт ${safe} ${stamp}.${ext}`;
}

function saveReport() {
  const report = currentReport();
  if (!report) return;
  state.lastReport = report;
  downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), reportFileName('json'));
}

function saveReportTxt() {
  const report = currentReport();
  if (!report) return;
  state.lastReport = report;
  downloadBlob(new Blob([reportText(report)], { type: 'text/plain;charset=utf-8' }), reportFileName('txt'));
}

async function importReport(file) {
  showError(els.importError, '');
  try {
    const text = await file.text();
    const report = parseReport(text);
    if (!report.failed.length) { showError(els.importError, 'В журнале нет неудачных файлов — повторять нечего.'); return; }

    let link = report.link || state.link;
    if (!link) { showError(els.importError, 'В журнале нет ссылки. Вставьте ссылку на папку выше и нажмите «Проверить папку».'); return; }
    els.link.value = link;
    const parsed = parsePublicLink(link);
    state.parsed = parsed;
    state.link = link;
    if (!state.scan) {
      state.scan = { publicKey: parsed.publicKey, root: { name: report.folder || 'из журнала' }, files: [], folders: 0, bytes: 0 };
    }
    const files = report.failed.map(f => ({ rel: f.rel, path: f.path, name: f.name || f.rel.split('/').pop(), size: f.size, md5: null, type: 'file' }));
    startRun(files, { retry: true });
    els.runHint.textContent = `Повтор из журнала: ${files.length} ${filesWord(files.length)}. Уже скачанное пропускается.`;
  } catch (err) {
    showError(els.importError, err?.message || 'Журнал не открылся.');
  }
}

/* ---------- события ---------- */

els.form.addEventListener('submit', event => {
  event.preventDefault();
  if (state.busy) return;
  analyze(els.link.value);
});

els.pickFolder.addEventListener('click', chooseFolder);
els.useDownloads.addEventListener('click', () => {
  selectDestination('downloads');
  els.destHint.textContent = 'Файлы уйдут в «Загрузки» без вложенных папок: путь попадёт в имя через « · ». Chrome спросит разрешение на несколько загрузок — разрешите.';
});

els.filter.addEventListener('input', () => {
  state.filter = els.filter.value;
  state.visible = 100;
  renderList();
});

els.selectAll.addEventListener('click', () => {
  if (!state.scan) return;
  for (const f of filteredFiles()) state.selected.add(f.rel);
  renderList();
  updateCounters();
});

els.selectNone.addEventListener('click', () => {
  for (const f of filteredFiles()) state.selected.delete(f.rel);
  renderList();
  updateCounters();
});

els.more.addEventListener('click', () => {
  state.visible += 100;
  renderList();
});

els.concurrency.addEventListener('click', event => {
  const btn = event.target.closest('.seg__btn');
  if (!btn || !btn.dataset.n) return;
  state.concurrency = Number(btn.dataset.n);
  for (const b of els.concurrency.querySelectorAll('.seg__btn')) b.classList.toggle('is-on', b === btn);
  if (state.run?.phase === 'running') {
    els.runHint.textContent = 'Новое число потоков применится к следующему запуску.';
  }
});

els.start.addEventListener('click', () => {
  if (!state.scan) return;
  const files = state.scan.files.filter(f => state.selected.has(f.rel));
  if (!files.length) return;
  startRun(files);
});

els.pause.addEventListener('click', () => {
  const run = state.run;
  if (!run) return;
  if (run.paused) run.resume(); else run.pause();
});

els.stop.addEventListener('click', () => {
  state.run?.stop();
});

els.retryErrors.addEventListener('click', async () => {
  const run = state.run;
  if (run && run.errors.length) {
    const byRel = new Map(run.items.map(it => [it.rel, it]));
    const files = run.errors.map(e => {
      const it = byRel.get(e.rel);
      return { rel: e.rel, path: e.path, name: it?.name || basename(e.rel), size: e.size, md5: null, type: 'file' };
    });
    startRun(files, { retry: true });
    return;
  }
  // после перезагрузки прогона уже нет — продолжаем сохранённую задачу
  const saved = await session.load();
  if (saved) resumeSaved(saved);
});

els.saveReport.addEventListener('click', saveReport);
els.saveReportTxt.addEventListener('click', saveReportTxt);

els.reportFile.addEventListener('change', () => {
  const file = els.reportFile.files?.[0];
  if (file) importReport(file);
  els.reportFile.value = '';
});

if (!supportsFolders()) {
  els.pickFolder.disabled = true;
  els.destHint.textContent = 'Выбор папки — только Chrome и Edge. Здесь файлы сохранятся в «Загрузки».';
  selectDestination('downloads');
}

const remembered = (() => {
  try { return localStorage.getItem('etagi-disk.link') || ''; } catch { return ''; }
})();
if (remembered) els.link.value = remembered;
els.link.addEventListener('change', () => {
  try { localStorage.setItem('etagi-disk.link', els.link.value.trim()); } catch { /* ignore */ }
});

// для проверок в браузере
window.__etagi = { state, analyze, startRun, renderList, renderReport, history, session, VERSION, CaptureSink, FolderSink, DownloadsSink, DownloadRun, scanFolder, parsePublicLink, makeReport, parseReport, reportText, formatBytes };

/* ---------- продолжение после перезагрузки ---------- */

async function initResume() {
  const saved = await session.load();
  if (!saved || saved.finished) return;
  const left = saved.files.filter(f => !['done', 'skipped'].includes(f.status)).length;
  if (!left) return;

  session.id = saved.id || crypto.randomUUID();
  els.resume.hidden = false;
  const finishedBefore = ['done', 'finished-with-errors', 'stopped'].includes(saved.phase);
  const doneCount = saved.files.length - left;
  els.resumeTitle.textContent = finishedBefore
    ? `В прошлый раз не всё скачалось: ${left} из ${saved.files.length}`
    : `Незаконченная загрузка: ${saved.rootName || 'папка с Диска'}`;
  els.resumeGo.textContent = finishedBefore ? 'Повторить' : 'Продолжить';
  const when = saved.updatedAt ? new Date(saved.updatedAt).toLocaleString('ru-RU') : '—';
  els.resumeMeta.textContent = finishedBefore
    ? `Скачано ${doneCount} из ${saved.files.length} · ${saved.sinkKind === 'folder' ? 'в папку на компьютере' : 'в «Загрузки»'} · ${when}`
    : `Скачано ${doneCount} из ${saved.files.length} · ${saved.sinkKind === 'folder' ? 'в папку на компьютере' : 'в «Загрузки»'} · последнее обновление ${when}`;

  els.resumeGo.addEventListener('click', () => resumeSaved(saved), { once: true });
  els.resumeDrop.addEventListener('click', async () => {
    await session.clear();
    els.resume.hidden = true;
  }, { once: true });

  if (saved.report) renderStoredReport(saved.report);
}

async function resumeSaved(saved) {
  try {
    let handle = null;
    if (saved.sinkKind === 'folder') {
      handle = await session.loadHandle();
      if (handle?.queryPermission) {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted' && handle.requestPermission) perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          handle = null;
          showError(els.linkError, 'Chrome не дал доступ к прежней папке — выберите её заново, файлы уже внутри продолжатся с места.');
        }
      }
    }

    state.link = saved.link;
    state.parsed = parsePublicLink(saved.link);
    state.folderHandle = handle;
    state.sinkKind = saved.sinkKind === 'folder' && handle ? 'folder' : 'downloads';
    state.concurrency = saved.concurrency || 5;
    state.scan = {
      publicKey: saved.publicKey,
      root: { name: saved.rootName || 'из прошлого запуска', type: 'dir' },
      files: saved.files.map(f => ({
        rel: f.rel, path: f.path, name: f.rel.split('/').pop(),
        size: f.size ?? null, md5: null, type: 'file'
      })),
      folders: saved.folders || 0,
      bytes: saved.bytesTotal || 0
    };
    state.selected = new Set(saved.files.map(f => f.rel));
    els.link.value = saved.link;

    for (const b of els.concurrency.querySelectorAll('.seg__btn')) {
      b.classList.toggle('is-on', Number(b.dataset.n) === state.concurrency);
    }
    selectDestination(state.sinkKind);
    renderScan();
    els.scanCard.hidden = false;
    els.runCard.hidden = false;
    els.resume.hidden = true;
    showError(els.linkError, '');

    startRun(state.scan.files.filter(f => state.selected.has(f.rel)));
  } catch (err) {
    showError(els.linkError, 'Не удалось продолжить: ' + (err?.message || 'неизвестная ошибка'));
  }
}

window.addEventListener('pagehide', () => { session.saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') session.saveNow(); });

initResume();
