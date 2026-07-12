// Test de bout en bout dans Chromium : sélection → tags → ZIP → structure
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');

const APP = process.env.APP_HTML || path.join(__dirname, '..', 'index.html');
const FIX = path.join(__dirname, 'fixtures');
const DL = path.join(__dirname, 'downloads');
const JSZIP = process.env.JSZIP_PATH || path.join(__dirname, 'jszip.min.js'); // sinon la page charge cdnjs par le réseau

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

function unzipList(zipPath) {
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  return out.trim().split('\n').filter(l => l && !l.endsWith('/'));
}
function checkPaths(paths) {
  let structural = 0;
  for (const p of paths) {
    if (!/^MUSIC\/[^/]+\/[^/]+\.mp3$/.test(p)) { structural++; console.error('  ✗ structure: ' + p); }
    if (!/^[\x20-\x7E]+$/.test(p)) { structural++; console.error('  ✗ non-ASCII: ' + p); }
    const parts = p.split('/');
    if (parts[1].length > 60) { structural++; console.error('  ✗ dossier >60: ' + parts[1]); }
    if (parts[2].length > 60) { structural++; console.error('  ✗ fichier >60: ' + parts[2] + ' (' + parts[2].length + ')'); }
  }
  ok(structural === 0, 'structure 2 niveaux / ASCII / ≤60 sur ' + paths.length + ' chemins');
  ok(new Set(paths.map(p => p.toLowerCase())).size === paths.length, 'aucune collision de noms (même insensible à la casse)');
}

async function newPage(browser) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  if (fs.existsSync(JSZIP)) await page.route('**cdnjs.cloudflare.com/**jszip**', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(JSZIP, 'utf8') }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**fonts.gstatic.com/**', r => r.abort());
  const downloads = [];
  page.on('download', d => downloads.push(d));
  page.on('dialog', d => { page._lastDialog = d.message(); d.accept(); });
  await page.goto('file://' + APP);
  await page.waitForFunction(() => typeof JSZip !== 'undefined');
  return { ctx, page, downloads };
}

const waitDone = page => page.waitForFunction(() =>
  document.getElementById('doneBox').style.display === 'block'
  || document.getElementById('lcdMsg').textContent === 'ERROR', null, { timeout: 300000 });

async function saveDownloads(page, downloads, sub) {
  const dir = path.join(DL, sub);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  await waitDone(page);
  await page.waitForTimeout(1000);
  const saved = [];
  for (const d of downloads) {
    const f = path.join(dir, d.suggestedFilename());
    await d.saveAs(f); saved.push(f);
  }
  downloads.length = 0;
  return saved;
}

// injecte un fichier arabe côté page (setInputFiles de CDP perd les noms non-ASCII)
async function addArabicFile(page) {
  const bytes = [...fs.readFileSync(path.join(FIX, 'فنان مجهول - أغنية جميلة.mp3'))];
  await page.evaluate(b => {
    const f = new File([new Uint8Array(b)], 'فنان مجهول - أغنية جميلة.mp3', { type: 'audio/mpeg' });
    return handleFiles([f]);
  }, bytes);
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  const asciiFixtures = fs.readdirSync(FIX)
    .filter(f => f !== '_expect.json' && /^[\x20-\x7E]+$/.test(f))
    .map(f => path.join(FIX, f));
  const nMp3 = asciiFixtures.filter(f => f.endsWith('.mp3')).length + 1; // +1 fichier arabe injecté

  // ============ Scénario 1 : ZIP unique + numérotation + doublons ============
  {
    console.log('— Scénario 1 : ZIP unique + numérotation —');
    const { ctx, page, downloads } = await newPage(browser);
    await page.setInputFiles('#fileInput', asciiFixtures);
    await page.waitForSelector('#reviewStep', { state: 'visible' });
    ok((await page.$eval('#warnBox', e => e.style.display)) === 'block', 'avertissement fichiers non-MP3 affiché');
    await addArabicFile(page);
    ok(await page.$eval('#lcdF', e => e.textContent) == String(nMp3), 'compteur FILES = ' + nMp3);
    ok((await page.$eval('#dedupBtn', e => e.style.display)) !== 'none', 'bouton doublons visible (copie détectée)');
    // resélectionner les mêmes fichiers ne doit rien dupliquer
    await page.setInputFiles('#fileInput', asciiFixtures.slice(0, 3));
    await page.waitForTimeout(300);
    ok(await page.$eval('#lcdF', e => e.textContent) == String(nMp3), 'resélection des mêmes fichiers: aucun doublon ajouté');
    await page.uncheck('#optSplit'); await page.check('#optNum');
    await page.click('#buildBtn');
    const saved = await saveDownloads(page, downloads, 's1');
    ok(saved.length === 1 && path.basename(saved[0]) === 'MUSIC_USB.zip', '1 seul ZIP nommé MUSIC_USB.zip');
    const paths = unzipList(saved[0]);
    ok(paths.length === nMp3, 'toutes les pistes présentes (' + paths.length + '/' + nMp3 + ')');
    checkPaths(paths);
    ok(paths.some(p => /\/\d\d - /.test(p)), 'numérotation 01, 02 présente');
    ok(paths.some(p => p.includes('Fnan Mjhoul')), 'fichier au nom arabe transcrit: ' + (paths.find(p => p.includes('Fnan')) || 'ABSENT'));
    await ctx.close();
  }

  // ============ Scénario 2 : découpage en plusieurs ZIPs ============
  {
    console.log('— Scénario 2 : ZIPs découpés par taille —');
    const { ctx, page, downloads } = await newPage(browser);
    await page.evaluate(() => { MAX_ZIP_BYTES = 100 * 1024; }); // forcer le découpage avec de petits fichiers
    await page.setInputFiles('#fileInput', asciiFixtures);
    await page.waitForSelector('#reviewStep', { state: 'visible' });
    await page.click('#buildBtn');
    const saved = await saveDownloads(page, downloads, 's2');
    ok(saved.length >= 2, 'plusieurs ZIPs téléchargés (' + saved.length + ')');
    ok(saved.every(f => /MUSIC_\d+_sur_\d+\.zip/.test(path.basename(f))), 'nommage MUSIC_i_sur_N.zip: ' + saved.map(f => path.basename(f)).join(', '));
    const all = saved.flatMap(unzipList);
    ok(all.length === nMp3 - 1, 'toutes les pistes réparties (' + all.length + '/' + (nMp3 - 1) + ')');
    checkPaths(all);
    await ctx.close();
  }

  // ============ Scénario 3 : fichiers "cloud" illisibles → sautés ============
  {
    console.log('— Scénario 3 : fichiers cloud sautés —');
    const { ctx, page, downloads } = await newPage(browser);
    await page.setInputFiles('#fileInput', [path.join(FIX, 'v23_cp1256.mp3'), path.join(FIX, 'v24_utf8.mp3')]);
    await page.waitForSelector('#reviewStep', { state: 'visible' });
    await page.evaluate(() => {
      const bad = new File([new Uint8Array(2000)], 'cloud_song.mp3', { type: 'audio/mpeg' });
      const reject = () => Promise.reject(new DOMException('A requested file or directory could not be found.', 'NotFoundError'));
      Object.defineProperty(bad, 'arrayBuffer', { value: reject });
      const origSlice = bad.slice.bind(bad);
      Object.defineProperty(bad, 'slice', { value: (...a) => { const b = origSlice(...a); Object.defineProperty(b, 'arrayBuffer', { value: reject }); return b; } });
      return handleFiles([bad]);
    });
    ok(await page.evaluate(() => songs.length) === 3, 'fichier cloud accepté dans la liste (échec seulement à la lecture)');
    await page.uncheck('#optSplit');
    await page.click('#buildBtn');
    const saved = await saveDownloads(page, downloads, 's3');
    ok(saved.length === 1, 'ZIP quand même produit');
    ok(unzipList(saved[0]).length === 2, 'les 2 fichiers lisibles sont dedans');
    const doneHtml = await page.$eval('#doneBox', e => e.innerHTML);
    ok(doneHtml.includes('cloud_song.mp3'), 'le fichier cloud est listé comme sauté');
    ok((await page.$eval('#lcdMsg', e => e.textContent)) === 'DONE ✓', 'LCD affiche DONE malgré le fichier sauté');
    await ctx.close();
  }

  // ============ Scénario 3b : QUE des fichiers cloud → message clair, pas de crash ============
  {
    console.log('— Scénario 3b : uniquement des fichiers cloud —');
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => {
      const mk = n => {
        const f = new File([new Uint8Array(1000)], n, { type: 'audio/mpeg' });
        const reject = () => Promise.reject(new DOMException('not found', 'NotFoundError'));
        Object.defineProperty(f, 'arrayBuffer', { value: reject });
        const s = f.slice.bind(f);
        Object.defineProperty(f, 'slice', { value: (...a) => { const b = s(...a); Object.defineProperty(b, 'arrayBuffer', { value: reject }); return b; } });
        return f;
      };
      return handleFiles([mk('ghost1.mp3'), mk('ghost2.mp3')]);
    });
    await page.click('#buildBtn');
    await page.waitForFunction(() => document.getElementById('lcdMsg').textContent === 'ERROR', null, { timeout: 60000 });
    ok((page._lastDialog || '').includes('السحابة'), 'alerte explicative (cloud) affichée');
    ok(!(await page.$eval('#buildBtn', e => e.disabled)), 'bouton réactivé après échec');
    await ctx.close();
  }

  // ============ Scénario 4 : 200 fichiers, découpage ~30MB ============
  {
    console.log('— Scénario 4 : 200 fichiers —');
    const BIG = path.join(__dirname, 'big');
    if (!fs.existsSync(BIG) || fs.readdirSync(BIG).length < 200) {
      fs.rmSync(BIG, { recursive: true, force: true }); fs.mkdirSync(BIG, { recursive: true });
      execFileSync('node', [path.join(__dirname, 'gen-200.js'), BIG]);
    }
    const files = fs.readdirSync(BIG).map(f => path.join(BIG, f));
    const { ctx, page, downloads } = await newPage(browser);
    await page.evaluate(() => { MAX_ZIP_BYTES = 30 * 1e6; });
    const t0 = Date.now();
    await page.setInputFiles('#fileInput', files);
    await page.waitForSelector('#reviewStep', { state: 'visible', timeout: 240000 });
    console.log('  (info) lecture des tags de 200 fichiers en', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    ok(await page.$eval('#lcdF', e => e.textContent) == '200', 'compteur FILES = 200');
    await page.click('#buildBtn');
    const saved = await saveDownloads(page, downloads, 's4');
    const all = saved.flatMap(unzipList);
    ok(all.length === 200, '200 pistes dans les ZIPs (' + all.length + ')');
    ok(saved.length >= 3, 'découpage en parties (' + saved.length + ' ZIPs)');
    ok(saved.every(f => fs.statSync(f).size <= 32 * 1e6), 'chaque ZIP ≤ ~30MB');
    checkPaths(all);
    console.log('  (info)', saved.length, 'ZIPs:', saved.map(f => path.basename(f) + ' ' + (fs.statSync(f).size / 1e6).toFixed(1) + 'MB').join(', '));
    await ctx.close();
  }

  // ============ Scénario 5 : les corrections de noms survivent à "مسح الكل" + resélection ============
  {
    console.log('— Scénario 5 : mémorisation des corrections —');
    const { ctx, page } = await newPage(browser);
    const two = [path.join(FIX, 'v23_cp1256.mp3'), path.join(FIX, 'Track99.mp3')];
    await page.setInputFiles('#fileInput', two);
    await page.waitForSelector('#reviewStep', { state: 'visible' });
    // corriger le nom d'artiste du 1er groupe
    await page.fill('.group header input >> nth=0', 'Nass El Ghiwane');
    await page.dispatchEvent('.group header input >> nth=0', 'change');
    // tout effacer puis resélectionner
    await page.click('#clearBtn');
    ok((await page.$eval('#reviewStep', e => e.style.display)) === 'none', 'liste vidée');
    await page.setInputFiles('#fileInput', two);
    await page.waitForSelector('#reviewStep', { state: 'visible' });
    const artists = await page.$$eval('.group header input', els => els.map(e => e.value));
    ok(artists.includes('Nass El Ghiwane'), 'correction restaurée après resélection: ' + artists.join(' | '));
    await ctx.close();
  }

  // ============ Scénario 6 : copie directe (writeDirect, mêmes API que showDirectoryPicker) ============
  {
    console.log('— Scénario 6 : copie directe sans téléchargement —');
    // OPFS exige un contexte sécurisé → petit serveur http://127.0.0.1
    const http = require('http');
    const appDir = path.dirname(APP);
    const server = http.createServer((req, res) => {
      const p = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
      try {
        res.setHeader('Content-Type', p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
        res.end(fs.readFileSync(path.join(appDir, p)));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (fs.existsSync(JSZIP)) await page.route('**cdnjs.cloudflare.com/**jszip**', r =>
      r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(JSZIP, 'utf8') }));
    await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**fonts.gstatic.com/**', r => r.abort());
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await page.waitForFunction(() => typeof JSZip !== 'undefined');
    console.log('  (info) showDirectoryPicker dans ce navigateur de test:', await page.evaluate(() => 'showDirectoryPicker' in window));
    await page.setInputFiles('#fileInput', [path.join(FIX, 'v23_cp1256.mp3'), path.join(FIX, 'v24_utf8.mp3'), path.join(FIX, 'Track99.mp3')]);
    await page.waitForSelector('#reviewStep', { state: 'visible' });
    await page.evaluate(() => { // + un fichier cloud illisible
      const bad = new File([new Uint8Array(2000)], 'cloud_song.mp3', { type: 'audio/mpeg' });
      const reject = () => Promise.reject(new DOMException('not found', 'NotFoundError'));
      Object.defineProperty(bad, 'arrayBuffer', { value: reject });
      Object.defineProperty(bad, 'stream', { value: () => new ReadableStream({ start(c) { c.error(new DOMException('not found', 'NotFoundError')); } }) });
      const s = bad.slice.bind(bad);
      Object.defineProperty(bad, 'slice', { value: (...a) => { const b = s(...a); Object.defineProperty(b, 'arrayBuffer', { value: reject }); return b; } });
      return handleFiles([bad]);
    });
    const r = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory(); // OPFS : mêmes handles que showDirectoryPicker
      await root.removeEntry('MUSIC', { recursive: true }).catch(() => {});
      const entries = buildPlan(songs.map((s, i) => ({ id: i, artist: s.latinArtist, title: s.latinTitle, size: s.file.size })), false, Infinity).flat();
      const res = await writeDirect(root, entries, () => {});
      const paths = [];
      const music = await root.getDirectoryHandle('MUSIC');
      for await (const [name, h] of music.entries()) {
        if (h.kind !== 'directory') { paths.push('MUSIC/' + name); continue; }
        for await (const [n2, h2] of h.entries()) {
          const f = await h2.getFile();
          paths.push('MUSIC/' + name + '/' + n2 + '|' + f.size);
        }
      }
      return { added: res.added, failed: res.failed, paths: paths.sort() };
    });
    ok(r.added === 3, '3 fichiers lisibles copiés directement (' + r.added + ')');
    ok(r.failed.length === 1 && r.failed[0] === 'cloud_song.mp3', 'fichier cloud sauté et signalé');
    ok(r.paths.length === 3, 'aucun fichier fantôme à moitié écrit: ' + r.paths.join(', '));
    ok(r.paths.every(p => /^MUSIC\/[\x20-\x7E]+\/[\x20-\x7E]+\.mp3\|[1-9]\d*$/.test(p)), 'structure MUSIC/Artiste/Titre.mp3, ASCII, taille > 0');
    const sizes = r.paths.map(p => +p.split('|')[1]);
    const expected = ['v23_cp1256.mp3', 'v24_utf8.mp3', 'Track99.mp3'].map(f => fs.statSync(path.join(FIX, f)).size).sort((a, b) => a - b);
    ok(JSON.stringify(sizes.sort((a, b) => a - b)) === JSON.stringify(expected), 'contenus copiés intégralement (tailles identiques)');
    await ctx.close(); server.close();
  }

  // ============ Scénario 7 : organisation d'une clé USB sur place (scan + move) ============
  {
    console.log('— Scénario 7 : organiser la clé USB sur place —');
    const http = require('http');
    const appDir = path.dirname(APP);
    const server = http.createServer((req, res) => {
      const p = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
      try {
        res.setHeader('Content-Type', p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
        res.end(fs.readFileSync(path.join(appDir, p)));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (fs.existsSync(JSZIP)) await page.route('**cdnjs.cloudflare.com/**jszip**', r =>
      r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(JSZIP, 'utf8') }));
    await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**fonts.gstatic.com/**', r => r.abort());
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await page.waitForFunction(() => typeof JSZip !== 'undefined');

    // fausse clé USB dans l'OPFS :
    //  - un fichier déjà bien rangé (doit être laissé en place)
    //  - un « chaises musicales » : un fichier occupe l'emplacement cible d'un autre
    //  - un fichier sans tags à la racine
    const bytes = f => [...fs.readFileSync(path.join(FIX, f))];
    const tree = [
      ['MUSIC/Alhaja Alhmdaouia/Hzi Kask.mp3', bytes('v23_utf16.mp3')],  // tags: Said Alsnhaji → doit partir
      ['random/Chansons/hzi.mp3',              bytes('v22_utf16.mp3')],  // tags: Alhaja → doit prendre sa place
      ['Track99.mp3',                          bytes('Track99.mp3')],
      ['MUSIC/Abd Alhadi Blkhiat/Alqmr Ala Hmr.mp3', bytes('v24_utf8.mp3')], // déjà rangé
    ];
    const r = await page.evaluate(async (tree) => {
      const root = await navigator.storage.getDirectory();
      for await (const h of root.values()) await root.removeEntry(h.name, { recursive: true }).catch(() => {});
      async function put(relPath, arr) {
        const parts = relPath.split('/'); let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable(); await w.write(new Uint8Array(arr)); await w.close();
      }
      for (const [p, arr] of tree) await put(p, arr);
      const okLoad = await loadFromUsb(root);
      const usbButtons = {
        go: document.getElementById('organizeGoBtn').style.display,
        zip: document.getElementById('buildBtn').style.display,
      };
      const r1 = await organizeUsb(root, () => {});
      const r2 = await organizeUsb(root, () => {}); // idempotence
      async function list(dir, base, out) {
        for await (const h of dir.values()) {
          if (h.kind === 'directory') await list(h, base + h.name + '/', out);
          else out.push(base + h.name + '|' + (await h.getFile()).size);
        }
        return out;
      }
      return {
        okLoad, usbButtons,
        r1: { moved: r1.moved, already: r1.already, failed: r1.failed },
        r2: { moved: r2.moved, already: r2.already, failed: r2.failed },
        paths: (await list(root, '', [])).sort(),
      };
    }, tree);

    ok(r.okLoad === true, 'scan de la clé réussi');
    ok(r.usbButtons.go === 'block' && r.usbButtons.zip === 'none', 'mode clé: bouton organiser affiché, bouton ZIP masqué');
    ok(r.r1.moved === 3 && r.r1.already === 1 && r.r1.failed.length === 0,
      '1er passage: 3 déplacés, 1 déjà en place, 0 échec → ' + JSON.stringify(r.r1));
    ok(r.r2.moved === 0 && r.r2.already === 4, '2e passage: rien à refaire (idempotent) → ' + JSON.stringify(r.r2));
    const files = r.paths.filter(p => p.endsWith('.mp3') || p.includes('.mp3|'));
    const sz = f => fs.statSync(path.join(FIX, f)).size;
    const expected = [
      'MUSIC/Abd Alhadi Blkhiat/Alqmr Ala Hmr.mp3|' + sz('v24_utf8.mp3'),
      'MUSIC/Alhaja Alhmdaouia/Hzi Kask.mp3|' + sz('v22_utf16.mp3'),
      'MUSIC/Artiste Inconnu/Track99.mp3|' + sz('Track99.mp3'),
      'MUSIC/Said Alsnhaji/Chhal Bkit.mp3|' + sz('v23_utf16.mp3'),
    ];
    ok(JSON.stringify(files) === JSON.stringify(expected),
      'clé finale exacte (chaises musicales résolues, aucun écrasement):\n    ' + files.join('\n    '));
    ok(!r.paths.some(p => p.includes('~')), 'aucun fichier temporaire restant');
    await ctx.close(); server.close();
  }

  await browser.close();
  console.log(`\ne2e: ${pass} OK, ${fail} ÉCHEC(S)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
