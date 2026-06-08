const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const fs = require('fs');

// ── Firebase init ──
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

  const concediiSnap = await db.collection(collName('concedii')).get();
  const concedii = {};
  concediiSnap.forEach(doc=>{ concedii[doc.id]=doc.data(); });

  let sortatori=null, prezente=null;
  try{ const s=await db.collection(collName('sortatori')).doc('state').get(); if(s.exists)sortatori=s.data(); }catch(e){ console.warn('sortatori:',e.message); }
  try{ const p=await db.collection(collName('prezente')).doc('state').get(); if(p.exists)prezente=p.data(); }catch(e){ console.warn('prezente:',e.message); }

  const seen=new Set(), allDrivers=[];
  Object.values(concedii).forEach(doc=>(doc.drivers||[]).forEach(d=>{if(!seen.has(d.id)){seen.add(d.id);allDrivers.push(d);}}));

  const backup = {
    version:3, year:YEAR, savedAt:now.toISOString(), date:dateStr, time:timeStr,
    savedBy:'github-actions', driverCount:allDrivers.length,
    thresholds:concedii['tania']?.thresholds||{warn:3,crit:5},
    drivers:allDrivers,
    prezente:prezente?.presence||{},
    sortatori:sortatori?{drivers:sortatori.drivers||[],presence:sortatori.presence||{}}:null,
    _raw_concedii:concedii
  };
  console.log(`Fetched: ${allDrivers.length} drivers`);
  return backup;
}

async function sendEmail(backup){
  const json = JSON.stringify(backup, null, 2);
  const filename = `mtc-backup-${backup.date}.json`;
  console.log(`JSON size: ${(json.length/1024).toFixed(1)} KB`);
  console.log(`Connecting to Yahoo SMTP...`);

  const transporter = nodemailer.createTransport({
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    debug: true,
    logger: true
  });

  await transporter.verify();
  console.log('SMTP connection verified OK');

  await transporter.sendMail({
    from: `"MTC Backup" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `✅ Backup MTC Transport — ${backup.date}`,
    html: `<div style="font-family:Arial,sans-serif">
      <h2>📦 Backup zilnic MTC Transport</h2>
      <p>Data: <strong>${backup.date}</strong> ora <strong>${backup.time}</strong></p>
      <p>👥 Persoane: ${backup.driverCount} | 📅 Luni prezențe: ${Object.keys(backup.prezente).length} | 📦 Sortatori: ${backup.sortatori?.drivers?.length||0}</p>
      <p>Fișierul JSON este atașat.</p>
    </div>`,
    attachments: [{ filename, content: json, contentType: 'application/json' }]
  });
  console.log(`✅ Email sent to ${process.env.EMAIL_TO}`);
}

(async()=>{
  try{
    const backup = await fetchAll();
    await sendEmail(backup);
    console.log('✅ Done!');
    process.exit(0);
  }catch(err){
    console.error('❌ Failed:', err.message);
    if(err.response) console.error('SMTP response:', err.response);
    process.exit(1);
  }
})();
