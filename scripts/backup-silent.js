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
const EXPECTED_PROJECT_ID = 'calendar-f2589'; // proiectul de PRODUCȚIE — NU concedii-test
if(serviceAccount.project_id !== EXPECTED_PROJECT_ID){
  console.error(`❌ STOP — proiectul Firebase folosit ("${serviceAccount.project_id}") NU este cel de producție ("${EXPECTED_PROJECT_ID}"). Backup-ul ar conține date greșite (posibil din concedii-test). Verifică secretul FIREBASE_SERVICE_ACCOUNT din GitHub → Settings → Secrets and variables → Actions.`);
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

  // Mapăm explicit fiecare câmp relevant — garantăm că startDate/endDate
  // (data angajare/plecare) sunt mereu prezente în backup, chiar și null.
  const allDriversFull = allDrivers.map(d=>({
    id: d.id || null,
    name: d.name || '',
    visibleTo: d.visibleTo || [],
    maxDays: d.maxDays || 0,
    carryOverDays: d.carryOverDays || 0,
    carryOverByYear: d.carryOverByYear || {},
    startDate: d.startDate || null,
    endDate: d.endDate || null,
    archived: d.archived || false,
    archivedAt: d.archivedAt || null,
    group: d.group || null,
    angajatiId: d.angajatiId || null,
    autoSync: d.autoSync || false,
    leaves: d.leaves || [],
    krankLeaves: d.krankLeaves || [],
    unpaidLeaves: d.unpaidLeaves || [],
    specialLeaves: d.specialLeaves || []
  }));
  const withContract = allDriversFull.filter(d=>d.startDate||d.endDate).length;
  console.log(`Persoane cu dată angajare/plecare setată: ${withContract}`);

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

  let salarii=null;
  try{
    const sl=await withRetry(()=>db.collection('salarii').get(),'salarii');
    if(sl && !sl.empty){ salarii={}; sl.forEach(d=>{ salarii[d.id]=d.data(); }); }
  }catch(e){console.warn('salarii:',e.message);}
  let libere=null;
  try{
    const lb=await db.collection('libere').doc('state').get();
    if(lb.exists && lb.data() && lb.data().persons && Object.keys(lb.data().persons).length>0){
      libere = {persons: lb.data().persons, days: lb.data().days||{}};
    }
  }catch(e){console.warn('libere:',e.message);}

  // Coduri PIN (login) — critice, fără ele niciun user non-admin nu se poate loga
  let pins=null;
  try{
    const pinKeys=['raluca','madalina','corina','mihaela','tania'];
    const pinSnaps=await Promise.all(pinKeys.map(pk=>db.collection('pins').doc(pk).get()));
    const pinsObj={};
    pinKeys.forEach((pk,i)=>{ if(pinSnaps[i].exists) pinsObj[pk]=pinSnaps[i].data(); });
    if(Object.keys(pinsObj).length>0) pins=pinsObj;
  }catch(e){console.warn('pins:',e.message);}

  // Permisiuni acordate (panoul de Permisiuni) — fără ele, tot accesul non-admin dispare
  let permissions=null;
  try{
    const permSnap=await db.collection('permissions').doc('overrides').get();
    if(permSnap.exists && permSnap.data()) permissions=permSnap.data();
  }catch(e){console.warn('permissions:',e.message);}

  // Status import Excel — un document per lună, toate incluse
  let excelImportStatus=null;
  try{
    const excelSnap=await db.collection('excel_import_status').get();
    const excelObj={};
    excelSnap.forEach(doc=>{ excelObj[doc.id]=doc.data(); });
    if(Object.keys(excelObj).length>0) excelImportStatus=excelObj;
  }catch(e){console.warn('excelImportStatus:',e.message);}

  // Legături manuale de nume (comparație backup-uri)
  let backupDiffSettings=null;
  try{
    const bdSnap=await db.collection('backup_diff_settings').doc('manual_name_links').get();
    if(bdSnap.exists && bdSnap.data()) backupDiffSettings=bdSnap.data();
  }catch(e){console.warn('backupDiffSettings:',e.message);}

  // Avertizări persistente Planificare
  let planificareWarnings=null;
  try{
    const pwSnap=await db.collection('planificare_warnings').doc('list').get();
    if(pwSnap.exists && pwSnap.data()) planificareWarnings=pwSnap.data();
  }catch(e){console.warn('planificareWarnings:',e.message);}

  // Remindere pe zile de calendar
  let calendarReminders=null;
  try{
    const crSnap=await db.collection('calendar_reminders').doc('list').get();
    if(crSnap.exists && crSnap.data()) calendarReminders=crSnap.data();
  }catch(e){console.warn('calendarReminders:',e.message);}

  const driversObj={};
  allDriversFull.forEach(d=>{ driversObj[d.id||d.name]=d; });

  return {
    version:5, year:YEAR,
    savedAt:now.toISOString(), date:dateStr, time:timeStr,
    slot:'sched'+SLOT_HOUR,
    savedBy:'github-actions-silent',
    driverCount:allDriversFull.length,
    thresholds:concedii['tania']?.thresholds||{warn:3,crit:5},
    drivers:driversObj,
    ...(sortatori?{sortatori}:{}),
    ...(prezente?{prezente}:{}),
    ...(planificare?{planificare}:{}),
    ...(libere?{libere}:{}),
    ...(salarii?{salarii}:{}),
    ...(pins?{pins}:{}),
    ...(permissions?{permissions}:{}),
    ...(excelImportStatus?{excelImportStatus}:{}),
    ...(backupDiffSettings?{backupDiffSettings}:{}),
    ...(planificareWarnings?{planificareWarnings}:{}),
    ...(calendarReminders?{calendarReminders}:{})
  };
}

async function saveToFirestore(backup){
  const docId = `${backup.date}_sched${SLOT_HOUR}`;
  const existing = await db.collection(collName('daily_backup')).doc(docId).get();
  if(existing.exists){
    console.log(`ℹ️ Backup ${docId} există deja — nu suprascriu.`);
    return;
  }

  // Alertă preventivă: scădere bruscă a numărului de persoane față de
  // ultimul backup salvat — poate fi o ștergere accidentală.
  try{
    const prevSnap = await db.collection(collName('daily_backup')).orderBy('savedAt','desc').limit(1).get();
    if(!prevSnap.empty){
      const prevCount = prevSnap.docs[0].data().driverCount||0;
      const drop = prevCount - backup.driverCount;
      if(drop>=5){
        console.warn(`⚠️⚠️⚠️ ATENȚIE: numărul de persoane a scăzut cu ${drop} (de la ${prevCount} la ${backup.driverCount}) față de ultimul backup! Verifică dacă e intenționat.`);
      }
    }
  }catch(e){ console.warn('drop-check err', e.message); }

  await db.collection(collName('daily_backup')).doc(docId).set(backup);
  console.log(`✅ Backup salvat: ${docId} (${backup.driverCount} persoane)`);
}

// Salvăm backup-ul și ca fișier LOCAL, complet separat de Firestore. Un pas
// ulterior din workflow-ul GitHub Actions va face commit la aceste fișiere
// direct în repository — infrastructură total independentă de Firebase.
// Dacă Firebase ar dispărea complet, istoricul complet din git rămâne intact.
function saveToRepoFiles(backup){
  // Criptat (AES-256) și scris DOAR în repo-ul privat de backup — niciodată text clar în repo-ul public.
  require('./backup-crypto').writeEncryptedBackup(backup, `${backup.date}_${backup.slot||('sched'+SLOT_HOUR)}`);
}


// Reîncercare cu pauză la erori trecătoare / de cotă Firestore (RESOURCE_EXHAUSTED).
// Notă: dacă e epuizată COTA ZILNICĂ (50.000 citiri / 20.000 scrieri pe planul gratuit),
// reîncercările nu ajută până la resetare (miezul nopții ora Pacificului ≈ 10:00 ora României).
async function withRetry(fn,label){
  const delays=[20000,60000,120000];
  for(let i=0;;i++){
    try{ return await fn(); }
    catch(e){
      const msg=String(e&&e.message||e);
      const quota=/RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg)||(e&&e.code===8);
      const transient=quota||/UNAVAILABLE|DEADLINE_EXCEEDED|ABORTED/i.test(msg);
      if(!transient||i>=delays.length){
        if(quota) console.error('❌ Cota Firestore epuizată. Verifică Firebase Console → Firestore → Usage (citiri/scrieri azi). Se resetează la miezul nopții ora Pacificului (~10:00 ora României).');
        throw e;
      }
      console.warn(`⚠️ ${label}: ${msg} — reîncerc în ${delays[i]/1000}s (încercarea ${i+2}/${delays.length+1})`);
      await new Promise(r=>setTimeout(r,delays[i]));
    }
  }
}

(async()=>{
  try{
    const backup = await withRetry(fetchAll,'citire Firestore');
    if(backup){
      await withRetry(()=>saveToFirestore(backup),'salvare Firestore');
      saveToRepoFiles(backup);
    }
    console.log('✅ Done (silent)');
    process.exit(0);
  }catch(e){
    console.error('❌',e.message);
    process.exit(1);
  }
})();
