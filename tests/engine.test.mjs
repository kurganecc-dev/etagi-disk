/* Тесты движка на реальной публичной папке «Этажей».
   Запуск: node tests/engine.test.mjs
   Проверяет: разбор ссылок, обход папок, скачивание всех файлов, размеры и MD5. */
import { createHash } from 'node:crypto';
import { parsePublicLink, scanFolder, DownloadRun, CaptureSink, makeReport, parseReport, formatBytes, DiskError } from '../js/engine.js';

const KEY = 'https://disk.yandex.ru/d/VSznp1PcQJaSxg';
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

/* --- разбор ссылок --- */
const good = [
  ['https://disk.yandex.ru/d/VSznp1PcQJaSxg', { kind: 'dir', path: '/' }],
  ['https://disk.yandex.ru/d/VSznp1PcQJaSxg/', { kind: 'dir', path: '/' }],
  ['https://yadi.sk/d/VSznp1PcQJaSxg', { kind: 'dir', path: '/' }],
  ['https://disk.yandex.com/d/VSznp1PcQJaSxg/sub/folder', { path: '/sub/folder' }],
  ['https://disk.yandex.ru/i/AbCdEf12345', { kind: 'file' }],
  ['  https://disk.yandex.ru/d/VSznp1PcQJaSxg  ', { kind: 'dir' }]
];
for (const [link, expect] of good) {
  try {
    const p = parsePublicLink(link);
    const pass = Object.entries(expect).every(([k, v]) => p[k] === v);
    ok(pass, `ссылка принята: ${link.trim()}`, JSON.stringify({ kind: p.kind, path: p.path, key: p.publicKey }));
  } catch (e) { ok(false, `ссылка должна приниматься: ${link}`, e.message); }
}
const bad = ['', 'не ссылка', 'http://disk.yandex.ru/d/VSznp1PcQJaSxg', 'https://disk.yandex.ru/d/', 'https://example.com/d/VSznp1PcQJaSxg', 'https://disk.yandex.ru/d/VSznp1PcQJaSxg/../etc'];
for (const link of bad) {
  try { parsePublicLink(link); ok(false, `должна быть ошибка: «${link}»`); }
  catch (e) { ok(e instanceof DiskError, `ошибка отклонена: «${link}»`, e.code); }
}
ok(formatBytes(12354234) === '11,8 МБ', 'formatBytes', formatBytes(12354234));

/* --- обход папки --- */
const parsed = parsePublicLink(KEY);
const t0 = Date.now();
let lastProgress = null;
const scan = await scanFolder({ publicKey: parsed.publicKey, path: parsed.path, onProgress: p => lastProgress = p });
ok(scan.root.name === '1_Логотипы', 'имя папки', scan.root.name);
ok(scan.files.length > 0, 'файлы найдены', `${scan.files.length} файлов, ${scan.folders} папок, ${formatBytes(scan.bytes)}`);
ok(scan.files.every(f => f.rel && !f.rel.startsWith('/')), 'относительные пути без ведущего слэша');
ok(new Set(scan.files.map(f => f.rel)).size === scan.files.length, 'пути уникальны');
console.log(`  скан: ${((Date.now() - t0) / 1000).toFixed(1)} с, последний прогресс: ${JSON.stringify(lastProgress)}`);

const totalBytes = scan.files.reduce((s, f) => s + (f.size || 0), 0);
ok(totalBytes === scan.bytes, 'сумма размеров сходится', formatBytes(totalBytes));

/* --- какие файлы качаем: по умолчанию небольшая выборка, FULL=1 — вся папка --- */
const full = process.env.FULL === '1';
let sample = scan.files;
if (!full) {
  sample = scan.files.filter(f => (f.size || 0) <= 60000).slice(0, 12);
  console.log(`  выборка: ${sample.length} файлов до 60 КБ (FULL=1 — вся папка)`);
}
function collatorCompare(a, b) { return a.localeCompare(b, 'ru', { numeric: true }); }

/* --- скачивание --- */
const sink = new CaptureSink();
const run = new DownloadRun({ publicKey: parsed.publicKey, files: sample, sink, concurrency: 5 });
let updates = 0;
run.onUpdate = () => updates++;
const t1 = Date.now();
await run.start();
const c = run.counts;
const sampleBytes = sample.reduce((s, f) => s + (f.size || 0), 0);
console.log(`  загрузка: ${((Date.now() - t1) / 1000).toFixed(1)} с, обновлений интерфейса: ${updates}`);
if (run.errors.length) console.log('  ошибки:', run.errors.map(e => `${e.rel} — ${e.code}: ${e.message}`).join(' | '));
ok(run.phase === 'done', 'прогон завершён без ошибок', run.phase);
ok(c.done === sample.length, 'скачаны все файлы', `${c.done}/${sample.length}`);
ok(c.failed === 0, 'ошибок нет', String(c.failed));
ok(sink.files.size === sample.length, 'в приёмнике столько же файлов', String(sink.files.size));
ok(sink.bytes === sampleBytes, 'байт скачано столько же, сколько в выборке', `${sink.bytes} / ${sampleBytes}`);

let md5ok = 0, md5bad = [];
for (const f of sample) {
  const buf = sink.files.get(f.rel);
  if (!f.md5 || !buf) continue;
  const hash = createHash('md5').update(Buffer.from(buf)).digest('hex');
  if (hash === f.md5) md5ok++; else md5bad.push(f.rel);
}
ok(md5bad.length === 0 && md5ok > 0, `MD5 совпал у ${md5ok} файлов`, md5bad.slice(0, 3).join(', '));
ok([...sink.files.keys()].some(k => k.includes('/')), 'вложенные папки сохранены в путях', [...sink.files.keys()][0]);

/* --- журнал --- */
const report = makeReport(run, { link: KEY, folder: scan.root.name, destination: 'test' });
const round = parseReport(JSON.stringify(report));
ok(round.failed.length === report.failed.length && round.link === KEY, 'журнал читается обратно', `${round.failed.length} файлов в журнале`);
const broken = { ...report, failed: [{ rel: 'a/b.png', path: '/a/b.png', size: 10, code: 'NETWORK', message: 'нет сети' }] };
const retry = parseReport(JSON.stringify(broken));
ok(retry.failed.length === 1 && retry.failed[0].rel === 'a/b.png', 'журнал с ошибками даёт список для повтора');

console.log(failures ? `\n${failures} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failures ? 1 : 0);
