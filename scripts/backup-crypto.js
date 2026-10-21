// Criptare backup — AES-256-GCM (+ compresie). Datele NU se scriu niciodată necriptate pe disc/în git.
// Cheia vine din secretul GitHub BACKUP_ENCRYPTION_KEY (minim 24 de caractere).
// Același format ca la backup-ul Reclamații (alg AES-256-GCM, nonce deterministic).
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function getKey(){
  const k = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (k.length < 24) return null;
  return crypto.createHash('sha256').update('mtc-backup-v1|' + k, 'utf8').digest();
}

function encrypt(plain, key){
  const data = zlib.deflateSync(Buffer.from(plain, 'utf8'), { level: 9 });
  const nonce = crypto.createHmac('sha256', crypto.createHash('sha256').update(Buffer.concat([key, Buffer.from('nonce')])).digest())
    .update(data).digest().subarray(0, 12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from('mtc-backup-v1'));
  const ct = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, alg: 'AES-256-GCM', z: 1, n: nonce.toString('base64'), c: ct.toString('base64') }) + '\n';
}

function decrypt(text, key){
  const o = JSON.parse(text);
  const raw = Buffer.from(o.c, 'base64');
  const tag = raw.subarray(raw.length - 16), ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.n, 'base64'));
  d.setAAD(Buffer.from('mtc-backup-v1'));
  d.setAuthTag(tag);
  const data = Buffer.concat([d.update(ct), d.final()]);
  return (o.z ? zlib.inflateSync(data) : data).toString('utf8');
}

// Scrie backup-ul criptat în repo-ul PRIVAT de backup (BACKUP_OUT_DIR). Fără cheie sau fără folder → eroare, nu se scrie nimic.
function writeEncryptedBackup(backup, histName){
  const key = getKey();
  if (!key) throw new Error('Lipsește secretul BACKUP_ENCRYPTION_KEY (minim 24 de caractere). Backup-ul nu se salvează niciodată necriptat.');
  const out = process.env.BACKUP_OUT_DIR;
  if (!out) throw new Error('Lipsește BACKUP_OUT_DIR (folderul repo-ului PRIVAT de backup). Nu scriu backup în repo-ul public.');
  const histDir = path.join(out, 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const enc = encrypt(JSON.stringify(backup), key);
  fs.writeFileSync(path.join(out, 'latest.enc'), enc);
  fs.writeFileSync(path.join(histDir, histName + '.enc'), enc);
  // manifest: DOAR data și numere, fără nume/date personale
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
    savedAt: backup.savedAt, date: backup.date, time: backup.time,
    persoane: backup.driverCount, encrypted: 'AES-256-GCM', latest: 'latest.enc'
  }, null, 2));
  console.log(`✅ Backup CRIPTAT scris: latest.enc + history/${histName}.enc (${(enc.length/1024).toFixed(0)} KB)`);
}

module.exports = { getKey, encrypt, decrypt, writeEncryptedBackup };
