// Générateur de fichiers MP3 de test avec différents tags ID3
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// --- encodage windows-1256 (table partielle suffisante pour nos textes) ---
const CP1256 = {};
{
  // lettres arabes principales
  const map = {
    'ء':0xC1,'آ':0xC2,'أ':0xC3,'ؤ':0xC4,'إ':0xC5,'ئ':0xC6,'ا':0xC7,'ب':0xC8,'ة':0xC9,'ت':0xCA,
    'ث':0xCB,'ج':0xCC,'ح':0xCD,'خ':0xCE,'د':0xCF,'ذ':0xD0,'ر':0xD1,'ز':0xD2,'س':0xD3,'ش':0xD4,
    'ص':0xD5,'ض':0xD6,'ط':0xD8,'ظ':0xD9,'ع':0xDA,'غ':0xDB,'ف':0xDD,'ق':0xDE,'ك':0xDF,'ل':0xE1,
    'م':0xE3,'ن':0xE4,'ه':0xE5,'و':0xE6,'ى':0xEC,'ي':0xED,' ':0x20
  };
  Object.assign(CP1256, map);
}
function encCP1256(s) {
  return Buffer.from([...s].map(ch => {
    if (CP1256[ch] !== undefined) return CP1256[ch];
    const c = ch.codePointAt(0);
    if (c < 0x80) return c;
    throw new Error('char non mappé cp1256: ' + ch);
  }));
}

// --- petit corps MPEG valide (frame header MPEG1 Layer3 128kbps 44100Hz) ---
function audioBody(sizeKB = 30) {
  const frame = Buffer.alloc(417, 0x55);
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = 0x90; frame[3] = 0x00;
  const n = Math.ceil(sizeKB * 1024 / 417);
  return Buffer.concat(Array(n).fill(frame));
}

// --- ID3v2 helpers ---
const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const u32 = n => Buffer.from([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const u24 = n => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

function frame23(id, payload) { // aussi valable pour 2.4 si size syncsafe
  return Buffer.concat([Buffer.from(id, 'ascii'), u32(payload.length), Buffer.from([0, 0]), payload]);
}
function frame24(id, payload) {
  return Buffer.concat([Buffer.from(id, 'ascii'), syncsafe(payload.length), Buffer.from([0, 0]), payload]);
}
function frame22(id, payload) {
  return Buffer.concat([Buffer.from(id, 'ascii'), u24(payload.length), payload]);
}
function id3v2(ver, frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, 0]), syncsafe(body.length), body]);
}
function textPayload(enc, text) {
  if (enc === 0) return Buffer.concat([Buffer.from([0]), encCP1256(text)]); // "latin-1" mais en réalité cp1256 (cas Maroc)
  if (enc === 1) { // utf-16 LE + BOM
    return Buffer.concat([Buffer.from([1, 0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  }
  if (enc === 3) return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  throw new Error('enc?');
}
function id3v1(artist, title) {
  const b = Buffer.alloc(128, 0);
  b.write('TAG', 0, 'ascii');
  encCP1256(title).copy(b, 3);
  encCP1256(artist).copy(b, 33);
  b[127] = 12; // genre
  return b;
}

// ---------- fixtures ----------
const F = [];
function make(name, buf, expect) {
  fs.writeFileSync(path.join(OUT, name), buf);
  F.push({ name, expect });
}

// 1) ID3v2.3, enc=0 avec octets cp1256 (cas réel Maroc)
make('v23_cp1256.mp3', Buffer.concat([
  id3v2(3, [frame23('TPE1', textPayload(0, 'ناس الغيوان')), frame23('TIT2', textPayload(0, 'الصينية'))]),
  audioBody()
]), { artist: 'ناس الغيوان', title: 'الصينية' });

// 2) ID3v2.3, enc=1 UTF-16LE
make('v23_utf16.mp3', Buffer.concat([
  id3v2(3, [frame23('TPE1', textPayload(1, 'سعيد الصنهاجي')), frame23('TIT2', textPayload(1, 'شحال بكيت'))]),
  audioBody()
]), { artist: 'سعيد الصنهاجي', title: 'شحال بكيت' });

// 3) ID3v2.4, tailles syncsafe, enc=3 UTF-8
make('v24_utf8.mp3', Buffer.concat([
  id3v2(4, [frame24('TPE1', textPayload(3, 'عبد الهادي بلخياط')), frame24('TIT2', textPayload(3, 'القمر الأحمر'))]),
  audioBody()
]), { artist: 'عبد الهادي بلخياط', title: 'القمر الأحمر' });

// 4) ID3v2.2, frames TP1/TT2
make('v22_utf16.mp3', Buffer.concat([
  id3v2(2, [frame22('TP1', textPayload(1, 'الحاجة الحمداوية')), frame22('TT2', textPayload(1, 'هزّي كاسك'))]),
  audioBody()
]), { artist: 'الحاجة الحمداوية', title: 'هزّي كاسك' });

// 5) ID3v1 seul, cp1256
make('v1_cp1256.mp3', Buffer.concat([
  audioBody(), id3v1('محمد رويشة', 'إناس إناس')
]), { artist: 'محمد رويشة', title: 'إناس إناس' });

// 6) sans tags, nom de fichier "Artiste - Titre.mp3" (arabe)
make('فنان مجهول - أغنية جميلة.mp3', audioBody(), { artist: 'فنان مجهول', title: 'أغنية جميلة' });

// 7) sans tags, sans motif → titre = nom du fichier
make('Track99.mp3', audioBody(), { artist: '', title: 'Track99' });

// 8) v2.3 avec tag artiste vide → fallback nom de fichier
make('Cheb Hasni - Matebkiche.mp3', Buffer.concat([
  id3v2(3, [frame23('TIT2', textPayload(3, ''))]),
  audioBody()
]), { artist: 'Cheb Hasni', title: 'Matebkiche' });

// 9) titre très long (>60 après translit)
make('v23_long.mp3', Buffer.concat([
  id3v2(3, [frame23('TPE1', textPayload(1, 'فرقة ذات اسم طويل جدا جدا جدا جدا جدا للاختبار')),
            frame23('TIT2', textPayload(1, 'عنوان طويل للغاية يتجاوز الستين حرفا بعد التحويل الى الحروف اللاتينية بكل تأكيد نعم'))]),
  audioBody()
]), { longNames: true });

// 10) non-MP3 (doit être exclu)
make('photo.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]), { excluded: true });

// duplicatas: même artiste+titre que (1), autre nom de fichier
make('v23_cp1256_copy.mp3', Buffer.concat([
  id3v2(3, [frame23('TPE1', textPayload(0, 'ناس الغيوان')), frame23('TIT2', textPayload(0, 'الصينية'))]),
  audioBody(31)
]), { dupOf: 'v23_cp1256.mp3' });

fs.writeFileSync(path.join(OUT, '_expect.json'), JSON.stringify(F, null, 2));
console.log('fixtures OK →', OUT, '(' + F.length + ' fichiers)');
