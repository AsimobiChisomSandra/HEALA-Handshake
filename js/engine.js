/* HEALA Handshake: engine.
   All logic lives here. This file never touches the DOM or localStorage.
   Simulation only: no real SMS or USSD is sent. */
const HEALA = (function () {
  'use strict';

  // ---- Constants -----------------------------------------------------------
  // needs: B blood, O oxygen, D doctor, T theatre, W newborn unit
  const EM = {
    PPH:          { label: 'Bleeding after birth (PPH)',    short: 'PPH',               needs: ['B', 'T'] },
    ECLAMPSIA:    { label: 'Fits in pregnancy (eclampsia)', short: 'ECLAMPSIA',         needs: ['D'] },
    OBSTRUCTED:   { label: 'Long or obstructed labour',     short: 'OBSTRUCTED LABOUR', needs: ['T'] },
    NEWBORN:      { label: 'Sick newborn',                  short: 'SICK NEWBORN',      needs: ['W', 'O'] },
    CHILD_DANGER: { label: 'Child danger sign',             short: 'CHILD DANGER SIGN', needs: ['O'] },
    TRAUMA:       { label: 'Injury or trauma',              short: 'TRAUMA',            needs: ['T', 'B'] }
  };
  const EM_KEYS = Object.keys(EM);
  const TRANSPORTS = ['BOAT', 'ROAD', 'SAVEMAMA'];
  const TRANSPORT_WORD = { BOAT: 'boat', ROAD: 'road', SAVEMAMA: 'SAVEMAMA' };
  const AGES = ['<18', '18-35', '>35', 'Child <5'];
  const AGE_SMS = ['woman <18', 'woman 18-35', 'woman >35', 'child <5'];
  const SPEED = { BOAT: 25, ROAD: 40, SAVEMAMA: 40 }; // km/h estimates
  const CAP_LABEL = { B: 'Blood', O: 'Oxygen', D: 'Doctor', T: 'Theatre', W: 'Newborn unit', N: 'Free beds' };
  const REPLY_REASON = { 1: 'ACCEPT', 2: 'NO_BED', 3: 'NO_BLOOD', 4: 'NO_DOCTOR' };
  const OUTCOME = { 1: 'STABLE', 2: 'TRANSFERRED', 3: 'DIED', 4: 'STILL_ADMITTED' };
  const OUTCOME_SMS = { 1: 'is STABLE', 2: 'was TRANSFERRED', 3: 'has DIED. We are sorry', 4: 'is STILL ADMITTED' };
  const HOUR = 3600000;
  const FRESH_MS = 24 * HOUR;
  const ESCALATE_MS = 5 * 60 * 1000;
  const ESCALATE_FAST_MS = 30 * 1000;
  const MAX_WAVES = 4;
  const WAVE_SIZE = 3;
  // DEMO VALUES: capabilities of the five demo hospitals, shown as updated 2 hours ago.
  const DEMO_HUBS = {
    'Warri Central Hospital':        { B: 1, O: 1, D: 1, T: 1, W: 1, N: 3 },
    'Ekpan General Hospital':        { B: 0, O: 1, D: 1, T: 1, W: 0, N: 2 },
    'Ogbe Ijoh General Hospital':    { B: 0, O: 1, D: 1, T: 0, W: 0, N: 1 },
    'Burutu Government Hospital':    { B: 0, O: 0, D: 1, T: 0, W: 0, N: 2 },
    'Bomadi Bomadi General Hospital': { B: 0, O: 1, D: 1, T: 0, W: 1, N: 2 }
  };
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // ---- Helpers -------------------------------------------------------------
  function haversine(a, b) {
    const R = 6371, k = Math.PI / 180;
    const dLat = (b.lat - a.lat) * k, dLng = (b.lng - a.lng) * k;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function nm(name, max) {
    name = String(name || '');
    return name.length > max ? name.slice(0, max - 1).trim() + '.' : name;
  }
  function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }
  function validPhone(p) {
    return /^(\+?234|0)[789]\d{9}$/.test(String(p || '').replace(/[\s-]/g, ''));
  }

  // Parses an incoming SMS. Keywords: CODE 1-4, BLD CODE 1-2, ARR CODE, OUT CODE 1-4, R B1 O1 D1 T1 W1 N3.
  function parseSms(text) {
    const t = String(text || '').trim().toUpperCase().replace(/\s+/g, ' ');
    let m;
    if ((m = t.match(/^BLD ([A-Z0-9]{4}) ([1-2])$/))) return { type: 'BLD', code: m[1], n: +m[2] };
    if ((m = t.match(/^ARR ([A-Z0-9]{4})$/))) return { type: 'ARR', code: m[1] };
    if ((m = t.match(/^OUT ([A-Z0-9]{4}) ([1-4])$/))) return { type: 'OUT', code: m[1], n: +m[2] };
    if ((m = t.match(/^([A-Z0-9]{4}) ([1-4])$/))) return { type: 'REPLY', code: m[1], n: +m[2] };
    if (/^R( [BODTWN]\d{1,3})+$/.test(t)) {
      const flags = {};
      let ok = true;
      t.slice(2).split(' ').forEach(tok => {
        const k = tok[0], v = +tok.slice(1);
        if (k !== 'N' && v !== 0 && v !== 1) ok = false;
        flags[k] = v;
      });
      if (ok) return { type: 'READINESS', flags };
    }
    return { type: 'UNKNOWN' };
  }

  // ---- Engine factory ------------------------------------------------------
  function create(raw, opts) {
    opts = opts || {};
    const now = opts.now || (() => Date.now());

    // Registry data. nhfr_uid is not unique in the extract, so ids come from row order.
    const facilities = raw.map((r, i) => ({
      id: 'F' + i, uid: r.uid, name: r.name, lga: r.lga, ward: r.ward, level: r.level,
      ownership: r.own, lat: r.lat, lng: r.lng,
      receiver: r.level === 'Secondary' || r.level === 'Tertiary'
    }));
    const fac = new Map(facilities.map(f => [f.id, f]));
    const receivers = facilities.filter(f => f.receiver);

    const S = opts.state || { referrals: [], inbox: {}, phoneInbox: {}, ready: {}, fast: false };
    S.referrals = S.referrals || [];
    S.inbox = S.inbox || {};
    S.phoneInbox = S.phoneInbox || {};
    S.ready = S.ready || {};
    S.fast = !!S.fast;
    if (!opts.state) {
      facilities.forEach(f => {
        const d = DEMO_HUBS[f.name];
        if (d && f.receiver) S.ready[f.id] = Object.assign({ at: now() - 2 * HOUR }, d);
      });
    }

    // ---- Messaging (simulated inboxes) ----
    function sendFac(facId, text, kind, dir) {
      (S.inbox[facId] = S.inbox[facId] || []).push({ text, at: now(), kind: kind || '', dir: dir || 'in' });
    }
    function sendPhone(phone, text, kind, dir) {
      if (!phone) return;
      (S.phoneInbox[phone] = S.phoneInbox[phone] || []).push({ text, at: now(), kind: kind || '', dir: dir || 'in' });
    }
    function event(r, text) { r.events.push({ at: now(), text }); }

    // ---- Readiness ----
    function isFresh(facId) {
      const x = S.ready[facId];
      return !!x && now() - x.at < FRESH_MS;
    }
    function meets(facId, need) {
      const x = S.ready[facId];
      return !!x && need.every(k => x[k] === 1);
    }
    function readiness(facId) {
      const x = S.ready[facId];
      if (!x) return { known: false, fresh: false, hoursAgo: null, flags: null };
      return { known: true, fresh: isFresh(facId), hoursAgo: (now() - x.at) / HOUR, flags: { B: x.B, O: x.O, D: x.D, T: x.T, W: x.W, N: x.N } };
    }

    // ---- Matching ----
    function byCode(code) {
      const c = String(code || '').toUpperCase();
      return S.referrals.find(r => r.code === c) || null;
    }
    function newCode() {
      for (let n = 0; n < 2000; n++) {
        let c = '';
        for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        if (!byCode(c)) return c;
      }
      throw new Error('could not make a unique code');
    }
    // Verified (fresh and capable) first, then unverified (no fresh update). Fresh but incapable are left out.
    function nextCandidates(r) {
      const origin = fac.get(r.originId), asked = new Set(r.offers.map(o => o.facId));
      const need = EM[r.emergency].needs, ver = [], unv = [];
      receivers.forEach(f => {
        if (f.id === origin.id || asked.has(f.id)) return;
        const d = haversine(origin, f);
        if (isFresh(f.id)) { if (meets(f.id, need)) ver.push({ f, d, verified: true }); }
        else unv.push({ f, d, verified: false });
      });
      const byD = (a, b) => a.d - b.d;
      return ver.sort(byD).concat(unv.sort(byD));
    }

    // ---- Message templates (each 160 characters or fewer) ----
    function offerText(r, f, eta) {
      const origin = nm(fac.get(r.originId).name, 30);
      return 'HEALA REF ' + r.code + ': ' + EM[r.emergency].short + ', ' + AGE_SMS[r.ageIdx] + ', from ' + origin + ', ' +
        TRANSPORT_WORD[r.transport] + ' ~' + eta + 'min. Reply ' + r.code + ' 1=ACCEPT 2=NO BED 3=NO BLOOD 4=NO DOCTOR';
    }
    function releasedText(r) { return 'HEALA ' + r.code + ' now accepted elsewhere. Thank you. No action needed.'; }

    function sendWave(r) {
      const c = nextCandidates(r).slice(0, WAVE_SIZE);
      if (!c.length) return 0;
      r.wave++;
      r.waveAt = now();
      c.forEach(x => {
        const eta = Math.max(1, Math.round(x.d / SPEED[r.transport] * 60));
        r.offers.push({ facId: x.f.id, wave: r.wave, verified: x.verified, dist: x.d, eta, sentAt: now(), reply: null, repliedAt: null });
        sendFac(x.f.id, offerText(r, x.f, eta), 'warn');
      });
      event(r, 'Wave ' + r.wave + ' sent to ' + c.map(x => x.f.name + (x.verified ? '' : ' (unverified)')).join(', '));
      return c.length;
    }
    function markUnmatched(r) {
      r.status = 'UNMATCHED';
      r.offers.forEach(o => { if (o.reply === null) { o.reply = 'EXPIRED'; o.repliedAt = now(); } });
      sendPhone(r.referrerPhone, 'HEALA ' + r.code + ': no hospital accepted after ' + r.wave +
        ' rounds. Call 112 now. Take the patient to the nearest hospital and show this code.', 'bad');
      event(r, 'No hospital accepted after ' + r.wave + ' waves. Referrer told to call 112.');
      return true;
    }
    function escalate(r) {
      if (r.status !== 'SEEKING') return false;
      if (r.wave >= MAX_WAVES) return markUnmatched(r);
      const n = sendWave(r);
      if (!n) return markUnmatched(r);
      r.escalated = true;
      sendPhone(r.referrerPhone, 'HEALA ' + r.code + ': no hospital has accepted yet. Trying ' + n +
        ' more. If the patient is worsening, call 112.', 'warn');
      return true;
    }

    // ---- Referral lifecycle ----
    function createReferral(o) {
      if (!EM[o.emergency]) throw new Error('unknown emergency: ' + o.emergency);
      if (!fac.get(o.originId)) throw new Error('unknown origin facility');
      const t = now();
      const r = {
        code: newCode(), originId: o.originId, emergency: o.emergency,
        ageIdx: o.ageIdx == null ? 1 : o.ageIdx, transport: TRANSPORTS.includes(o.transport) ? o.transport : 'ROAD',
        referrerPhone: o.referrerPhone || '', familyPhone: o.familyPhone || '',
        status: 'SEEKING', wave: 0, escalated: false,
        createdAt: t, waveAt: t, acceptedAt: null, arrivedAt: null, outcomeAt: null,
        acceptedFacId: null, outcome: null, offers: [], bloodRequest: null, events: []
      };
      S.referrals.push(r);
      event(r, 'Referral created: ' + EM[r.emergency].label + ' from ' + fac.get(r.originId).name);
      if (!sendWave(r)) markUnmatched(r);
      return r;
    }

    function bloodRequest(refCode) {
      const r = byCode(refCode);
      if (!r) return null;
      if (r.bloodRequest) return r.bloodRequest;
      const declined = r.offers.slice().reverse().find(o => o.reply === 'NO_BLOOD');
      if (!declined) return null;

      const origin = fac.get(r.originId);
      const candidates = receivers
        .filter(f => f.id !== declined.facId)
        .map(f => ({ f, d: haversine(origin, f), fresh: isFresh(f.id) }))
        .filter(x => x.fresh ? S.ready[x.f.id].B === 1 : true);
      const verified = candidates.filter(x => x.fresh)
        .sort((a, b) => a.d - b.d)
        .map(x => ({ f: x.f, d: x.d, verified: true }));
      const unverified = candidates.filter(x => !x.fresh)
        .sort((a, b) => a.d - b.d)
        .map(x => ({ f: x.f, d: x.d, verified: false }));
      const chosen = verified.concat(unverified).slice(0, WAVE_SIZE);
      const request = {
        requestedAt: now(), declinedFacId: declined.facId,
        acceptedFacId: null, acceptedAt: null, offers: []
      };
      r.bloodRequest = request;
      event(r, 'Blood Bridge requested after ' + fac.get(declined.facId).name + ' declined for no blood.');
      if (!chosen.length) {
        event(r, 'Blood Bridge found no eligible hospitals to ask.');
        return request;
      }

      chosen.forEach(x => {
        const offer = { facId: x.f.id, dist: x.d, verified: x.verified, sentAt: now(), reply: null, repliedAt: null };
        request.offers.push(offer);
        const prefix = 'HEALA BLOOD ' + r.code + ': ';
        const suffix = ' needs blood for a patient. Can you supply? Reply BLD ' + r.code + ' 1=yes 2=no';
        const facility = nm(x.f.name, Math.max(1, 160 - prefix.length - suffix.length));
        sendFac(x.f.id, prefix + facility + suffix, 'warn');
        event(r, 'Blood Bridge SMS sent to ' + x.f.name + (x.verified ? ' (verified).' : ' (unverified).'));
      });
      return request;
    }

    function bloodReply(r, facId, n) {
      const request = r.bloodRequest;
      const f = fac.get(facId);
      const offer = request && request.offers.find(x => x.facId === facId);
      if (!offer) {
        sendFac(facId, 'HEALA BLOOD ' + r.code + ': no blood request was sent to you.', 'bad');
        event(r, f.name + ' replied to a Blood Bridge request they were not sent.');
        return { ok: false };
      }
      if (request.acceptedFacId) {
        sendFac(facId, 'HEALA BLOOD ' + r.code + ': already taken.', 'warn');
        event(r, f.name + ' replied to Blood Bridge after it was already taken.');
        return { ok: false };
      }
      if (offer.reply !== null) {
        sendFac(facId, 'HEALA BLOOD ' + r.code + ': your reply is already recorded.', 'warn');
        event(r, f.name + ' repeated a Blood Bridge reply.');
        return { ok: false };
      }

      offer.reply = n === 1 ? 'YES' : 'NO';
      offer.repliedAt = now();
      event(r, 'Blood Bridge: ' + f.name + ' replied ' + (n === 1 ? 'yes' : 'no') + '.');
      if (n === 1) {
        request.acceptedFacId = facId;
        request.acceptedAt = now();
        event(r, 'Blood Bridge locked to ' + f.name + '.');
        sendFac(facId, 'HEALA BLOOD ' + r.code + ': thank you. Request locked to your hospital.', 'good');
      } else {
        sendFac(facId, 'HEALA BLOOD ' + r.code + ': reply recorded. Thank you.', 'good');
      }
      return { ok: true };
    }

    function facilityText(facId, text) {
      const f = fac.get(facId);
      if (!f) return { ok: false };
      sendFac(facId, String(text), '', 'out');
      const p = parseSms(text);

      if (p.type === 'READINESS') {
        const prev = S.ready[facId] || { B: 0, O: 0, D: 0, T: 0, W: 0, N: 0 };
        const next = { B: prev.B, O: prev.O, D: prev.D, T: prev.T, W: prev.W, N: prev.N, at: now() };
        Object.keys(p.flags).forEach(k => { next[k] = p.flags[k]; });
        S.ready[facId] = next;
        sendFac(facId, 'HEALA: readiness saved. B' + next.B + ' O' + next.O + ' D' + next.D + ' T' + next.T + ' W' + next.W + ' N' + next.N + '. Thank you.', 'good');
        return { ok: true };
      }
      if (p.type === 'UNKNOWN') {
        sendFac(facId, 'HEALA: not understood. Reply CODE 1-4, BLD CODE 1-2, ARR CODE, OUT CODE 1-4 or R B1 O1 D1 T1 W1 N3.', 'bad');
        return { ok: false };
      }

      const r = byCode(p.code);
      if (!r) { sendFac(facId, 'HEALA: code ' + p.code + ' not found. Check the code and try again.', 'bad'); return { ok: false }; }
      if (p.type === 'BLD') return bloodReply(r, facId, p.n);
      const offer = r.offers.find(x => x.facId === facId);
      if (!offer) { sendFac(facId, 'HEALA ' + r.code + ': this referral was not sent to you. No action needed.', 'bad'); return { ok: false }; }

      if (p.type === 'REPLY') {
        if (offer.reply !== null) {
          if (offer.reply === 'RELEASED') sendFac(facId, releasedText(r), 'warn');
          else sendFac(facId, 'HEALA ' + r.code + ': your reply is already recorded.', 'warn');
          return { ok: false };
        }
        offer.reply = REPLY_REASON[p.n];
        offer.repliedAt = now();
        if (p.n === 1) return accept(r, offer, f);
        event(r, f.name + ' declined: ' + offer.reply.replace('_', ' ').toLowerCase());
        sendFac(facId, 'HEALA ' + r.code + ': reply recorded. Thank you.', 'good');
        if (r.status === 'SEEKING' && !r.offers.some(x => x.reply === null)) escalate(r);
        return { ok: true };
      }

      if (p.type === 'ARR') {
        if (r.acceptedFacId !== facId) { sendFac(facId, 'HEALA ' + r.code + ': only the accepting hospital can confirm arrival.', 'bad'); return { ok: false }; }
        if (r.status !== 'ACCEPTED') { sendFac(facId, 'HEALA ' + r.code + ': arrival is already recorded.', 'warn'); return { ok: false }; }
        r.status = 'ARRIVED';
        r.arrivedAt = now();
        event(r, 'Patient arrived at ' + f.name);
        sendPhone(r.referrerPhone, 'HEALA ' + r.code + ': patient ARRIVED at ' + nm(f.name, 50) + '.', 'good');
        sendFac(facId, 'HEALA ' + r.code + ': arrival recorded. After 24h reply OUT ' + r.code + ' 1=stable 2=transferred 3=died 4=still admitted', 'good');
        return { ok: true };
      }

      if (p.type === 'OUT') {
        if (r.acceptedFacId !== facId) { sendFac(facId, 'HEALA ' + r.code + ': only the accepting hospital can report the outcome.', 'bad'); return { ok: false }; }
        if (r.status === 'CLOSED') { sendFac(facId, 'HEALA ' + r.code + ': outcome is already recorded.', 'warn'); return { ok: false }; }
        if (r.status !== 'ARRIVED') { sendFac(facId, 'HEALA ' + r.code + ': confirm arrival first. Reply ARR ' + r.code, 'warn'); return { ok: false }; }
        r.status = 'CLOSED';
        r.outcome = OUTCOME[p.n];
        r.outcomeAt = now();
        event(r, 'Outcome: ' + r.outcome.replace('_', ' ').toLowerCase());
        sendPhone(r.referrerPhone, 'HEALA ' + r.code + ' update from ' + nm(f.name, 40) + ': patient ' + OUTCOME_SMS[p.n] + '. Thank you for referring.', p.n === 3 ? 'bad' : 'good');
        sendFac(facId, 'HEALA ' + r.code + ': outcome recorded. Thank you.', 'good');
        return { ok: true };
      }
      return { ok: false };
    }

    // First ACCEPT locks the referral; every other pending offer is released.
    function accept(r, offer, f) {
      if (r.status !== 'SEEKING') { sendFac(offer.facId, releasedText(r), 'warn'); return { ok: false }; }
      r.status = 'ACCEPTED';
      r.acceptedFacId = f.id;
      r.acceptedAt = now();
      event(r, f.name + ' ACCEPTED. Referral locked.');
      r.offers.forEach(x => {
        if (x !== offer && x.reply === null) {
          x.reply = 'RELEASED';
          x.repliedAt = now();
          sendFac(x.facId, releasedText(r), 'warn');
        }
      });
      sendFac(f.id, 'HEALA ' + r.code + ': you are confirmed. Reply ARR ' + r.code + ' when the patient arrives.', 'good');
      sendPhone(r.referrerPhone, 'ACCEPTED: ' + nm(f.name, 44) + '. Code ' + r.code + '. Send patient now. Hospital has been alerted.', 'good');
      sendPhone(r.familyPhone, 'HEALA ' + r.code + ': Go to ' + nm(f.name, 32) + ', show code ' + r.code +
        '. By law emergency care cannot be refused. Pregnant or under 5? Ask about free care.', 'good');
      return { ok: true };
    }

    // Escalates any referral that has waited too long. Returns true if anything changed.
    function tick() {
      let changed = false;
      const limit = S.fast ? ESCALATE_FAST_MS : ESCALATE_MS;
      S.referrals.forEach(r => {
        if (r.status === 'SEEKING' && now() - r.waveAt >= limit) { if (escalate(r)) changed = true; }
      });
      return changed;
    }

    // ---- USSD: health worker referral line ----
    const CON = text => ({ type: 'CON', text }), END = text => ({ type: 'END', text });
    function ussdReferral(phone, text, originId) {
      const t = String(text == null ? '' : text);
      if (t === '') return CON('HEALA Referral\n1. New emergency referral\n2. Check a referral');
      const p = t.split('*');
      if (p[0] === '1') {
        if (p.length === 1) return CON('Emergency type:\n1. Bleeding after birth (PPH)\n2. Fits in pregnancy (eclampsia)\n3. Long/obstructed labour\n4. Sick newborn\n5. Child danger sign\n6. Injury/trauma');
        if (!/^[1-6]$/.test(p[1])) return END('Invalid choice. Please dial again.');
        if (p.length === 2) return CON('Age band:\n1. <18\n2. 18-35\n3. >35\n4. Child <5');
        if (!/^[1-4]$/.test(p[2])) return END('Invalid choice. Please dial again.');
        if (p.length === 3) return CON('Transport:\n1. Boat\n2. Road\n3. Request SAVEMAMA (3581)');
        if (!/^[1-3]$/.test(p[3])) return END('Invalid choice. Please dial again.');
        if (p.length === 4) return CON('Family phone number (or 0 to skip):');
        const ph = p[4].replace(/[\s-]/g, '');
        if (ph !== '0' && !validPhone(ph)) return END('That phone number is not valid. Please dial again.');
        const r = createReferral({
          originId, emergency: EM_KEYS[+p[1] - 1], ageIdx: +p[2] - 1, transport: TRANSPORTS[+p[3] - 1],
          referrerPhone: phone, familyPhone: ph === '0' ? '' : ph
        });
        if (r.status === 'UNMATCHED') return END('Referral ' + r.code + ' could not find a hospital. Call 112 now.');
        return END('Referral ' + r.code + ' sent to ' + r.offers.length + ' hospitals. You will get an SMS when one accepts. Keep this code.');
      }
      if (p[0] === '2') {
        if (p.length === 1) return CON('Enter referral code:');
        const r = byCode(p[1]);
        if (!r) return END('Code not found. Check it and dial again.');
        if (r.status === 'SEEKING') return END('Waiting for a hospital to accept. Round ' + r.wave + ' of ' + MAX_WAVES + '. Code ' + r.code + '.');
        if (r.status === 'UNMATCHED') return END('No hospital accepted. Call 112 and go to the nearest hospital. Code ' + r.code + '.');
        const name = nm(fac.get(r.acceptedFacId).name, 44);
        if (r.status === 'ACCEPTED') return END('ACCEPTED: ' + name + '. Send the patient now. Code ' + r.code + '.');
        if (r.status === 'ARRIVED') return END('Patient ARRIVED at ' + name + '. Code ' + r.code + '.');
        return END('Referral closed at ' + name + '. Outcome: ' + String(r.outcome).replace('_', ' ').toLowerCase() + '.');
      }
      return END('Invalid choice. Please dial again.');
    }

    // ---- USSD: family Go-Now line (rule-based, no diagnosis) ----
    function ussdGoNow(text) {
      const t = String(text == null ? '' : text);
      if (t === '') return CON('HEALA Go-Now. Is the sick person:\n1. Pregnant or just delivered\n2. A child under 5');
      const p = t.split('*');
      if (p[0] !== '1' && p[0] !== '2') return END('Invalid choice. Please dial again.');
      if (p.length === 1) {
        return p[0] === '1'
          ? CON('Any of these now? 1 Yes 2 No\nBleeding from vagina, fits, bad headache with blurry eyes, fever too weak to stand, bad belly pain, hard breathing')
          : CON('Any of these now? 1 Yes 2 No\nCannot drink or breastfeed, vomits everything, fits, very sleepy or cannot be woken');
      }
      if (p.length === 2 && p[1] === '1') {
        return p[0] === '1'
          ? END('GO NOW. Do not wait for morning. Go to the nearest health facility or call 112. SAVEMAMA 3581 can send transport.')
          : END('GO NOW. Do not wait for morning. Take the child to the nearest health facility or call 112.');
      }
      if (p.length === 2 && p[1] === '2') return END('No danger sign now. If any sign starts, dial again. Visit your health centre today.');
      return END('Invalid choice. Please dial again.');
    }

    // ---- Dashboard numbers ----
    function metrics() {
      const R = S.referrals, acc = R.filter(r => r.acceptedAt != null), arr = R.filter(r => r.arrivedAt != null);
      return {
        total: R.length,
        open: R.filter(r => r.status === 'SEEKING').length,
        accepted: acc.length,
        arrived: arr.length,
        closed: R.filter(r => r.status === 'CLOSED').length,
        unmatched: R.filter(r => r.status === 'UNMATCHED').length,
        medianAcceptMs: median(acc.map(r => r.acceptedAt - r.createdAt)),
        medianArrivalMs: median(arr.map(r => r.arrivedAt - r.acceptedAt))
      };
    }

    function scorecard() {
      const rows = new Map();
      S.referrals.forEach(r => {
        r.offers.forEach(o => {
          let row = rows.get(o.facId);
          if (!row) {
            const f = fac.get(o.facId);
            row = {
              facilityId: o.facId, facility: f.name, timesAsked: 0, accepted: 0,
              declinedNoBed: 0, declinedNoBlood: 0, declinedNoDoctor: 0, acceptTimesMs: []
            };
            rows.set(o.facId, row);
          }
          row.timesAsked++;
          if (o.reply === 'ACCEPT') {
            row.accepted++;
            if (o.repliedAt != null && o.sentAt != null) row.acceptTimesMs.push(o.repliedAt - o.sentAt);
          } else if (o.reply === 'NO_BED') row.declinedNoBed++;
          else if (o.reply === 'NO_BLOOD') row.declinedNoBlood++;
          else if (o.reply === 'NO_DOCTOR') row.declinedNoDoctor++;
        });
      });
      return Array.from(rows.values()).map(row => {
        const rd = readiness(row.facilityId);
        const medianAcceptMs = median(row.acceptTimesMs);
        return {
          facilityId: row.facilityId,
          facility: row.facility,
          timesAsked: row.timesAsked,
          accepted: row.accepted,
          declinedNoBed: row.declinedNoBed,
          declinedNoBlood: row.declinedNoBlood,
          declinedNoDoctor: row.declinedNoDoctor,
          acceptanceRate: Math.round(row.accepted / row.timesAsked * 1000) / 10,
          medianMinutesToAccept: medianAcceptMs == null ? null : medianAcceptMs / 60000,
          readiness: rd.fresh ? { status: 'verified', hoursSinceUpdate: rd.hoursAgo } : { status: 'unverified' }
        };
      }).sort((a, b) => a.facility.localeCompare(b.facility));
    }

    function gaps() {
      const counts = new Map();
      S.referrals.forEach(r => {
        r.offers.forEach(o => {
          if (o.reply !== 'NO_BED' && o.reply !== 'NO_BLOOD' && o.reply !== 'NO_DOCTOR') return;
          let row = counts.get(o.facId);
          if (!row) {
            const f = fac.get(o.facId);
            row = { facilityId: o.facId, facility: f.name, noBed: 0, noBlood: 0, noDoctor: 0 };
            counts.set(o.facId, row);
          }
          if (o.reply === 'NO_BED') row.noBed++;
          else if (o.reply === 'NO_BLOOD') row.noBlood++;
          else row.noDoctor++;
        });
      });
      const rows = Array.from(counts.values()).sort((a, b) => a.facility.localeCompare(b.facility));
      return { rows, alert: rows.some(row => row.noBlood >= 3) };
    }

    function exportCsv() {
      const header = [
        'code', 'created_at', 'origin_facility', 'lga', 'emergency', 'age_band',
        'transport', 'status', 'waves', 'hospitals_asked', 'accepted_facility',
        'minutes_to_accept', 'minutes_accept_to_arrival', 'outcome'
      ];
      const csvCell = value => {
        const text = value == null ? '' : String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      };
      const rows = S.referrals.map(r => {
        const origin = fac.get(r.originId);
        const accepted = r.acceptedFacId ? fac.get(r.acceptedFacId) : null;
        const asked = r.offers.map(o => fac.get(o.facId).name).join('; ');
        const minutes = ms => ms == null ? '' : Math.round(ms / 600) / 100;
        return [
          r.code, new Date(r.createdAt).toISOString(), origin.name, origin.lga,
          r.emergency, AGES[r.ageIdx], r.transport, r.status, r.wave, asked,
          accepted ? accepted.name : '',
          minutes(r.acceptedAt == null ? null : r.acceptedAt - r.createdAt),
          minutes(r.arrivedAt == null || r.acceptedAt == null ? null : r.arrivedAt - r.acceptedAt),
          r.outcome
        ];
      });
      return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    }

    return {
      S, now, facilities, fac, receivers,
      createReferral, bloodRequest, facilityText, tick, isFresh, readiness, byCode, metrics, scorecard, gaps, exportCsv,
      ussdReferral, ussdGoNow, nextCandidates
    };
  }

  return {
    create, parseSms, haversine, validPhone,
    EM, EM_KEYS, TRANSPORTS, AGES, CAP_LABEL, REPLY_REASON, OUTCOME, DEMO_HUBS,
    MAX_WAVES, WAVE_SIZE
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HEALA;
