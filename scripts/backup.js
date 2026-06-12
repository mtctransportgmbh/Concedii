const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const YEAR = new Date().getFullYear();
const BASE_YEAR = 2026;
function collName(base){ return YEAR===BASE_YEAR ? base : `${base}_${YEAR}`; }

async function fetchAll(){
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10);
  const timeStr = now.toLocaleTimeString('ro-RO',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Bucharest'});
  console.log(`Backup ${dateStr} at ${timeStr}...`);

  const concSnap = await db.collection(collName('concedii')).get();
  const concedii = {};
  concSnap.forEach(doc=>{ concedii[doc.id]=doc.data(); });

  // Deduplicare după NUME — tania are lista completă
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

  const sortCount=sortatori?(Array.isArray(sortatori.drivers)?sortatori.drivers.length:Object.values(sortatori.drivers||{}).reduce((s,a)=>s+(a||[]).length,0)):0;
  const prezCount=Object.keys(prezente||{}).length;
  console.log(`Sortatori: ${sortCount}, Prezente luni: ${prezCount}`);

  return {version:3,year:YEAR,savedAt:now.toISOString(),date:dateStr,time:timeStr,savedBy:'github-actions',driverCount:allDrivers.length,thresholds:concedii['tania']?.thresholds||{warn:3,crit:5},drivers:allDrivers,prezente:prezente||{},sortatori,_raw_concedii:concedii};
}

async function sendEmail(backup){
  const json=JSON.stringify(backup,null,2);
  const filename=`mtc-backup-${backup.date}-22h.json`;
  console.log(`JSON: ${(json.length/1024).toFixed(1)} KB`);
  const t=nodemailer.createTransport({host:'smtp.mail.yahoo.com',port:465,secure:true,auth:{user:process.env.EMAIL_USER,pass:process.env.EMAIL_PASS}});
  await t.verify();
  const sortCount=backup.sortatori?(Array.isArray(backup.sortatori.drivers)?backup.sortatori.drivers.length:Object.values(backup.sortatori.drivers||{}).reduce((s,a)=>s+(a||[]).length,0)):0;
  const prezCount=Object.keys(backup.prezente||{}).length;
  await t.sendMail({
    from:`"MTC Backup" <${process.env.EMAIL_USER}>`,to:process.env.EMAIL_TO,
    subject:`✅ Backup MTC Transport — ${backup.date} ora 22:00`,
    html:`<div style="font-family:Arial"><h2>📦 Backup zilnic MTC Transport</h2><p>${backup.date} ora 22:00</p><table><tr><td>👥 Persoane</td><td>${backup.driverCount}</td></tr><tr><td>📅 Luni prezențe</td><td>${prezCount}</td></tr><tr><td>📦 Sortatori</td><td>${sortCount}</td></tr><tr><td>💾 Mărime</td><td>${(json.length/1024).toFixed(1)} KB</td></tr></table><p>JSON atașat.</p></div>`,
    attachments:[{filename,content:json,contentType:'application/json'}]
  });
  console.log(`✅ Email sent`);
}

(async()=>{try{const b=await fetchAll();await sendEmail(b);console.log('✅ Done');process.exit(0);}catch(e){console.error('❌',e.message);process.exit(1);}})();
