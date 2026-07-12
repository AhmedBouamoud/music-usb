// Génère 200 MP3 (~0.5MB chacun) répartis sur 12 artistes
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2];

const frame = Buffer.alloc(417, 0x55);
frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = 0x90; frame[3] = 0x00;
const body = Buffer.concat(Array(1200).fill(frame)); // ~0.5 MB

const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const u32 = n => Buffer.from([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
function tag(artist, title) {
  const f = (id, text) => {
    const p = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from(id, 'ascii'), u32(p.length), Buffer.from([0, 0]), p]);
  };
  const b = Buffer.concat([f('TPE1', artist), f('TIT2', title)]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(b.length), b]);
}

const artists = ['ناس الغيوان', 'جيل جيلالة', 'لمشاهب', 'محمد رويشة', 'الحسين السلاوي', 'عبد الوهاب الدكالي',
  'سعيد الصنهاجي', 'الستاتي', 'دون بيغ', 'سعد لمجرد', 'فرقة تكادة', 'حمزة نمرة'];
for (let i = 0; i < 200; i++) {
  const a = artists[i % artists.length];
  fs.writeFileSync(path.join(OUT, 'song' + String(i).padStart(3, '0') + '.mp3'),
    Buffer.concat([tag(a, 'أغنية رقم ' + (i + 1)), body]));
}
console.log('200 fichiers OK');
