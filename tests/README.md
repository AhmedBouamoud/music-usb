# Tests — منظم أغاني السيارة

Tests automatiques de l'application (`index.html`). Prérequis : Node ≥ 20, Playwright + Chromium, `unzip`.

```bash
node gen-mp3.js        # génère les MP3 de test (ID3v2.2/2.3/2.4, ID3v1 windows-1256, sans tags…)
node unit.js           # tests unitaires : tags, translittération, plan de nommage, découpage, doublons
node e2e.js            # test navigateur complet : sélection → ZIP → structure MUSIC/Artiste/Titre.mp3
```

`unit.js` et `e2e.js` lisent l'application depuis `../index.html` par défaut (variable `APP_HTML` pour changer).
`e2e.js` fournit JSZip localement (extrait de `npm pack jszip@3.10.1`) car il tourne hors ligne — chemin dans la constante `JSZIP`.
