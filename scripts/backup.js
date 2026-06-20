const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const YEAR = new Date().getFullYear();
const BASE_YEAR = 2026;
function collName(base){ return YEAR===BASE_YEAR ? base : `${base}_${YEAR}`; }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

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

  // Mapăm explicit fiecare câmp relevant — garantăm că startDate/endDate
  // (data angajare/plecare) sunt mereu prezente în backup, chiar și null,
  // indiferent de ce conține documentul sursă din Firestore.
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
    leaves: d.leaves || [],
    krankLeaves: d.krankLeaves || [],
    unpaidLeaves: d.unpaidLeaves || []
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

  const sortCount=sortatori?(Array.isArray(sortatori.drivers)?sortatori.drivers.length:Object.values(sortatori.drivers||{}).reduce((s,a)=>s+(a||[]).length,0)):0;
  const prezCount=Object.keys(prezente||{}).length;
  const planCount=Object.keys(planificare||{}).length;
  console.log(`Sortatori: ${sortCount}, Prezente luni: ${prezCount}, Planificare saptamani: ${planCount}`);

  return {version:4,year:YEAR,savedAt:now.toISOString(),date:dateStr,time:timeStr,savedBy:'github-actions',driverCount:allDriversFull.length,thresholds:concedii['tania']?.thresholds||{warn:3,crit:5},drivers:allDriversFull,prezente:prezente||{},sortatori,planificare,_raw_concedii:concedii};
}

// ── Ultimul backup salvat (din app, la 06/14/22 sau la modificari) ──
async function fetchLatestSavedBackup(){
  try{
    const snap=await db.collection(collName('daily_backup')).orderBy('savedAt','desc').limit(1).get();
    if(snap.empty) return null;
    return {id:snap.docs[0].id, ...snap.docs[0].data()};
  }catch(e){ console.warn('latest backup fetch:',e.message); return null; }
}

// ── Comparatie ultimul backup salvat vs LIVE (acum) ──
function computeDiff(prev, live){
  if(!prev) return {isFirst:true};
  const periodKey = l => (l.start||'')+'→'+(l.end||'');

  const prevDriversArr = Array.isArray(prev.drivers) ? prev.drivers : Object.values(prev.drivers||{});
  const prevByName = {}; prevDriversArr.forEach(d=>{ if(d&&d.name) prevByName[d.name]=d; });
  const liveByName = {}; (live.drivers||[]).forEach(d=>{ liveByName[d.name]=d; });

  const newDrivers=[], removedDrivers=[], leaveChanges=[], otherChanges=[];
  const cy=String(live.year||YEAR);

  Object.keys(liveByName).forEach(name=>{
    if(!prevByName[name]){ newDrivers.push(name); return; }
    const lv=liveByName[name], bk=prevByName[name];
    ['leaves','krankLeaves','unpaidLeaves'].forEach(field=>{
      const label = field==='leaves'?'Concediu':field==='krankLeaves'?'Krank':'Fără plată';
      const liveArr=lv[field]||[], bdArr=bk[field]||[];
      const liveSet=new Set(liveArr.map(periodKey)), bdSet=new Set(bdArr.map(periodKey));
      liveArr.forEach(l=>{ if(!bdSet.has(periodKey(l))) leaveChanges.push({type:'add',label,name,period:l}); });
      bdArr.forEach(l=>{ if(!liveSet.has(periodKey(l))) leaveChanges.push({type:'remove',label,name,period:l}); });
    });
    const lvCarry=(lv.carryOverByYear&&lv.carryOverByYear[cy]!==undefined)?lv.carryOverByYear[cy]:(lv.carryOverDays||0);
    const bkCarry=(bk.carryOverByYear&&bk.carryOverByYear[cy]!==undefined)?bk.carryOverByYear[cy]:(bk.carryOverDays||0);
    if((lv.maxDays||0)!==(bk.maxDays||0)) otherChanges.push(`${esc(name)}: zile disponibile/an ${bk.maxDays||0} → ${lv.maxDays||0}`);
    if(lvCarry!==bkCarry) otherChanges.push(`${esc(name)}: zile reportate ${bkCarry} → ${lvCarry}`);
    if((lv.startDate||null)!==(bk.startDate||null)) otherChanges.push(`${esc(name)}: data angajare ${bk.startDate||'—'} → ${lv.startDate||'—'}`);
    if((lv.endDate||null)!==(bk.endDate||null)) otherChanges.push(`${esc(name)}: data plecare ${bk.endDate||'—'} → ${lv.endDate||'—'}`);
    if(!!lv.archived!==!!bk.archived) otherChanges.push(`${esc(name)}: ${lv.archived?'arhivat':'restaurat din arhivă'}`);
  });
  Object.keys(prevByName).forEach(name=>{ if(!liveByName[name]) removedDrivers.push(name); });

  // Prezente
  const prevPrez=prev.prezente||{}, livePrez=live.prezente||{};
  let prezDiff=0;
  new Set([...Object.keys(prevPrez),...Object.keys(livePrez)]).forEach(mk=>{
    const bm=prevPrez[mk]||{}, lm=livePrez[mk]||{};
    new Set([...Object.keys(bm),...Object.keys(lm)]).forEach(name=>{
      const bdays=bm[name]||{}, ldays=lm[name]||{};
      new Set([...Object.keys(bdays),...Object.keys(ldays)]).forEach(day=>{
        if((bdays[day]||null)!==(ldays[day]||null)) prezDiff++;
      });
    });
  });

  // Sortatori — persoane per luna
  const normSort=obj=>{
    const out={};
    if(!obj) return out;
    if(Array.isArray(obj)){ out['toate']=obj.map(d=>d.name).sort(); return out; }
    Object.entries(obj).forEach(([mk,arr])=>{ out[mk]=(arr||[]).map(d=>d.name).sort(); });
    return out;
  };
  const prevSort=normSort(prev.sortatori&&prev.sortatori.drivers);
  const liveSort=normSort(live.sortatori&&live.sortatori.drivers);
  const sortChanges=[];
  new Set([...Object.keys(prevSort),...Object.keys(liveSort)]).forEach(mk=>{
    const bset=new Set(prevSort[mk]||[]), lset=new Set(liveSort[mk]||[]);
    const added=[...lset].filter(n=>!bset.has(n));
    const removed=[...bset].filter(n=>!lset.has(n));
    if(added.length) sortChanges.push(`<b>${esc(mk)}</b>: + ${added.map(esc).join(', ')}`);
    if(removed.length) sortChanges.push(`<b>${esc(mk)}</b>: − ${removed.map(esc).join(', ')}`);
  });

  // Sortatori — prezente
  const prevSortPres=(prev.sortatori&&prev.sortatori.presence)||{};
  const liveSortPres=(live.sortatori&&live.sortatori.presence)||{};
  let sortPresDiff=0;
  new Set([...Object.keys(prevSortPres),...Object.keys(liveSortPres)]).forEach(mk=>{
    const bm=prevSortPres[mk]||{}, lm=liveSortPres[mk]||{};
    new Set([...Object.keys(bm),...Object.keys(lm)]).forEach(name=>{
      const bdays=bm[name]||{}, ldays=lm[name]||{};
      new Set([...Object.keys(bdays),...Object.keys(ldays)]).forEach(day=>{
        if((bdays[day]||null)!==(ldays[day]||null)) sortPresDiff++;
      });
    });
  });

  // Planificare
  const prevPlan=prev.planificare||{}, livePlan=live.planificare||{};
  let planDiff=0;
  new Set([...Object.keys(prevPlan),...Object.keys(livePlan)]).forEach(wk=>{
    const bw=prevPlan[wk]||{}, lw=livePlan[wk]||{};
    new Set([...Object.keys(bw),...Object.keys(lw)]).forEach(name=>{
      const ba=bw[name]||[0,0,0,0,0,0,0], la=lw[name]||[0,0,0,0,0,0,0];
      for(let i=0;i<7;i++) if((ba[i]||0)!==(la[i]||0)) planDiff++;
    });
  });

  const total=newDrivers.length+removedDrivers.length+leaveChanges.length+otherChanges.length+prezDiff+sortChanges.length+sortPresDiff+planDiff;
  return {isFirst:false,newDrivers,removedDrivers,leaveChanges,otherChanges,prezDiff,sortChanges,sortPresDiff,planDiff,total,
    prevDate:prev.date||(prev.savedAt?prev.savedAt.slice(0,10):'?'), prevTime:prev.time||(prev.savedAt?prev.savedAt.slice(11,16):'?')};
}

function diffSection(title, items){
  if(!items||!items.length) return '';
  return `<div style="margin-bottom:8px"><div style="font-size:12px;font-weight:700;color:#666;margin-bottom:3px">${title}</div><div style="background:#f5f5f5;border-radius:6px;padding:6px 10px;font-size:12px;line-height:1.7">${items.join('<br>')}</div></div>`;
}

function renderDiffHtml(diff){
  if(diff.isFirst) return '<p style="color:#888;font-size:13px">ℹ️ Acesta este primul backup salvat — nu există o versiune anterioară pentru comparație.</p>';

  if(diff.total===0){
    return `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px;text-align:center;margin-bottom:4px">
      <div style="font-size:30px">✅</div>
      <div style="font-weight:700;color:#2e7d32;font-size:14px">Fără diferențe</div>
      <div style="font-size:12px;color:#666;margin-top:2px">Identic cu ultimul backup salvat (${esc(diff.prevDate)} ${esc(diff.prevTime)}).</div>
    </div>`;
  }

  let html=`<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-weight:700;color:#f57f17;font-size:13px">⚠️ ${diff.total} diferențe față de ultimul backup salvat (${esc(diff.prevDate)} ${esc(diff.prevTime)})</div>`;

  html+=diffSection('➕ Persoane noi', diff.newDrivers.map(esc));
  html+=diffSection('➖ Persoane șterse', diff.removedDrivers.map(esc));

  if(diff.leaveChanges.length){
    const items=diff.leaveChanges.slice(0,30).map(c=>{
      const icon=c.type==='add'?'➕':'➖';
      return `${icon} <b>${esc(c.name)}</b> — ${c.label}: ${esc(c.period.start)} → ${esc(c.period.end)}`;
    });
    if(diff.leaveChanges.length>30) items.push(`...și încă ${diff.leaveChanges.length-30}`);
    html+=diffSection(`📅 Concedii / Krank / Fără plată (${diff.leaveChanges.length})`, items);
  }

  html+=diffSection('⚙️ Alte modificări', diff.otherChanges);
  html+=diffSection('📋 Sortatori — persoane adăugate/șterse', diff.sortChanges);

  const nums=[];
  if(diff.prezDiff)     nums.push(`📅 Prezențe (timeline): <b>${diff.prezDiff}</b> celule diferite`);
  if(diff.sortPresDiff) nums.push(`📋 Prezențe sortatori: <b>${diff.sortPresDiff}</b> celule diferite`);
  if(diff.planDiff)     nums.push(`🗓️ Planificare: <b>${diff.planDiff}</b> celule diferite`);
  html+=diffSection('🔢 Sumar modificări numerice', nums);

  return html;
}

async function sendEmail(backup, diffHtml){
  const json=JSON.stringify(backup,null,2);
  const filename=`mtc-backup-${backup.date}-22h.json`;
  console.log(`JSON: ${(json.length/1024).toFixed(1)} KB`);
  const t=nodemailer.createTransport({host:'smtp.mail.yahoo.com',port:465,secure:true,auth:{user:process.env.EMAIL_USER,pass:process.env.EMAIL_PASS}});
  await t.verify();
  const sortCount=backup.sortatori?(Array.isArray(backup.sortatori.drivers)?backup.sortatori.drivers.length:Object.values(backup.sortatori.drivers||{}).reduce((s,a)=>s+(a||[]).length,0)):0;
  const prezCount=Object.keys(backup.prezente||{}).length;
  const planCount=Object.keys(backup.planificare||{}).length;
  await t.sendMail({
    from:`"MTC Backup" <${process.env.EMAIL_USER}>`,to:process.env.EMAIL_TO,
    subject:`✅ Backup MTC Transport — ${backup.date} ora 22:00`,
    html:`<div style="font-family:Arial,sans-serif;max-width:560px">
      <h2 style="color:#6366f1">📦 Backup zilnic MTC Transport</h2>
      <p style="font-size:13px">${backup.date} ora 22:00</p>
      <table style="font-size:13px;border-collapse:collapse;margin-bottom:14px">
        <tr><td style="padding:3px 10px 3px 0">👥 Persoane</td><td><b>${backup.driverCount}</b></td></tr>
        <tr><td style="padding:3px 10px 3px 0">📅 Luni prezențe</td><td><b>${prezCount}</b></td></tr>
        <tr><td style="padding:3px 10px 3px 0">📦 Sortatori</td><td><b>${sortCount}</b></td></tr>
        <tr><td style="padding:3px 10px 3px 0">🗓️ Planificare săpt.</td><td><b>${planCount}</b></td></tr>
        <tr><td style="padding:3px 10px 3px 0">💾 Mărime JSON</td><td><b>${(json.length/1024).toFixed(1)} KB</b></td></tr>
      </table>
      <h3 style="font-size:14px;margin-bottom:6px">📊 Comparație cu ultimul backup salvat</h3>
      ${diffHtml}
      <p style="font-size:12px;color:#999;margin-top:14px">Fișierul JSON complet (live, ${backup.date} ${backup.time}) este atașat.</p>
    </div>`,
    attachments:[{filename,content:json,contentType:'application/json'}]
  });
  console.log(`✅ Email sent`);
}

(async()=>{
  try{
    const [live, prevBackup] = await Promise.all([fetchAll(), fetchLatestSavedBackup()]);
    const diff = computeDiff(prevBackup, live);
    const diffHtml = renderDiffHtml(diff);
    console.log(prevBackup ? `Diff vs last backup: ${diff.total} changes` : 'No previous backup found — first run');
    await sendEmail(live, diffHtml);
    console.log('✅ Done');
    process.exit(0);
  }catch(e){
    console.error('❌',e.message);
    process.exit(1);
  }
})();
