// === MARCAJ VERSIUNE: v2 — 2026-06-19 — dacă NU vezi acest comentariu pe GitHub.com, fișierul nu s-a actualizat ===
// Backup silențios — doar salvează în Firestore (colecția daily_backup), FĂRĂ email.
// Folosit pentru sloturile 07:00 și 14:00. Cel de 22:00 (backup.js) trimite și email.
const admin = require('firebase-admin');

console.log('=== backup-silent.js v2 pornit ===');
console.log('FIREBASE_SERVICE_ACCOUNT setat:', !!process.env.FIREBASE_SERVICE_ACCOUNT);
console.log('Lungime FIREBASE_SERVICE_ACCOUNT:', (process.env.FIREBASE_SERVICE_ACCOUNT||'').length);

if(!process.env.FIREBASE_SERVICE_ACCOUNT){
  console.error('❌ Secretul FIREBASE_SERVICE_ACCOUNT lipsește sau e gol.');
  console.error('   Verifică în repo: Settings → Secrets and variables → Actions → FIREBASE_SERVICE_ACCOUNT');
  console.error('   Trebuie să conțină JSON-ul complet al Service Account-ului din Firebase Console');
  console.error('   (Project Settings → Service Accounts → Generate new private key).');
  process.exit(1);
}
let serviceAccount;
try{
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  console.log('JSON parsat cu succes. project_id:', serviceAccount.project_id || '(lipsă)');
}catch(e){
  console.error('❌ FIREBASE_SERVICE_ACCOUNT nu este JSON valid:', e.message);
  console.error('   Asigură-te că ai copiat exact tot conținutul fișierului .json, fără modificări.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const YEAR = new Date().getFullYear();
const BASE_YEAR = 2026;
function collName(base){ return YEAR===BASE_YEAR ? base : `${base}_${YEAR}`; }

// Ora pentru care rulează acest backup (07 sau 14), primită ca argument CLI
const SLOT_HOUR = process.argv[2]; // ex: "7" sau "14"
if(!SLOT_HOUR){ console.error('❌ Lipsește ora slot-ului (argument CLI). Ex: node backup-silent.js 7'); process.exit(1); }

async function fetchAll(){
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10);
  const timeStr = now.toLocaleTimeString('ro-RO',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Bucharest'});
  console.log(`Silent backup ${dateStr} slot ${SLOT_HOUR} at ${timeStr}...`);

  const concSnap = await db.collection(collName('concedii')).get();
  const concedii = {};
  concSnap.forEach(doc=>{ concedii[doc.id]=doc.data(); });

  const seenNames=new Set(), allDrivers=[];
  const priority=['tania','raluca','madalina','corina'];
  priority.forEach(dk=>{
    if(!concedii[dk]) return;
    (concedii[dk].drivers||[]).forEach(d=>{
      if(!seenNames.has(d.name)){seenNames.add(d.name);allDrivers.push(d);}
    });
  });
  Object.entries(concedii).forEach(([dk,doc])=>{
    if(priority.includes(dk)) return;
    (doc.drivers||[]).forEach(d=>{
      if(!seenNames.has(d.name)){seenNames.add(d.name);allDrivers.push(d);}
    });
  });
  allDrivers.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ro'));
  console.log(`Unique drivers: ${allDrivers.length}`);

  if(allDrivers.length===0){
    console.warn('⚠️ Niciun șofer găsit — ABANDONEZ backup-ul ca să nu salvez date goale.');
    process.exit(0);
  }

  let sortatori=null;
  try{
    const s=await db.collection(collName('sortatori')).doc('state').get();
    if(s.exists){
      const d=s.data();
      const hasSortData=Array.isArray(d.drivers)?d.drivers.length>0:Object.values(d.drivers||{}).some(a=>a&&a.length>0);
      if(hasSortData) sortatori={drivers:d.drivers,presence:d.presence||{}};
    }
  }catch(e){console.warn('sortatori:',e.message);}

  let prezente=null;
  try{
    const p=await db.collection(collName('prezente')).doc('state').get();
    if(p.exists&&p.data().presence&&Object.keys(p.data().presence).length>0)
      prezente=p.data().presence;
  }catch(e){console.warn('prezente:',e.message);}

  let planificare=null;
  try{
    const pl=await db.collection(collName('planificare')).doc('ruhstorf').get();
    if(pl.exists && pl.data() && Object.keys(pl.data()).length>0) planificare=pl.data();
  }catch(e){console.warn('planificare:',e.message);}

  const driversObj={};
  allDrivers.forEach(d=>{ driversObj[d.id||d.name]=d; });

  return {
    version:4, year:YEAR,
    savedAt:now.toISOString(), date:dateStr, time:timeStr,
    slot:'sched'+SLOT_HOUR,
    savedBy:'github-actions-silent',
    driverCount:allDrivers.length,
    thresholds:concedii['tania']?.thresholds||{warn:3,crit:5},
    drivers:driversObj,
    ...(sortatori?{sortatori}:{}),
    ...(prezente?{prezente}:{}),
    ...(planificare?{planificare}:{})
  };
}

async function saveToFirestore(backup){
  const docId = `${backup.date}_sched${SLOT_HOUR}`;
  const existing = await db.collection(collName('daily_backup')).doc(docId).get();
  if(existing.exists){
    console.log(`ℹ️ Backup ${docId} există deja — nu suprascriu.`);
    return;
  }
  await db.collection(collName('daily_backup')).doc(docId).set(backup);
  console.log(`✅ Backup salvat: ${docId} (${backup.driverCount} persoane)`);
}

(async()=>{
  try{
    const backup = await fetchAll();
    if(backup) await saveToFirestore(backup);
    console.log('✅ Done (silent)');
    process.exit(0);
  }catch(e){
    console.error('❌',e.message);
    process.exit(1);
  }
})();
