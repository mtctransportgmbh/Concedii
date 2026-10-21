// Decriptare: BACKUP_ENCRYPTION_KEY="cheia ta" node scripts/decrypt-backup.js backup/latest.enc > backup.json
const fs = require('fs');
const { getKey, decrypt } = require('./backup-crypto');
const key = getKey();
if (!key) { console.error('Setează BACKUP_ENCRYPTION_KEY (cheia de la backup).'); process.exit(1); }
const f = process.argv[2];
if (!f) { console.error('Folosire: node decrypt-backup.js <fisier.enc> > iesire.json'); process.exit(1); }
process.stdout.write(decrypt(fs.readFileSync(f, 'utf8'), key));
