// Tests unitaires : extrait les fonctions pures de index.html et les exécute sous Node
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(process.env.APP_HTML || path.join(__dirname, '..', 'index.html'), 'utf8');
const script = HTML.match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/<\/?script>/g, '')).join('\n');

// on ne garde que la partie pure (avant "App state" qui touche au DOM)
const cut = script.indexOf('/* ================= App state');
if (cut < 0) { console.error('marqueur App state introuvable'); process.exit(1); }
const pure = script.slice(0, cut);

const sandbox = {};
new Function('exports', pure + `
  exports.toLatin = toLatin; exports.sanitize = sanitize;
  exports.readText = readText; exports.readTags = readTags;
  if (typeof uniqueName === 'function') exports.uniqueName = uniqueName;
  if (typeof buildPlan === 'function') exports.buildPlan = buildPlan;
  if (typeof findDuplicates === 'function') exports.findDuplicates = findDuplicates;
`)(sandbox);
const { toLatin, sanitize, readTags, uniqueName, buildPlan, findDuplicates } = sandbox;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

(async () => {
  // ---- translitération ----
  ok(toLatin('ناس الغيوان') === 'Nas Alghiouan', 'toLatin arabe simple → "' + toLatin('ناس الغيوان') + '"');
  ok(toLatin('Chèb Khaléd') === 'Cheb Khaled', 'accents français retirés → "' + toLatin('Chèb Khaléd') + '"');
  ok(/^[\x20-\x7E]*$/.test(toLatin('عبد الهادي بلخياط أغنية ١٢٣')), 'sortie 100% ASCII');
  ok(toLatin('a*b?c:d"e<f>g|h/i\\j') .indexOf('*') === -1, 'caractères interdits FAT32 retirés');
  ok(sanitize('x'.repeat(100)).length <= 60, 'sanitize ≤ 60 caractères');
  ok(sanitize('') === '', 'sanitize vide');

  // ---- lecture des tags sur les fixtures ----
  const FIX = path.join(__dirname, 'fixtures');
  const expects = JSON.parse(fs.readFileSync(path.join(FIX, '_expect.json'), 'utf8'));
  for (const { name, expect } of expects) {
    if (expect.excluded || expect.dupOf || expect.longNames) continue;
    const buf = fs.readFileSync(path.join(FIX, name));
    const file = new File([buf], name, { type: 'audio/mpeg' });
    const tags = await readTags(file);
    ok(tags.artist === expect.artist, name + ' artiste: attendu "' + expect.artist + '" obtenu "' + tags.artist + '"');
    ok(tags.title === expect.title, name + ' titre: attendu "' + expect.title + '" obtenu "' + tags.title + '"');
  }

  // ---- fichier "cloud" : arrayBuffer() rejette ----
  const ghost = new File([Buffer.alloc(10)], 'ghost.mp3');
  ghost.slice = () => ({ arrayBuffer: () => Promise.reject(new DOMException('not found', 'NotFoundError')) });
  const t = await readTags(ghost); // ne doit PAS lancer
  ok(t.title === 'ghost', 'fichier cloud: readTags ne plante pas, fallback nom');

  // ---- plan de nommage / découpage (nouvelles fonctions pures) ----
  if (uniqueName && buildPlan && findDuplicates) {
    const used = new Set();
    ok(uniqueName('01 - ' + 'x'.repeat(80), used).length <= 56, 'uniqueName ≤ 56');
    ok(uniqueName('01 - ' + 'x'.repeat(80), used).startsWith('01 - '), 'préfixe numérotation conservé en collision');
    const u2 = new Set();
    ok(uniqueName('Abc', u2) === 'Abc' && uniqueName('ABC', u2) === 'ABC (2)', 'collision insensible à la casse (FAT32)');

    const items = [
      { id: 0, artist: 'B', title: 'T1', size: 100 },
      { id: 1, artist: 'A', title: 'T1', size: 100 },
      { id: 2, artist: 'A', title: 'T1', size: 100 },
      { id: 3, artist: 'A', title: 'T2', size: 250 },
    ];
    const chunks = buildPlan(items, false, 300);
    const flat = chunks.flat();
    ok(flat.length === 4, 'buildPlan: toutes les entrées présentes');
    ok(flat[0].folder === 'A', 'buildPlan: tri alphabétique des artistes');
    const namesA = flat.filter(e => e.folder === 'A').map(e => e.name);
    ok(new Set(namesA.map(n => n.toLowerCase())).size === 3, 'collisions résolues globalement: ' + namesA.join(', '));
    ok(chunks.every(c => c.reduce((a, e) => a + e.size, 0) <= 300 || c.length === 1), 'chaque lot ≤ maxBytes (' + chunks.map(c => c.reduce((a, e) => a + e.size, 0)).join('/') + ')');
    ok(chunks.length >= 2, 'découpage effectif en plusieurs lots');
    ok(buildPlan([{ id: 0, artist: 'A', title: 'T', size: 999 }], false, 300).length === 1, 'fichier énorme seul dans son lot');
    ok(buildPlan([], false, 300).length === 0, 'plan vide');

    const dr = findDuplicates([
      { id: 0, artist: 'A', title: 'T', size: 50 },
      { id: 1, artist: 'a', title: 't', size: 90 },
      { id: 2, artist: 'A', title: 'Autre', size: 10 },
    ]);
    ok(dr.length === 1 && dr[0] === 0, 'doublon détecté, on garde le plus gros fichier');
  } else {
    console.log('  (fonctions de plan absentes — version originale)');
  }

  console.log(`\nunit: ${pass} OK, ${fail} ÉCHEC(S)`);
  process.exit(fail ? 1 : 0);
})();
