// Migrare ONE-TIME: criptează backup-urile vechi (JSON în clar din repo-ul public: backups/history/*.json + backups/latest.json)
// și le scrie CRIPTATE (.enc) în repo-ul PRIVAT de backup (BACKUP_OUT_DIR/history). Nu șterge nimic din repo-ul public.
const fs = require('fs');
const path = require('path');
const { getKey, encrypt } = require('./backup-crypto');

const key = getKey();
if (!key) { console.error('❌ Lipsește BACKUP_ENCRYPTION_KEY (minim 24 de caractere).'); process.exit(1); }
const out = process.env.BACKUP_OUT_DIR;
if (!out) { console.error('❌ Lipsește BACKUP_OUT_DIR (folderul repo-ului PRIVAT).'); process.exit(1); }
const srcDir = path.join(__dirname, '..', 'backups');
const histOut = path.join(out, 'history');
fs.mkdirSync(histOut, { recursive: true });

const files = [];
const hist = path.join(srcDir, 'history');
if (fs.existsSync(hist)) fs.readdirSync(hist).filter(f => f.endsWith('.json')).forEach(f => files.push([path.join(hist, f), f.replace(/\.json$/, '')]));
const latest = path.join(srcDir, 'latest.json');
if (fs.existsSync(latest)) files.push([latest, 'latest-vechi-' + new Date().toISOString().slice(0, 10)]);

let ok = 0, skip = 0, bad = 0;
for (const [file, name] of files) {
  const dest = path.join(histOut, name + '.enc');
  if (fs.existsSync(dest)) { skip++; continue; }
  try {
    const txt = fs.readFileSync(file, 'utf8');
    JSON.parse(txt); // verificăm că e JSON valid înainte de criptare
    fs.writeFileSync(dest, encrypt(txt, key));
    ok++;
  } catch (e) { bad++; console.warn('⚠️ sărit', file, e.message); }
}
console.log(`✅ Gata: ${ok} criptate, ${skip} existau deja, ${bad} cu probleme (din ${files.length} fișiere).`);
if (!files.length) { console.error('❌ Nu am găsit niciun backup în backups/ — nimic de migrat.'); process.exit(1); }
