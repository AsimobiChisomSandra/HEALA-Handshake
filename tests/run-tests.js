// Run with: node Script/run-tests.js (needs Node.js)
const fs=require('fs'), path=require('path');
const data=fs.readFileSync(path.join(__dirname,'..','js','data.js'),'utf8');
const raw=data.match(/const FACILITIES_RAW = (\[[\s\S]*?\]);\n/)[1];
const HEALA=require('../js/engine.js');
const RAW=JSON.parse(raw);
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;} else {fail++; console.log('FAIL:',m);} };
let T=1_000_000_000_000; const now=()=>T;
const mk=()=>HEALA.create(RAW,{now});
const byName=(E,n)=>E.facilities.find(f=>f.name===n);
const burutu=E=>byName(E,'Burutu Primary Health Care Center');

// 1 ranking PPH: only Warri Central is verified+capable; others unverified
let E=mk(); let o=burutu(E);
let r=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m',familyPhone:'0801'});
const w1=r.offers.map(x=>E.fac.get(x.facId).name);
ok(w1.length===3,'wave1 size 3');
ok(w1[0]==='Warri Central Hospital' && r.offers[0].verified,'Warri Central first');
ok(r.offers.slice(1).every(x=>!x.verified),'rest unverified');
ok(!w1.includes('Ekpan General Hospital')&&!w1.includes('Burutu Government Hospital'),'fresh-but-incapable hubs excluded for PPH');

// 2 accept lock
const hub=r.offers[0].facId, u1=r.offers[1].facId, u2=r.offers[2].facId;
let res=E.facilityText(u1,`${r.code} 1`);
ok(r.status==='ACCEPTED'&&r.acceptedFacId===u1,'first accept wins');
res=E.facilityText(hub,`${r.code} 1`);
ok(r.acceptedFacId===u1,'second accept does not steal lock');
ok(r.offers.find(x=>x.facId===u2).reply==='RELEASED','other offer released');
ok(E.S.inbox[hub].some(m=>/accepted elsewhere/.test(m.text)),'late accepter told');
ok(E.S.phoneInbox['m'].some(m=>/^ACCEPTED/.test(m.text)),'referrer told');
ok(E.S.phoneInbox['0801'].some(m=>/Go to/.test(m.text)),'family told');

// 3 arrival + outcome order
E.facilityText(u1,`OUT ${r.code} 1`); ok(r.status==='ACCEPTED','outcome blocked before arrival');
E.facilityText(hub,`ARR ${r.code}`); ok(r.status==='ACCEPTED','wrong facility cannot mark arrival');
E.facilityText(u1,`arr ${r.code.toLowerCase()}`); ok(r.status==='ARRIVED','lowercase ARR works');
E.facilityText(u1,`OUT ${r.code} 3`); ok(r.status==='CLOSED'&&r.outcome==='DIED','outcome 3 = died (distinct from NO BLOOD)');

// 4 timeout escalation
E=mk(); o=burutu(E); T+=1000;
r=E.createReferral({originId:o.id,emergency:'ECLAMPSIA',ageIdx:0,transport:'ROAD',referrerPhone:'m'});
const first=new Set(r.offers.map(x=>x.facId));
T+=299_000; ok(E.tick()===false,'no escalation before 5 min');
T+=2_000; ok(E.tick()===true&&r.wave===2&&r.escalated,'escalates after 5 min');
ok(r.offers.filter(x=>x.wave===2).every(x=>!first.has(x.facId)),'wave 2 has new hospitals');
ok(r.offers.length===6,'6 offers');
E.S.fast=true; T+=31_000; E.tick(); ok(r.wave===3,'fast timer 30s works');

// 5 early escalation when all decline
E=mk(); o=burutu(E);
r=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
r.offers.slice(0,2).forEach(x=>E.facilityText(x.facId,`${r.code} 2`)); ok(r.wave===1,'not yet escalated');
E.facilityText(r.offers[2].facId,`${r.code} 3`); ok(r.wave===2,'all declined -> wave 2 immediately');

// 6 exhaustion
for(let i=0;i<10 && r.status==='SEEKING';i++){ r.offers.filter(x=>x.reply===null).forEach(x=>E.facilityText(x.facId,`${r.code} 4`)); }
ok(r.status==='UNMATCHED','exhausted -> UNMATCHED');
ok(r.wave<=4,'max 4 waves, got '+r.wave);
// late accept after unmatched is allowed? (offers all replied) -> new offers none; skip

// 7 SMS lengths
let maxLen=0, over=[];
E=mk();
const prim=E.facilities.filter(f=>f.level==='Primary');
for(const em of Object.keys(HEALA.EM)) for(const tr of HEALA.TRANSPORTS) for(const p of prim){
  const E2=E; const rr=E2.createReferral({originId:p.id,emergency:em,ageIdx:3,transport:tr,referrerPhone:'z',familyPhone:'0801'});
  Object.values(E2.S.inbox).flat().concat(Object.values(E2.S.phoneInbox).flat()).forEach(m=>{ if(m.text.length>maxLen) maxLen=m.text.length; if(m.text.length>160) over.push(m.text.length+':'+m.text); });
  E2.S.inbox={}; E2.S.phoneInbox={}; E2.S.referrals=[];
}
ok(over.length===0,'all SMS <=160 chars, over: '+over.slice(0,2).join(' | ')); console.log('max SMS length',maxLen);

// 8 parser
const P=HEALA.parseSms;
ok(P('k7q2 1').type==='REPLY','lowercase reply'); ok(P('  K7Q2   2 ').n===2,'spaces');
ok(P('ARR K7Q2').type==='ARR','arr'); ok(P('OUT K7Q2 3').n===3,'out');
ok(P('BLD K7Q2 1').type==='BLD'&&P('BLD K7Q2 1').n===1,'blood bridge reply');
ok(P('R B1 O1 D1 T0 W1 N3').type==='READINESS','readiness'); ok(P('hello').type==='UNKNOWN','unknown');
ok(P('K7Q2 5').type==='UNKNOWN','bad digit');

// 9 readiness SMS changes ranking
E=mk(); o=burutu(E); const ekpan=byName(E,'Ekpan General Hospital');
E.facilityText(ekpan.id,'R B1 O1 D1 T1 W1 N2');
r=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
ok(r.offers.some(x=>x.facId===ekpan.id&&x.verified),'Ekpan verified-capable after readiness SMS');
// stale readiness (>24h) -> unverified
T+=25*3600*1000; ok(!E.isFresh(ekpan.id),'readiness stale after 24h');

// 10 USSD
E=mk(); o=burutu(E); let out;
out=E.ussdReferral('p','',o.id); ok(out.type==='CON','menu');
const lens=[]; const chk=x=>{lens.push(x.text.length);return x;};
chk(E.ussdReferral('p','1',o.id)); chk(E.ussdReferral('p','1*1',o.id)); chk(E.ussdReferral('p','1*1*2',o.id)); chk(E.ussdReferral('p','1*1*2*1',o.id));
out=E.ussdReferral('p','1*1*2*1*08031234567',o.id); chk(out);
ok(out.type==='END'&&/sent to 3 hospitals/.test(out.text),'USSD creates referral: '+out.text);
ok(E.S.referrals.length===1,'one referral');
ok(E.ussdReferral('p','1*9',o.id).type==='END','invalid emergency ends');
ok(E.ussdReferral('p','1*1*2*1*123',o.id).type==='END' && E.S.referrals.length===1,'bad phone rejected, no referral');
out=E.ussdReferral('p','1*1*2*3*0',o.id); ok(E.S.referrals.length===2&&E.S.referrals[1].transport==='SAVEMAMA','SAVEMAMA transport + skip phone');
const code=E.S.referrals[0].code; out=E.ussdReferral('p','2*'+code.toLowerCase(),o.id); ok(/SEEKING|Waiting/.test(out.text)||/Waiting/.test(out.text),'status check: '+out.text);
['','1','1*1','1*2','1*2*1','1*2*2'].forEach(t=>{ const x=E.ussdGoNow(t); lens.push(x.text.length); });
ok(E.ussdGoNow('1*1').text.startsWith('GO NOW')||true,'gonow'); 
ok(/^GO NOW/.test(E.ussdGoNow('1*1').text),'danger sign -> GO NOW');
ok(/^No danger/.test(E.ussdGoNow('2*2').text),'no sign -> no danger');
console.log('max USSD screen length',Math.max(...lens));
ok(Math.max(...lens.filter((_,i)=>i<5))<=182,'referral USSD screens <=182');
const longest=E.ussdGoNow('1*1').text.length; console.log('GoNow END length',longest);

// 11 unknown sms to facility and wrong code
E=mk(); o=burutu(E); r=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
const notOffered=E.receivers.find(f=>!r.offers.some(x=>x.facId===f.id)).id;
E.facilityText(notOffered,`${r.code} 1`); ok(r.status==='SEEKING','non-offered facility cannot accept');
E.facilityText(r.offers[0].facId,'ZZZZ 1'); ok(true,'unknown code handled');
// double reply
E.facilityText(r.offers[0].facId,`${r.code} 2`); E.facilityText(r.offers[0].facId,`${r.code} 1`);
ok(r.status==='SEEKING','cannot flip decline into accept');

// 12 metrics
E=mk(); o=burutu(E); r=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
T+=8000; E.facilityText(r.offers[0].facId,`${r.code} 1`); const mt=E.metrics();
ok(mt.accepted===1&&mt.medianAcceptMs===8000,'median accept 8s');

// 13 persistence round-trip
const saved=JSON.parse(JSON.stringify(E.S)); const E3=HEALA.create(RAW,{now,state:saved});
ok(E3.byCode(r.code).status==='ACCEPTED','state restore');

// 14 data sanity
ok(E.facilities.length===410,'410 facilities'); ok(E.receivers.length===54,'54 receivers');
['Warri Central Hospital','Ekpan General Hospital','Ogbe Ijoh General Hospital','Burutu Government Hospital','Bomadi Bomadi General Hospital'].forEach(n=>ok(!!byName(E,n),'hub present '+n));

// 15 scorecard and supply gaps
E=mk();
const emptyScorecard=E.scorecard(), emptyGaps=E.gaps();
ok(emptyScorecard.length===0,'scorecard empty state');
ok(emptyGaps.rows.length===0&&!emptyGaps.alert,'supply gaps empty state');

E=mk(); o=burutu(E);
let acceptedReferral=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
const scoreFacility=acceptedReferral.offers[0].facId;
E.facilityText(scoreFacility,`${acceptedReferral.code} 1`);
T+=60_000;
let declinedReferral=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
E.facilityText(scoreFacility,`${declinedReferral.code} 2`);
let score=E.scorecard().find(row=>row.facilityId===scoreFacility);
ok(score.timesAsked===2&&score.accepted===1&&score.declinedNoBed===1&&score.acceptanceRate===50,'scorecard acceptance rate and counts');
ok(score.readiness.status==='verified'&&score.readiness.hoursSinceUpdate>2&&score.readiness.hoursSinceUpdate<2.1,'scorecard verified readiness age');

E=mk(); o=burutu(E);
let firstTimed=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
const timedFacility=firstTimed.offers[0].facId;
T+=10_000; E.facilityText(timedFacility,`${firstTimed.code} 1`);
T+=1; let secondTimed=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
T+=11_000; E.facilityText(timedFacility,`${secondTimed.code} 1`);
score=E.scorecard().find(row=>row.facilityId===timedFacility);
ok(Math.abs(score.medianMinutesToAccept-0.175)<0.00001,'scorecard median offer-to-accept time preserves fractional minutes');

E=mk(); o=burutu(E);
for(let i=0;i<3;i++){
  const noBloodReferral=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
  E.facilityText(noBloodReferral.offers[0].facId,`${noBloodReferral.code} 3`);
  if(i===1) ok(!E.gaps().alert,'no-blood alert below demo threshold');
}
ok(E.gaps().alert,'no-blood alert reaches demo threshold');
const bloodGap=E.gaps().rows.find(row=>row.noBlood===3);
ok(!!bloodGap&&bloodGap.noBed===0&&bloodGap.noDoctor===0,'supply gaps count decline reasons by facility');

// 16 privacy-safe CSV export
E=mk();
const csvHeader='code,created_at,origin_facility,lga,emergency,age_band,transport,status,waves,hospitals_asked,accepted_facility,minutes_to_accept,minutes_accept_to_arrival,outcome';
ok(E.exportCsv()===csvHeader,'empty CSV contains header only');
const csvRaw=RAW.map(f=>Object.assign({},f));
const csvOrigin=csvRaw.find(f=>f.level==='Primary');
csvOrigin.name='Origin, "Demo" Facility';
E=HEALA.create(csvRaw,{now});
o=E.facilities.find(f=>f.name===csvOrigin.name);
E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'08031234567',familyPhone:'08039876543'});
const csv=E.exportCsv();
ok(csv.split('\r\n').length===2,'CSV contains one referral row');
ok(csv.includes('"Origin, ""Demo"" Facility"'),'CSV quotes facility commas and quotes');
ok(!csv.includes('08031234567')&&!csv.includes('08039876543')&&!/\b0\d{10}\b/.test(csv),'CSV excludes phone numbers');

// 17 Blood Bridge selection, lock, fallback and SMS size
E=mk(); o=burutu(E);
let bloodReferral=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
const noBloodFac=bloodReferral.offers[0].facId;
E.facilityText(noBloodFac,`${bloodReferral.code} 3`);
E.receivers.forEach(f=>{ E.S.ready[f.id]={B:1,O:1,D:1,T:1,W:1,N:1,at:T}; });
const expectedBlood=E.receivers.filter(f=>f.id!==noBloodFac)
  .sort((a,b)=>HEALA.haversine(o,a)-HEALA.haversine(o,b)).slice(0,3);
let blood=E.bloodRequest(bloodReferral.code);
ok(blood.offers.length===3,'Blood Bridge asks at most three hospitals');
ok(blood.offers.map(x=>x.facId).join(',')===expectedBlood.map(f=>f.id).join(','),'Blood Bridge ranks fresh blood-ready receivers by distance');
ok(!blood.offers.some(x=>x.facId===noBloodFac),'Blood Bridge excludes the hospital that declined');
ok(blood.offers.every(x=>x.verified),'fresh blood-ready candidates are labelled verified');

E=mk(); o=burutu(E);
bloodReferral=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
const declinedHub=bloodReferral.offers[0].facId;
E.facilityText(declinedHub,`${bloodReferral.code} 3`);
blood=E.bloodRequest(bloodReferral.code);
ok(blood.offers.length===3&&blood.offers.every(x=>!x.verified),'unverified receivers fill slots after no fresh blood-ready matches');
ok(blood.offers.every(x=>x.facId!==declinedHub),'unverified fallback still excludes the declining hospital');
const firstBlood=blood.offers[0], laterBlood=blood.offers[1];
E.facilityText(firstBlood.facId,`BLD ${bloodReferral.code} 1`);
ok(blood.acceptedFacId===firstBlood.facId,'first Blood Bridge yes locks the request');
E.facilityText(laterBlood.facId,`BLD ${bloodReferral.code} 1`);
ok(E.S.inbox[laterBlood.facId].slice(-1)[0].text==='HEALA BLOOD '+bloodReferral.code+': already taken.','later Blood Bridge reply gets the already-taken SMS');
ok(bloodReferral.events.some(x=>/Blood Bridge locked/.test(x.text))&&bloodReferral.events.some(x=>/already taken/.test(x.text)),'Blood Bridge replies and lock are recorded in the timeline');
ok(blood.offers.every(x=>E.S.inbox[x.facId].some(m=>m.text.startsWith('HEALA BLOOD '))&&E.S.inbox[x.facId].find(m=>m.text.startsWith('HEALA BLOOD ')).text.length<=160),'Blood Bridge SMS is at most 160 characters');

const longNameRaw=[
  {uid:'origin',name:'Origin facility '.repeat(20),lga:'Demo',ward:'Demo',level:'Primary',own:'Public',lat:5.5,lng:5.7},
  {uid:'receiver1',name:'Receiver One',lga:'Demo',ward:'Demo',level:'Secondary',own:'Public',lat:5.51,lng:5.71},
  {uid:'receiver2',name:'Receiver Two',lga:'Demo',ward:'Demo',level:'Tertiary',own:'Public',lat:5.52,lng:5.72},
  {uid:'receiver3',name:'Receiver Three',lga:'Demo',ward:'Demo',level:'Secondary',own:'Public',lat:5.53,lng:5.73},
  {uid:'receiver4',name:'Receiver Four',lga:'Demo',ward:'Demo',level:'Secondary',own:'Public',lat:5.54,lng:5.74}
];
E=HEALA.create(longNameRaw,{now});
o=E.facilities[0];
bloodReferral=E.createReferral({originId:o.id,emergency:'PPH',ageIdx:1,transport:'BOAT',referrerPhone:'m'});
E.facilityText(bloodReferral.offers[0].facId,`${bloodReferral.code} 3`);
blood=E.bloodRequest(bloodReferral.code);
ok(blood.offers.every(x=>E.S.inbox[x.facId].find(m=>m.text.startsWith('HEALA BLOOD ')).text.length<=160),'long facility names are truncated to keep Blood Bridge SMS within 160 characters');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
