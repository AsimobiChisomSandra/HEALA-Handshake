/* HEALA Handshake: screens and buttons.
   Talks to the engine (HEALA) and the facility data (FACILITIES_RAW). No external resources.
   Simulation only: no real SMS or USSD is sent. */
(function () {
  'use strict';

  const KEY = 'heala-demo-v1';
  const KEEP_MS = 6 * 3600 * 1000;           // saved demo state is dropped after 6 hours
  const MIDWIFE = 'Midwife (demo phone)';    // label, not a real number
  const DEMO_FAMILY_PHONE = '07000000000';   // placeholder number used only in the guided demo
  const STEP_MS = 1700;

  const $ = id => document.getElementById(id);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]); }
  function demoChip() { return '<span class="chip demo">' + esc('DEMO') + '</span>'; }

  let E = null;          // engine instance
  let selCode = null;    // referral shown in the hospital and dashboard columns
  let renderedDetailCode = null;
  let renderedDetailStatus = null;
  let sess = null;       // USSD session on the midwife's phone
  let familySess = null; // separate USSD session on the family's phone
  let timers = [];       // guided demo timers
  let drafts = {};       // text typed on hospital phones, kept across redraws

  // ---- Formatting ----------------------------------------------------------
  function hms(ts) { return new Date(ts).toLocaleTimeString('en-GB'); }
  function dur(ms) {
    if (ms == null) return '-';
    const s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function ago(h) {
    if (h == null) return '';
    return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min ago' : (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h ago';
  }
  function statusOf(r) { return r.status === 'SEEKING' && r.escalated ? 'ESCALATED' : r.status; }
  const REPLY_WORDS = {
    ACCEPT: 'Accepted', NO_BED: 'No bed', NO_BLOOD: 'No blood', NO_DOCTOR: 'No doctor',
    RELEASED: 'Released', EXPIRED: 'No reply', YES: 'Can supply', NO: 'Cannot supply'
  };

  // ---- Saving --------------------------------------------------------------
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (j && j.state && Date.now() - j.savedAt < KEEP_MS) return HEALA.create(FACILITIES_RAW, { state: j.state });
    } catch (e) { /* ignore a broken save */ }
    return HEALA.create(FACILITIES_RAW);
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), state: E.S })); } catch (e) { /* storage may be blocked */ }
  }

  function cur() {
    return (selCode && E.byCode(selCode)) || E.S.referrals[E.S.referrals.length - 1] || null;
  }

  // ---- Midwife phone -------------------------------------------------------
  function buildOrigin() {
    const sel = $('origin');
    const byLga = {};
    E.facilities.filter(f => !f.receiver).forEach(f => { (byLga[f.lga] = byLga[f.lga] || []).push(f); });
    sel.innerHTML = Object.keys(byLga).sort().map(l =>
      '<optgroup label="' + esc(l) + '">' +
      byLga[l].sort((a, b) => a.name.localeCompare(b.name)).map(f => '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>').join('') +
      '</optgroup>').join('');
    const def = E.facilities.find(f => f.name === 'Burutu Primary Health Care Center');
    if (def) sel.value = def.id;
  }

  const ROLES = ['nurse', 'hospital', 'family', 'dashboard', 'all'];
  function setRole(role, persist) {
    if (ROLES.indexOf(role) === -1) return;
    $('panels').dataset.role = role;
    document.querySelectorAll('.role-button').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.role === role ? 'true' : 'false');
    });
    document.querySelectorAll('[data-role-panel]').forEach(panel => {
      panel.hidden = role !== 'all' && panel.dataset.rolePanel !== role;
    });
    if (persist) {
      try { localStorage.setItem('heala-role', role); } catch (e) { /* storage may be blocked */ }
    }
  }
  function initRole() {
    let role = null;
    try { role = localStorage.getItem('heala-role'); } catch (e) { /* storage may be blocked */ }
    if (ROLES.indexOf(role) === -1) role = window.innerWidth >= 1100 ? 'all' : 'nurse';
    setRole(role, false);
  }
  function renderPeople() {
    const origin = E.fac.get($('origin').value);
    $('nurseYouAre').textContent = 'You are: the midwife at ' + (origin ? origin.name : 'the referring facility');
  }

  function renderPatientProgress() {
    const r = cur();
    const steps = ['Referral sent', 'Hospital said yes', 'On the way', 'Arrived', 'Outcome'];
    let current = -1, summary = 'No referral yet';
    if (r) {
      const origin = E.fac.get(r.originId);
      const hospital = r.acceptedFacId ? E.fac.get(r.acceptedFacId) : null;
      if (r.status === 'ACCEPTED') {
        current = 2;
        const offer = r.offers.find(o => o.facId === r.acceptedFacId);
        summary = (hospital ? hospital.name : 'Hospital') + ' said yes. Patient is on the way' +
          (offer && offer.eta != null ? ', about ' + offer.eta + ' minutes (simulated).' : '.');
      } else if (r.status === 'ARRIVED') {
        current = 3;
        summary = 'Patient arrived at ' + (hospital ? hospital.name : 'the hospital') + '.';
      } else if (r.status === 'CLOSED') {
        current = 4;
        summary = 'Outcome: ' + String(r.outcome || '').replace(/_/g, ' ').toLowerCase() + '.';
      } else if (r.status === 'UNMATCHED') {
        current = 0;
        summary = 'Patient is at ' + (origin ? origin.name : 'the referring facility') + '; no hospital has said yes yet.';
      } else {
        current = 0;
        summary = 'Patient is at ' + (origin ? origin.name : 'the referring facility') + ', waiting for a hospital to say yes.';
      }
    }
    const content = '<h3>' + esc('Where is the patient?') + '</h3><ol class="patient-steps">' +
      steps.map((step, i) => {
        const state = i < current ? 'done' : (i === current ? 'current' : 'future');
        const marker = state === 'done' ? '&#10003;' : String(i + 1);
        return '<li class="' + state + '"' + (i === current ? ' aria-current="step"' : '') +
          '><span class="step-marker" aria-hidden="true">' + marker + '</span><span class="step-label">' + esc(step) + '</span></li>';
      }).join('') +
      '</ol><p class="patient-summary">' + esc(summary) + '</p><small class="patient-simulated">' +
      esc('Times are simulated.') + '</small>';
    ['nursePatientProgress', 'familyPatientProgress', 'dashboardPatientProgress'].forEach(id => {
      $(id).innerHTML = content;
    });
  }

  function renderLcd() {
    const el = $('lcd');
    if (!sess) {
      el.innerHTML = esc('HEALA demo phone\n\nPress a dial button below.\nNo data needed.');
      return;
    }
    const title = sess.line === 'referral' ? '*000# Referral line' : '*000*1# Family Go-Now line';
    let h = esc(title + '\n\n' + sess.screen.text);
    if (sess.screen.type === 'CON') {
      h += '<input type="text" id="ussdIn" inputmode="numeric" autocomplete="off" aria-label="Type your answer, then press Send" placeholder="Type answer">' +
        '<div class="row"><button class="btn small" data-act="ussd-send">Send</button></div>';
    } else {
      h += esc('\n\nSession ended.');
    }
    el.innerHTML = h;
  }

  function renderFamilyLcd() {
    const el = $('familyLcd');
    if (!familySess) {
      el.innerHTML = esc('HEALA family phone\n\nPress the Go-Now button below.');
      return;
    }
    let h = esc('*000*1# Family Go-Now line\n\n' + familySess.screen.text);
    if (familySess.screen.type === 'CON') {
      h += '<input type="text" id="familyUssdIn" inputmode="numeric" autocomplete="off" aria-label="Type your answer, then press Send" placeholder="Type answer">' +
        '<div class="row"><button class="btn small" data-act="family-ussd-send">Send</button></div>';
    } else {
      h += esc('\n\nSession ended.');
    }
    el.innerHTML = h;
  }

  function ussdCall() {
    const text = sess.path.join('*');
    const before = E.S.referrals.length;
    sess.screen = sess.line === 'referral' ? E.ussdReferral(MIDWIFE, text, $('origin').value) : E.ussdGoNow(text);
    if (E.S.referrals.length > before) selCode = E.S.referrals[E.S.referrals.length - 1].code;
  }
  function dial(line) {
    sess = { line, path: [], screen: null };
    ussdCall();
    afterAction();
    const input = $('ussdIn');
    if (input) input.focus();
  }
  function ussdSend(v) {
    if (!sess || sess.screen.type !== 'CON') return;
    v = String(v == null ? '' : v).replace(/\*/g, '').trim();
    if (!v) return;
    sess.path.push(v);
    ussdCall();
    afterAction();
    const input = $('ussdIn');
    if (input) input.focus();
  }
  function dialFamily() {
    familySess = { path: [], screen: E.ussdGoNow('') };
    afterAction();
    const input = $('familyUssdIn');
    if (input) input.focus();
  }
  function familySend(v) {
    if (!familySess || familySess.screen.type !== 'CON') return;
    v = String(v == null ? '' : v).replace(/\*/g, '').trim();
    if (!v) return;
    familySess.path.push(v);
    familySess.screen = E.ussdGoNow(familySess.path.join('*'));
    afterAction();
    const input = $('familyUssdIn');
    if (input) input.focus();
  }

  function msgHtml(m) {
    return '<div class="msg ' + esc(m.kind || '') + '"><small>' + esc(hms(m.at)) + (m.dir === 'out' ? ' - sent by this phone' : '') + '</small>' + esc(m.text) + '</div>';
  }
  function inboxHtml(list, empty) {
    if (!list || !list.length) return '<div class="empty">' + esc(empty) + '</div>';
    return list.slice().reverse().map(msgHtml).join('');
  }
  function renderInboxes() {
    $('mwInbox').innerHTML = inboxHtml(E.S.phoneInbox[MIDWIFE], 'No SMS yet. Send a referral to see the replies arrive.');
    const r = cur();
    $('famInbox').innerHTML = r && r.familyPhone
      ? '<div class="mute">Family phone (demo): ' + esc(r.familyPhone) + '</div>' + inboxHtml(E.S.phoneInbox[r.familyPhone], 'No SMS yet. The family is texted when a hospital accepts.')
      : '<div class="empty">No family phone on this referral, so no family SMS is sent.</div>';
  }

  // ---- Hospital phones -----------------------------------------------------
  function capText(rd) {
    if (!rd.known) return 'No readiness update on record.';
    const f = rd.flags, yn = v => (v ? 'yes' : 'no');
    return 'Blood ' + yn(f.B) + ', oxygen ' + yn(f.O) + ', doctor ' + yn(f.D) + ', theatre ' + yn(f.T) +
      ', newborn unit ' + yn(f.W) + ', free beds ' + f.N + '. Updated ' + ago(rd.hoursAgo) + ' (demo values).';
  }
  function smsBtn(cls, fac, text, label) {
    return '<button class="btn small ' + cls + '" data-act="hsms" data-fac="' + esc(fac) + '" data-text="' + esc(text) + '">' + esc(label) + '</button>';
  }
  function hospCard(r, o, bloodOffer) {
    const facId = (o || bloodOffer).facId;
    const f = E.fac.get(facId), rd = E.readiness(facId);
    let btns = '';
    if (o && o.reply === null && r.status === 'SEEKING') {
      btns = smsBtn('ok', f.id, r.code + ' 1', 'Accept') + smsBtn('no', f.id, r.code + ' 2', 'No bed') +
        smsBtn('no', f.id, r.code + ' 3', 'No blood') + smsBtn('no', f.id, r.code + ' 4', 'No doctor');
    } else if (o && r.acceptedFacId === f.id && r.status === 'ACCEPTED') {
      btns = smsBtn('ok', f.id, 'ARR ' + r.code, 'Patient arrived');
    } else if (o && r.acceptedFacId === f.id && r.status === 'ARRIVED') {
      btns = smsBtn('line', f.id, 'OUT ' + r.code + ' 1', 'Stable') + smsBtn('line', f.id, 'OUT ' + r.code + ' 2', 'Transferred') +
        smsBtn('line', f.id, 'OUT ' + r.code + ' 3', 'Died') + smsBtn('line', f.id, 'OUT ' + r.code + ' 4', 'Still admitted');
    } else if (o && o.reply) {
      btns = '<span class="chip">' + esc(REPLY_WORDS[o.reply] || o.reply) + '</span>';
    }
    let bloodBtns = '';
    if (bloodOffer && bloodOffer.reply === null) {
      bloodBtns = smsBtn('ok', f.id, 'BLD ' + r.code + ' 1', 'Can supply blood') +
        smsBtn('no', f.id, 'BLD ' + r.code + ' 2', 'Cannot supply');
    } else if (bloodOffer) {
      bloodBtns = '<span class="chip">Blood Bridge: ' + esc(REPLY_WORDS[bloodOffer.reply] || bloodOffer.reply) + '</span>';
    }
    const inbox = (E.S.inbox[f.id] || []).slice(-3).reverse().map(msgHtml).join('');
    return '<div class="hosp">' +
      '<p class="who">You are: staff at ' + esc(f.name) + '</p>' +
      '<h4><span>' + esc(f.name) + '</span><span class="chip ' + ((o ? o.verified : bloodOffer.verified) ? 'ver' : 'unv') + '">' + ((o ? o.verified : bloodOffer.verified) ? 'verified' : 'unverified') + '</span></h4>' +
      (o ? '<div class="mute">Round ' + esc(o.wave) + ', ' + esc(f.level) + ', ' + esc(f.lga) + ', about ' + esc(Math.round(o.dist)) + ' km, ETA ' + esc(o.eta) + ' min</div>' :
        '<div class="mute">Blood Bridge request, ' + esc(f.level) + ', ' + esc(f.lga) + ', about ' + esc(Math.round(bloodOffer.dist)) + ' km</div>') +
      '<div class="mute">' + esc(capText(rd)) + (rd.known ? ' ' + demoChip() : '') + '</div>' +
      '<div class="row">' + btns + bloodBtns + '</div>' +
      '<div class="row"><input type="text" data-draft="' + esc(f.id) + '" aria-label="Type an SMS reply for ' + esc(f.name) + '" placeholder="Type a reply, for example ' + esc(r.code) + ' 1" value="' + esc(drafts[f.id] || '') + '">' +
      smsBtn('line', f.id, '', 'Send').replace('data-act="hsms"', 'data-act="hsend"') + '</div>' +
      '<div class="inbox" role="log" aria-label="SMS for ' + esc(f.name) + '" aria-live="polite" aria-relevant="additions text" aria-atomic="false">' + inbox + '</div></div>';
  }
  function renderHosp() {
    const r = cur();
    if (!r) {
      $('hospList').innerHTML = '<div class="empty">No hospital has been asked yet. Dial the referral line on the midwife\'s phone, or press "Run guided demo".</div>';
      return;
    }
    const cards = new Map();
    r.offers.forEach(o => cards.set(o.facId, { offer: o, bloodOffer: null }));
    if (r.bloodRequest) r.bloodRequest.offers.forEach(o => {
      const card = cards.get(o.facId) || { offer: null, bloodOffer: null };
      card.bloodOffer = o;
      cards.set(o.facId, card);
    });
    $('hospList').innerHTML = Array.from(cards.values()).map(card => hospCard(r, card.offer, card.bloodOffer)).join('');
  }

  function renderReadiness() {
    const hubs = E.facilities.filter(f => f.receiver && HEALA.DEMO_HUBS[f.name]);
    $('readiness').innerHTML = hubs.map(f => {
      const rd = E.readiness(f.id);
      const state = !rd.known ? 'no update' : rd.fresh ? 'updated ' + ago(rd.hoursAgo) + ' (demo)' : 'silent 24 h or more: unverified';
      const caps = rd.known ? ['B', 'O', 'D', 'T', 'W'].map(k =>
        '<button class="cap' + (rd.flags[k] ? ' on' : '') + '" aria-pressed="' + (rd.flags[k] ? 'true' : 'false') + '" data-act="cap" data-fac="' + esc(f.id) + '" data-k="' + k + '">' +
        esc(HEALA.CAP_LABEL[k]) + ': ' + (rd.flags[k] ? 'yes' : 'no') + '</button>').join('') : '';
      return '<div class="hosp"><p class="who">You are: staff at ' + esc(f.name) + '</p><h4><span>' + esc(f.name) + '</span><span class="badge-group"><span class="chip ' + (rd.fresh ? 'ver' : 'unv') + '">' + esc(state) + '</span>' + (rd.known ? demoChip() : '') + '</span></h4>' +
        '<div>' + caps + (rd.known ? ' ' + demoChip() : '') + '</div>' +
        '<div class="row"><span class="mute">Free beds: ' + (rd.known ? rd.flags.N : '-') + (rd.known ? ' ' + demoChip() : '') + '</span>' +
        '<button class="btn small line" data-act="fresh" data-fac="' + esc(f.id) + '">Send readiness SMS now</button>' +
        '<button class="btn small line" data-act="stale" data-fac="' + esc(f.id) + '">Go silent for 25 h</button></div></div>';
    }).join('');
  }

  // ---- Dashboard -----------------------------------------------------------
  function renderKpis() {
    const m = E.metrics();
    const tiles = [
      [m.total, 'Referrals'], [m.accepted, 'Accepted'], [dur(m.medianAcceptMs), 'Median time to accept (simulated)'],
      [m.arrived, 'Arrived'], [m.unmatched, 'No hospital found']
    ];
    $('kpis').innerHTML = tiles.map(t => '<div class="kpi"><b>' + esc(t[0]) + '</b><span>' + esc(t[1]) + '</span></div>').join('');
  }
  function renderRefs() {
    const list = E.S.referrals;
    if (!list.length) { $('refList').innerHTML = '<div class="empty">No referrals yet. They appear here the moment a midwife sends one.</div>'; return; }
    const r0 = cur();
    $('refList').innerHTML = list.slice().reverse().map(r => {
      const st = statusOf(r), from = E.fac.get(r.originId);
      return '<button class="ref' + (r0 && r0.code === r.code ? ' sel' : '') + '" data-act="pick" data-code="' + esc(r.code) + '" aria-pressed="' + (r0 && r0.code === r.code ? 'true' : 'false') + '">' +
        '<span><b>' + esc(r.code) + '</b> ' + esc(HEALA.EM[r.emergency].short) + '<br><span class="mute">from ' + esc(from.name) + ', round ' + r.wave + '</span></span>' +
        '<span class="chip ' + esc(st) + '">' + esc(st) + '</span></button>';
    }).join('');
  }
  function renderDetail() {
    const r = cur();
    if (!r) {
      $('detail').innerHTML = '';
      renderedDetailCode = null;
      renderedDetailStatus = null;
      return;
    }
    const focusUnmatched = r.status === 'UNMATCHED' &&
      (renderedDetailCode !== r.code || renderedDetailStatus !== r.status);
    const st = statusOf(r), from = E.fac.get(r.originId);
    const rows = r.offers.map(o => {
      const f = E.fac.get(o.facId);
      return '<tr><td data-label="Hospital">' + esc(f.name) + '</td><td data-label="Round">' + o.wave + '</td><td data-label="Check">' +
        (o.verified ? 'verified' : 'unverified') + '</td><td data-label="Reply">' +
        esc(o.reply === null ? 'waiting' : (REPLY_WORDS[o.reply] || o.reply)) + '</td><td data-label="Distance, ETA">' +
        Math.round(o.dist) + ' km, ' + o.eta + ' min</td></tr>';
    }).join('');
    const nowMs = E.now ? E.now() : Date.now();
    const terminal = r.status === 'CLOSED' || r.status === 'UNMATCHED';
    const lastEvent = r.events[r.events.length - 1];
    const elapsed = Math.max(0, (terminal ? (lastEvent ? lastEvent.at : r.createdAt) : nowMs) - r.createdAt);
    const acceptedAfter = r.acceptedAt == null ? '' : '<div class="accepted-banner">Accepted after ' + esc(dur(r.acceptedAt - r.createdAt)) + '</div>';
    const simLabel = E.S.fast ? '<div class="simulated-tag">Simulated timings</div>' : '';
    $('detail').innerHTML =
      '<h3>Referral ' + esc(r.code) + ' <span class="chip ' + esc(st) + '">' + esc(st) + '</span></h3>' +
      '<div class="mute">' + esc(HEALA.EM[r.emergency].label) + ', ' + esc(HEALA.AGES[r.ageIdx]) + ', ' + esc(r.transport.toLowerCase()) + ', from ' + esc(from.name) + '</div>' +
      (r.status === 'UNMATCHED'
        ? '<div class="unmatched-alert" tabindex="-1" role="alert" aria-live="assertive" aria-atomic="true">' +
          esc('No hospital has accepted. Do not wait. Call 112 and your health worker now.') +
          '<small>' + esc('For emergency transport, call or text SAVEMAMA 3581.') + '</small></div>'
        : '') +
      (r.offers.some(o => o.reply === 'NO_BLOOD') && !r.bloodRequest
        ? '<div class="row"><button class="btn small" data-act="blood-request" data-code="' + esc(r.code) + '">Ask other hospitals for blood</button></div>'
        : r.bloodRequest
          ? '<div class="msg warn">Blood Bridge: asked ' + esc(r.bloodRequest.offers.length) + ' hospitals' +
            (r.bloodRequest.acceptedFacId ? '; ' + esc(E.fac.get(r.bloodRequest.acceptedFacId).name) + ' responded yes.' : '.') + '</div>'
          : '') +
      '<div class="ref-timer">' + simLabel + '<span class="timer-label">Time since referral created</span><span class="timer-value" role="timer" aria-live="polite" aria-atomic="true">' + esc(dur(elapsed)) + '</span></div>' +
      acceptedAfter +
      '<h3>Timeline</h3><ul class="tl">' + r.events.map(e => '<li><span class="event-age">' + esc('+' + dur(Math.max(0, e.at - r.createdAt))) + '</span> ' + esc(e.text) + '</li>').join('') + '</ul>' +
      '<h3>Hospitals asked</h3><div><table aria-label="Hospitals asked for this referral"><thead><tr><th scope="col">Hospital</th><th scope="col">Round</th><th scope="col">Check</th><th scope="col">Reply</th><th scope="col">Distance, ETA</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    renderedDetailCode = r.code;
    renderedDetailStatus = r.status;
    if (focusUnmatched) {
      const alert = $('detail').querySelector('.unmatched-alert');
      if (alert) requestAnimationFrame(() => { if (alert.isConnected) alert.focus(); });
    }
  }

  function renderScorecard() {
    const rows = E.scorecard();
    if (!rows.length) {
      $('scorecard').innerHTML = '<div class="empty">No hospitals have been asked yet.</div>';
      return;
    }
    $('scorecard').innerHTML = '<div><table aria-label="Facility scorecard"><thead><tr>' +
      '<th scope="col">Hospital</th><th scope="col">Asked</th><th scope="col">Accepted</th><th scope="col">No bed</th><th scope="col">No blood</th><th scope="col">No doctor</th>' +
      '<th scope="col">Acceptance rate</th><th scope="col">Median offer-to-accept (min:sec)</th><th scope="col">Readiness</th></tr></thead><tbody>' +
      rows.map(row => {
        const readinessText = row.readiness.status === 'verified'
          ? 'Verified, ' + row.readiness.hoursSinceUpdate.toFixed(1) + ' h since update'
          : 'Unverified';
        return '<tr><td data-label="Hospital">' + esc(row.facility) + '</td><td data-label="Asked">' + esc(row.timesAsked) +
          '</td><td data-label="Accepted">' + esc(row.accepted) + '</td><td data-label="No bed">' + esc(row.declinedNoBed) +
          '</td><td data-label="No blood">' + esc(row.declinedNoBlood) + '</td><td data-label="No doctor">' + esc(row.declinedNoDoctor) +
          '</td><td data-label="Acceptance rate">' + esc(row.acceptanceRate) + '%</td><td data-label="Median offer-to-accept (min:sec)">' +
          esc(row.medianMinutesToAccept == null ? '-' : dur(row.medianMinutesToAccept * 60000)) + '</td><td data-label="Readiness">' +
          esc(readinessText) + (row.readiness.status === 'verified' ? ' ' + demoChip() : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderGaps() {
    const result = E.gaps();
    const alerted = result.rows.filter(row => row.noBlood >= 3).sort((a, b) => b.noBlood - a.noBlood)[0];
    $('gapAlert').innerHTML = result.alert
      ? '<div class="msg warn" role="status" aria-live="polite">Demo threshold reached: ' + esc(alerted.facility) + ' has ' + esc(alerted.noBlood) + ' no-blood replies.</div>'
      : '';
    if (!result.rows.length) {
      $('supplyGaps').innerHTML = '<div class="empty">No decline replies yet.</div>';
      return;
    }
    $('supplyGaps').innerHTML = '<div><table aria-label="Supply gaps by decline reason"><thead><tr>' +
      '<th scope="col">Hospital</th><th scope="col">No bed</th><th scope="col">No blood</th><th scope="col">No doctor</th></tr></thead><tbody>' +
      result.rows.map(row => '<tr><td data-label="Hospital">' + esc(row.facility) + '</td><td data-label="No bed">' + esc(row.noBed) +
        '</td><td data-label="No blood">' + esc(row.noBlood) + '</td><td data-label="No doctor">' + esc(row.noDoctor) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  function renderMap() {
    const W = 600, H = 440, P = 18, all = E.facilities;
    const displayWidth = $('mapBox').clientWidth || W;
    const labelSize = 13 * W / displayWidth;
    const labelOffset = 9 * W / displayWidth;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    all.forEach(f => { minLat = Math.min(minLat, f.lat); maxLat = Math.max(maxLat, f.lat); minLng = Math.min(minLng, f.lng); maxLng = Math.max(maxLng, f.lng); });
    const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const sc = Math.min((W - 2 * P) / ((maxLng - minLng) * k || 1), (H - 2 * P) / ((maxLat - minLat) || 1));
    const ox = (W - (maxLng - minLng) * k * sc) / 2, oy = (H - (maxLat - minLat) * sc) / 2;
    const X = f => (ox + (f.lng - minLng) * k * sc).toFixed(1), Y = f => (H - oy - (f.lat - minLat) * sc).toFixed(1);
    const dot = (f, r, fill, extra) => '<circle cx="' + X(f) + '" cy="' + Y(f) + '" r="' + r + '" fill="' + fill + '" ' + (extra || '') + '><title>' + esc(f.name) + '</title></circle>';
    const textLabel = (f, text) => {
      const x = Number(X(f)), y = Number(Y(f)), width = text.length * labelSize * 0.55;
      const anchor = x + labelOffset + width <= W - P ? 'start' :
        x - labelOffset - width >= P ? 'end' : 'middle';
      const labelX = anchor === 'start' ? x + labelOffset : anchor === 'end' ? x - labelOffset : x;
      return '<text x="' + labelX.toFixed(1) + '" y="' + (y - labelOffset).toFixed(1) + '" text-anchor="' + anchor +
        '" font-family="Segoe UI, Arial, sans-serif" font-size="' + labelSize.toFixed(1) +
        '" fill="#0F2A33" stroke="#fff" stroke-width="' + (labelSize / 3).toFixed(1) +
        '" stroke-linejoin="round" paint-order="stroke">' + esc(text) + '</text>';
    };
    let s = '';
    all.filter(f => !f.receiver).forEach(f => { s += dot(f, 2.4, '#9FB3BA'); });
    all.filter(f => f.receiver).forEach(f => { s += dot(f, 4.5, '#0F2A33'); });
    const r = cur();
    if (r) {
      const from = E.fac.get(r.originId);
      r.offers.forEach(o => {
        const f = E.fac.get(o.facId);
        const colour = o.reply === 'ACCEPT' ? '#1E8E5A' : /^NO_/.test(o.reply || '') ? '#C23B2E' : '#0F2A33';
        s += '<line x1="' + X(from) + '" y1="' + Y(from) + '" x2="' + X(f) + '" y2="' + Y(f) + '" stroke="' + colour + '" stroke-width="' + (o.reply === 'ACCEPT' ? 2.5 : 1.2) + '" stroke-dasharray="' + (o.reply === 'ACCEPT' ? '' : '4 3') + '"/>';
      });
      r.offers.forEach(o => {
        const f = E.fac.get(o.facId);
        const colour = o.reply === 'ACCEPT' ? '#1E8E5A' : /^NO_/.test(o.reply || '') ? '#C23B2E' : '#0F2A33';
        s += dot(f, 7, colour, 'stroke="#fff" stroke-width="2"');
        if (o.reply === 'ACCEPT') s += textLabel(f, 'Accepted: ' + f.name);
        else if (/^NO_/.test(o.reply || '')) s += textLabel(f, 'Declined: ' + f.name);
      });
      s += dot(from, 8, '#E8A317', 'stroke="#0F2A33" stroke-width="2"');
      s += textLabel(from, 'Nurse here: ' + from.name);
    }
    $('mapBox').innerHTML = '<svg class="map" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Map of the pilot cluster showing the referring facility, the hospitals asked and their replies">' + s + '</svg>';
  }

  function downloadCsv() {
    const blob = new Blob([E.exportCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'heala-referral-log.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // ---- Drawing -------------------------------------------------------------
  function renderAll() {
    renderLcd(); renderFamilyLcd(); renderPeople(); renderPatientProgress(); renderInboxes(); renderHosp(); renderReadiness(); renderKpis(); renderRefs(); renderDetail();
    renderScorecard(); renderGaps(); renderMap();
  }
  function afterAction() { renderAll(); save(); }

  // ---- Guided demo ---------------------------------------------------------
  function guideNote(text) {
    const g = $('guide');
    g.hidden = !text;
    g.innerHTML = text ? '<b>Guided demo.</b> ' + esc(text) : '';
  }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function resetDemo() {
    clearTimers();
    E = HEALA.create(FACILITIES_RAW);
    E.S.fast = $('fast').checked;
    sess = null; familySess = null; selCode = null; drafts = {};
    guideNote('');
    afterAction();
  }
  function guided() {
    resetDemo();
    const hubOrigin = E.facilities.find(f => f.name === 'Burutu Primary Health Care Center');
    const steps = [
      ['The midwife at Burutu Primary Health Care Center has a mother bleeding after birth. She dials the referral line on a basic phone. No data needed.', () => { if (hubOrigin) $('origin').value = hubOrigin.id; dial('referral'); }],
      ['She chooses "New emergency referral".', () => ussdSend('1')],
      ['Emergency type: bleeding after birth.', () => ussdSend('1')],
      ['Age band: 18 to 35.', () => ussdSend('2')],
      ['Transport: boat.', () => ussdSend('1')],
      ['She types a demo family number. Three hospitals get an SMS at the same time.', () => ussdSend(DEMO_FAMILY_PHONE)],
      ['One hospital replies 3: no blood. The reason is recorded for the dashboard.', () => { const r = cur(); if (r && r.offers[0]) { E.facilityText(r.offers[0].facId, r.code + ' 3'); afterAction(); } }],
      ['The midwife asks other hospitals for blood. Fresh hospitals reporting blood are ranked first; any fallback is marked unverified.', () => { const b = document.querySelector('[data-act="blood-request"]'); if (b) b.click(); }],
      ['A hospital replies BLD <code> 1. Its reply locks the Blood Bridge request.', () => { const r = cur(); const o = r && r.bloodRequest && r.bloodRequest.offers[0]; const b = o && document.querySelector('[data-act="hsms"][data-fac="' + o.facId + '"][data-text="BLD ' + r.code + ' 1"]'); if (b) b.click(); }],
      ['A later hospital also replies yes and receives the short "already taken" message.', () => { const r = cur(); const o = r && r.bloodRequest && r.bloodRequest.offers[1]; const b = o && document.querySelector('[data-act="hsms"][data-fac="' + o.facId + '"][data-text="BLD ' + r.code + ' 1"]'); if (b) b.click(); }],
      ['Another hospital accepts the referral. The patient is directed to the accepting hospital.', () => { const r = cur(); const o = r && r.offers.find(x => x.reply === null); const b = o && document.querySelector('[data-act="hsms"][data-fac="' + o.facId + '"][data-text="' + r.code + ' 1"]'); if (b) b.click(); }],
      ['The patient arrives. The hospital texts ARR with the code.', () => { const r = cur(); if (r && r.acceptedFacId) { E.facilityText(r.acceptedFacId, 'ARR ' + r.code); afterAction(); } }],
      ['The hospital reports the outcome, and the midwife is told. The loop is closed.', () => { const r = cur(); if (r && r.acceptedFacId) { E.facilityText(r.acceptedFacId, 'OUT ' + r.code + ' 1'); afterAction(); } }],
      ['That was a simulation with demo values. Press "Reset demo", then try the referral line yourself.', () => {}]
    ];
    steps.forEach((st, i) => {
      timers.push(setTimeout(() => { guideNote((i + 1) + ' of ' + steps.length + '. ' + st[0]); st[1](); }, i * STEP_MS));
    });
  }

  // ---- Events --------------------------------------------------------------
  function readinessText(id, flip) {
    const rd = E.readiness(id), f = Object.assign({ B: 0, O: 0, D: 0, T: 0, W: 0, N: 0 }, rd.flags || {});
    if (flip) f[flip] = f[flip] ? 0 : 1;
    return 'R B' + f.B + ' O' + f.O + ' D' + f.D + ' T' + f.T + ' W' + f.W + ' N' + f.N;
  }
  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'dial') dial(b.dataset.line);
    else if (a === 'ussd-send') { const i = $('ussdIn'); ussdSend(i ? i.value : ''); }
    else if (a === 'dial-family') dialFamily();
    else if (a === 'family-ussd-send') { const i = $('familyUssdIn'); familySend(i ? i.value : ''); }
    else if (a === 'pick') { selCode = b.dataset.code; afterAction(); }
    else if (a === 'blood-request') { E.bloodRequest(b.dataset.code); afterAction(); }
    else if (a === 'hsms') { E.facilityText(b.dataset.fac, b.dataset.text); afterAction(); }
    else if (a === 'hsend') {
      const i = b.parentElement.querySelector('input'), t = i ? i.value.trim() : '';
      if (t) { E.facilityText(b.dataset.fac, t); drafts[b.dataset.fac] = ''; afterAction(); }
    }
    else if (a === 'cap') { E.facilityText(b.dataset.fac, readinessText(b.dataset.fac, b.dataset.k)); afterAction(); }
    else if (a === 'fresh') { E.facilityText(b.dataset.fac, readinessText(b.dataset.fac)); afterAction(); }
    else if (a === 'stale') { if (E.S.ready[b.dataset.fac]) E.S.ready[b.dataset.fac].at = E.now() - 25 * 3600 * 1000; afterAction(); }
  });
  document.addEventListener('input', ev => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.draft) drafts[t.dataset.draft] = t.value;
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    const t = ev.target;
    if (t && t.id === 'ussdIn') { ev.preventDefault(); ussdSend(t.value); }
    else if (t && t.id === 'familyUssdIn') { ev.preventDefault(); familySend(t.value); }
    else if (t && t.dataset && t.dataset.draft) {
      ev.preventDefault();
      const btn = t.parentElement.querySelector('[data-act="hsend"]');
      if (btn) btn.click();
    }
  });

  // ---- Start ---------------------------------------------------------------
  function init() {
    E = load();
    initRole();
    const g = document.createElement('div');
    g.id = 'guide'; g.className = 'banner'; g.hidden = true; g.setAttribute('role', 'status'); g.setAttribute('aria-live', 'polite');
    const banner = document.querySelector('.banner');
    if (banner) banner.insertAdjacentElement('afterend', g);
    buildOrigin();
    $('fast').checked = E.S.fast;
    $('fast').addEventListener('change', () => { E.S.fast = $('fast').checked; save(); renderDetail(); });
    $('btnGuided').addEventListener('click', guided);
    $('btnReset').addEventListener('click', resetDemo);
    $('btnCsv').addEventListener('click', downloadCsv);
    $('rolePicker').addEventListener('click', ev => {
      const button = ev.target.closest('.role-button');
      if (button) setRole(button.dataset.role, true);
    });
    $('origin').addEventListener('change', renderPeople);
    window.addEventListener('resize', renderMap);
    renderAll();
    setInterval(() => {
      const changed = E.tick();
      if (changed) afterAction();
      else if (cur()) renderDetail();
    }, 1000);
  }
  init();
})();
