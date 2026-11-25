/* Fantacrusco Gestionale · applicazione web (Supabase + Vercel)
   Le regole che contano (blocco dei giocatori, cambi, penalità) sono applicate dal database con l'ora del server:
   vedi supabase/01_schema.sql, funzione submit_formation. Qui c'è l'interfaccia e il calcolo dei punteggi. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1/+esm';
import { SUPABASE_URL, SUPABASE_KEY, EMAIL_DOMAIN } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ======================= REGOLE ======================= */
const PEN = [0, 0.5, 1, 1.5, 2, 3];            // penalità totale cambi: 1..5 cambi
const MAX_CAMBI = 5, PEN_MODULO = 1, MAX_SOST_AUTO = 5, PANCHINA = 12, DURATA_PARTITA = 115;
const REND = [0, 0, 0, 0, 0, 0, 0.5, 1, 1.5, 2, 3, 4];                       // titolari con voto da 6 in su
const CAPT = [[6.5, 0.5], [7, 1.5], [7.5, 2.5], [8, 3], [8.5, 3.5], [9, 4]];  // voto del capitano
const capBonus = v => { let b = 0; for (const [s, x] of CAPT) if (v >= s) b = x; return b; };
const CAMPO = 2, FAIRPLAY = 1.5;
const BONUS = {   // [portiere, movimento], usati solo se il file dei voti non ha il fantavoto
  gol: [3, 3], rigori: [2, 2], gol_vittoria: [2.5, 1.5], gol_pareggio: [1, 1], assist: [2, 1], assist_soft: [2, 0.5], assist_gold: [2.5, 1.5],
  potm: [1, 1], gol_subiti: [-1, -1], porta_inviolata: [1, 0], rig_parati: [3, 3], rig_sbagliati: [-3, -3], autogol: [-3, -2], amm: [-0.5, -0.5], esp: [-2, -2],
};
const BONUS_NOMI = { gol: 'gol segnato', rigori: 'rigore segnato', gol_vittoria: 'gol della vittoria', gol_pareggio: 'gol del pareggio', assist: 'assist', assist_soft: 'assist soft', assist_gold: 'assist gold',
  potm: 'player of the match', gol_subiti: 'gol subito', porta_inviolata: 'porta inviolata', rig_parati: 'rigore parato', rig_sbagliati: 'rigore sbagliato', autogol: 'autogol', amm: 'ammonizione', esp: 'espulsione' };

/* ======================= STATO ======================= */
let SESSION = null, PROF = null;
let D = null;          // dati caricati dal database
let S = { view: 'form', presTeam: null, roseTeam: null, calG: null, puntiMatch: null, rend: 'ge6', msg: null, draft: null, nuovaCred: null, delPending: null, saveRes: false, votiTxt: null, saTxt: null };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const fmtN = x => (Math.round(x * 100) / 100).toLocaleString('it-IT', { maximumFractionDigits: 2 });
const fmtT = ms => new Date(ms).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtH = ms => new Date(ms).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const golDa = p => p < 66 ? 0 : Math.floor((p - 66) / 6) + 1;
const penCambi = n => PEN[Math.min(n, MAX_CAMBI)];
const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z"/></svg>';
const isAdmin = () => PROF && PROF.role === 'admin';
const teamTk = () => isAdmin() ? S.presTeam : PROF.team_k;
const canEdit = () => PROF && PROF.role === 'team';
const fb = m => m ? `<div class="feedback ${m.k}">${esc(m.m)}${m.l ? '<ul>' + m.l.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}</div>` : '';
const chips = roles => roles.length ? roles.map(r => `<span class="chip ${r}">${r}</span>`).join('') : '<span class="pill bad">ruolo?</span>';
const inputStyle = 'font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)';

/* ======================= CARICAMENTO DATI ======================= */
async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
async function load() {
  const [teams, players, modules, lm, settings] = await Promise.all([
    q(sb.from('teams').select('*')), q(sb.from('players').select('*')), q(sb.from('modules').select('*').order('slot')),
    q(sb.from('league_matches').select('*').order('giornata').order('idx')), q(sb.from('settings').select('*')),
  ]);
  const G = Number((settings.find(x => x.key === 'giornata_corrente') || { value: 1 }).value);
  const SA = (lm.find(m => m.giornata === G) || {}).serie_a;
  const [sam, forms, bases, rs, log, votes] = await Promise.all([
    q(sb.from('serie_a_matches').select('*').eq('serie_a', SA ?? -1).order('kickoff')),
    q(sb.from('formations').select('*').eq('giornata', G)), q(sb.from('baselines').select('*').eq('giornata', G)),
    q(sb.from('round_state').select('*').eq('giornata', G)), q(sb.from('changes_log').select('*').eq('giornata', G).order('id', { ascending: false })),
    q(sb.from('votes').select('*').eq('giornata', G)),
  ]);
  const profiles = isAdmin() ? await q(sb.from('profiles').select('*')) : [];
  const TEAMS = teams.sort((a, b) => a.nome.localeCompare(b.nome)).map(t => ({ k: t.k, nome: t.nome }));
  const TN = Object.fromEntries(TEAMS.map(t => [t.k, t.nome])), KN = Object.fromEntries(TEAMS.map(t => [t.nome, t.k]));
  const P = {}, ROSA = {};
  for (const t of TEAMS) ROSA[t.k] = [];
  for (const p of players.sort((a, b) => (b.costo || 0) - (a.costo || 0))) { P[p.id] = { ...p, ruoli: p.ruoli || [] }; ROSA[p.team_k]?.push(p.id); }
  const MODULI = {};
  for (const m of modules) { (MODULI[m.nome] ||= { s: [], righe: [] }); MODULI[m.nome].s[m.slot] = m.ruoli.join('|'); MODULI[m.nome].righe[m.slot] = m.riga; }
  for (const m of Object.values(MODULI)) { m.lines = []; m.righe.forEach(r => { m.lines[r] = (m.lines[r] || 0) + 1; }); }
  const CAL = []; for (const m of lm) { let c = CAL.find(x => x.g === m.giornata); if (!c) CAL.push(c = { g: m.giornata, sa: m.serie_a, ms: [] }); c.ms.push({ casa: m.casa, ospite: m.ospite, pc: m.punti_casa === null ? null : Number(m.punti_casa), po: m.punti_ospite === null ? null : Number(m.punti_ospite), ris: m.risultato, idx: m.idx }); }
  const MATCHES = sam.map(m => ({ casa: m.casa, ospite: m.ospite, t: new Date(m.kickoff).getTime() }));
  const V = {}; for (const v of votes) V[v.nome] = { voto: v.voto === null ? null : Number(v.voto), fv: v.fantavoto === null ? null : Number(v.fantavoto), amm: v.amm, esp: v.esp };
  D = { G, SA, TEAMS, TN, KN, P, ROSA, MODULI, CAL, MATCHES, FIRST: MATCHES.length ? Math.min(...MATCHES.map(m => m.t)) : null,
    FORM: Object.fromEntries(forms.map(f => [f.team_k, { ...f.data, sentAt: f.sent_at }])), BASE: Object.fromEntries(bases.map(b => [b.team_k, b.data])),
    CAMBI: Object.fromEntries(rs.map(r => [r.team_k, r.cambi])), LOG: log, V, nVoti: votes.length, PROFILES: profiles, settings };
  if (!S.presTeam) S.presTeam = PROF.team_k || TEAMS[0].k;
  if (!S.roseTeam) S.roseTeam = PROF.team_k || TEAMS[0].k;
  if (!S.calG) S.calG = Math.max(1, G - 1);
  if (canEdit()) S.draft = await defaultDraft();
}

/* ======================= MOTORE ======================= */
const slotRoles = (mod, i) => D.MODULI[mod].s[i].split('|');
const matchOf = club => D.MATCHES.find(m => m.casa === club || m.ospite === club);
const kickoff = id => { const m = D.P[id] && matchOf(D.P[id].club); return m ? m.t : D.FIRST; };
const started = id => D.FIRST !== null && Date.now() >= kickoff(id);
const lockPhase = () => D.FIRST !== null && Date.now() >= D.FIRST;
const lockedNow = id => lockPhase() && started(id);
const fits = (id, roles) => !!D.P[id] && D.P[id].ruoli.some(r => roles.includes(r));
const canon = f => ({ mod: f.mod, slots: f.slots, bench: f.bench, tribuna: f.tribuna, cap: f.cap, vice: f.vice });

function matchSlots(players, mod) {
  const n = D.MODULI[mod].s.length, owner = Array(n).fill(null);
  function tryP(p, seen) {
    for (let s = 0; s < n; s++) {
      if (seen[s] || !fits(p, slotRoles(mod, s))) continue;
      seen[s] = true;
      if (owner[s] === null || tryP(owner[s], seen)) { owner[s] = p; return true; }
    }
    return false;
  }
  const unplaced = [];
  for (const p of players) { if (owner.filter(Boolean).length === n) { unplaced.push(p); continue; } if (!tryP(p, [])) unplaced.push(p); }
  return { slots: owner, unplaced };
}
function autoForm(k) {
  const pool = D.ROSA[k].filter(id => D.P[id].ruoli.length && !D.P[id].fuori_lista);
  let best = null;
  for (const mod of Object.keys(D.MODULI)) {
    const r = matchSlots(pool, mod), filled = r.slots.filter(Boolean);
    const val = filled.reduce((s, id) => s + (D.P[id].costo || 0), 0) + filled.length * 1000;
    if (!best || val > best.val) best = { mod, slots: r.slots, val };
  }
  const rest = D.ROSA[k].filter(id => !best.slots.includes(id));
  const gk = rest.find(id => D.P[id].ruoli.includes('Por'));
  const ordered = gk ? [gk, ...rest.filter(id => id !== gk)] : rest;
  const xi = best.slots.filter(Boolean).sort((a, b) => (D.P[b].costo || 0) - (D.P[a].costo || 0));
  return { mod: best.mod, slots: best.slots, bench: ordered.slice(0, PANCHINA), tribuna: ordered.slice(PANCHINA), cap: xi[0] || null, vice: xi[1] || null };
}
// adatta una formazione alla rosa attuale (giocatori ceduti o arrivati)
function fixRoster(f, k) {
  const ros = new Set(D.ROSA[k]);
  f.slots = f.slots.map(id => ros.has(id) ? id : null);
  f.bench = f.bench.filter(id => ros.has(id)); f.tribuna = (f.tribuna || []).filter(id => ros.has(id));
  const inF = new Set([...f.slots, ...f.bench, ...f.tribuna]);
  f.tribuna.push(...D.ROSA[k].filter(id => !inF.has(id)));
  if (!f.slots.includes(f.cap)) f.cap = null; if (!f.slots.includes(f.vice)) f.vice = null;
  return f;
}
async function defaultDraft() {
  const k = PROF.team_k;
  try { const raw = localStorage.getItem(`fcg-bozza-${k}-${D.G}`); if (raw) { const d = JSON.parse(raw); if (d && d.mod && D.MODULI[d.mod]) return fixRoster(d, k); } } catch (e) {}
  if (D.FORM[k]) return fixRoster(canon(clone(D.FORM[k])), k);
  const prev = await q(sb.from('formations').select('data, giornata').eq('team_k', k).lt('giornata', D.G).order('giornata', { ascending: false }).limit(1));
  if (prev.length) return fixRoster(canon(clone(prev[0].data)), k);
  return autoForm(k);
}
function saveDraft() { if (!canEdit()) return; try { localStorage.setItem(`fcg-bozza-${PROF.team_k}-${D.G}`, JSON.stringify(S.draft)); } catch (e) {} }
function clearDraft() { try { localStorage.removeItem(`fcg-bozza-${PROF.team_k}-${D.G}`); } catch (e) {} }

function parseVoti(txt) {
  const v = {}, lines = txt.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return v;
  const sep = lines[0].includes(';') ? ';' : (lines[0].includes('\t') ? '\t' : ',');
  const head = lines[0].split(sep).map(h => h.trim().toLowerCase());
  const n = x => (x === undefined || x === '' || /^s\.?v\.?$/i.test(x) || x === '-') ? null : parseFloat(x.replace(',', '.'));
  for (const line of lines.slice(1)) {
    const c = line.split(sep).map(s => (s || '').trim());
    const get = k => head.indexOf(k) >= 0 ? c[head.indexOf(k)] : undefined;
    const nome = get('giocatore') || get('nome'); if (!nome) continue;
    const ev = {}; for (const k of Object.keys(BONUS)) ev[k] = parseInt(get(k)) || 0;
    const voto = n(get('voto'));
    let fv = n(get('fantavoto'));
    const por = D.P[nome] && D.P[nome].ruoli.includes('Por') ? 0 : 1;
    if (fv === null && voto !== null) fv = voto + Object.entries(BONUS).reduce((s, [k, x]) => s + x[por] * ev[k], 0);
    v[nome] = { voto, fv, amm: ev.amm, esp: ev.esp };
  }
  return v;
}

function computeTeam(f, voti, o) {
  const used = new Set(), rows = [];
  let tot = 0, sost = 0;
  const V = id => voti[D.P[id] ? D.P[id].nome : id];
  const has = id => V(id) && V(id).fv !== null && V(id).voto !== null;
  f.slots.forEach((id, i) => {
    const roles = slotRoles(f.mod, i), sl = D.MODULI[f.mod].s[i];
    if (id && has(id)) { rows.push({ slot: sl, id, v: V(id) }); tot += V(id).fv; return; }
    const b = sost < MAX_SOST_AUTO ? f.bench.find(x => !used.has(x) && has(x) && fits(x, roles)) : null;
    if (b) { used.add(b); sost++; rows.push({ slot: sl, id, sub: b, v: V(b) }); tot += V(b).fv; }
    else rows.push({ slot: sl, id, none: true });
  });
  const played = rows.filter(x => !x.none);
  if (!played.length) return { rows, vuoto: true, finale: 0, gol: 0 };
  const capId = has(f.cap) ? f.cap : (has(f.vice) ? f.vice : null);
  const capB = capId ? capBonus(V(capId).voto) : 0;
  const nRend = played.filter(x => (S.rend === 'ge6' ? x.v.voto >= 6 : x.v.voto > 6)).length;
  const rend = REND[nRend];
  const campo = o.casa ? CAMPO : 0;
  const cartellini = played.filter(x => x.v.amm || x.v.esp).map(x => x.sub || x.id);
  const fair = cartellini.length ? 0 : FAIRPLAY;
  const pc = penCambi(o.changes || 0), pm = o.modPen || 0;
  const finale = tot + rend + capB + campo + fair - pc - pm;
  return { rows, tot, capId, capV: capId ? V(capId).voto : null, capB, nRend, rend, campo, fair, cartellini, pc, pm, finale, gol: golDa(finale), sost };
}
const penModTeam = k => (D.BASE[k] && D.FORM[k] && D.FORM[k].mod !== D.BASE[k].mod) ? PEN_MODULO : 0;

function classifica() {
  const R = {};
  for (const { nome } of D.TEAMS) R[nome] = { nome, pt: 0, g: 0, v: 0, n: 0, p: 0, gf: 0, gs: 0, fp: 0, bonus: 0, blocchi: [0, 0, 0] };
  let ultima = 0;
  for (const c of D.CAL) for (const m of c.ms) {
    if (!m.ris) continue;
    ultima = Math.max(ultima, c.g);
    const [a, b] = m.ris.split('-').map(Number), H = R[m.casa], A = R[m.ospite];
    H.g++; A.g++; H.gf += a; H.gs += b; A.gf += b; A.gs += a; H.fp += m.pc || 0; A.fp += m.po || 0;
    const bl = Math.floor((c.g - 1) / 10); if (bl < 3) { H.blocchi[bl] += m.pc || 0; A.blocchi[bl] += m.po || 0; }
    if (a > b) { H.pt += 3; H.v++; A.p++; } else if (b > a) { A.pt += 3; A.v++; H.p++; } else { H.pt++; A.pt++; H.n++; A.n++; }
  }
  for (let bl = 0; bl < 3; bl++) {
    if (ultima < (bl + 1) * 10) continue;
    Object.values(R).sort((x, y) => y.blocchi[bl] - x.blocchi[bl]).slice(0, 3).forEach((r, i) => { r.bonus += [3, 2, 1][i]; });
  }
  return { list: Object.values(R).map(r => ({ ...r, tot: r.pt + r.bonus })).sort((x, y) => y.tot - x.tot || y.fp - x.fp), ultima };
}

/* ======================= ACCESSI ======================= */
const emailOf = id => `${id.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
async function api(body) {
  const r = await fetch('/api/admin-users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SESSION.access_token }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  return j;
}

/* ======================= INTERFACCIA ======================= */
function renderUser() {
  $('#userbox').innerHTML = PROF ? `<span>${PROF.role === 'admin' ? 'Presidente di lega' : esc(D ? D.TN[PROF.team_k] : PROF.team_k)} <span class="muted">· ${esc(PROF.login_id)}</span></span>
    <button data-pwdview="1">Cambia password</button><button data-logout="1">Esci</button>` : '';
}

function renderLogin() {
  $('#view').innerHTML = `<div class="card" style="max-width:440px;margin:24px auto 0">
    <h2>Accedi</h2>
    <form id="loginForm" class="side" style="gap:10px;margin-top:8px">
      <div class="field" style="margin:0"><label for="lid">ID</label><input id="lid" autocomplete="username" autocapitalize="none" required style="${inputStyle}"></div>
      <div class="field" style="margin:0"><label for="lpw">Password</label><input id="lpw" type="password" autocomplete="current-password" required style="${inputStyle}"></div>
      <button class="primary" type="submit">Entra</button>
    </form>${fb(S.msg)}
    <p class="muted" style="margin:14px 0 0">ID e password li ricevi dal presidente di lega.</p></div>`;
}

function renderPwd(forzato) {
  const inp = (id, lab, ac) => `<div class="field" style="margin:0"><label for="${id}">${lab}</label><input id="${id}" type="password" autocomplete="${ac}" style="${inputStyle}"></div>`;
  $('#view').innerHTML = `<div class="card" style="max-width:440px;margin:24px auto 0">
    <h2>${forzato ? 'Scegli la tua password' : 'Cambia password'}</h2>
    ${forzato ? '<p class="muted" style="margin:4px 0 0">Stai usando la password provvisoria ricevuta dal presidente: scegline una tua, di almeno 8 caratteri.</p>' : ''}
    <form id="pwdForm" class="side" style="gap:10px;margin-top:10px">
      ${inp('pnew', 'Nuova password', 'new-password')}${inp('pnew2', 'Ripeti la nuova password', 'new-password')}
      <div class="btns"><button class="primary" type="submit">Salva la password</button>${forzato ? '<button type="button" data-logout="1">Esci</button>' : '<button type="button" data-tab="form">Annulla</button>'}</div>
    </form>${fb(S.msg)}</div>`;
}

function renderStato() {
  const next = D.MATCHES.map(m => m.t).filter(t => t > Date.now()).sort((a, b) => a - b)[0];
  const st = D.FIRST === null ? '<span class="pill bad">Calendario di Serie A mancante per questa giornata</span>'
    : lockPhase() ? `<span class="pill lock">${LOCK} Blocco attivo dal ${fmtT(D.FIRST)}: cambi con penalità</span>`
    : `<span class="pill ok">Prima del blocco: modifiche libere fino al ${fmtT(D.FIRST)}</span>`;
  $('#clock').innerHTML = `<div><div class="lab">${D.G}ª di lega · ${D.SA}ª di Serie A</div><div class="now">${fmtT(Date.now())}</div></div>
    <div class="ctl">${st}${next ? `<span class="pill neu">Prossima partita: ${fmtT(next)}</span>` : ''}<button data-reload="1">Aggiorna</button></div>
    <div class="msg muted" style="font-size:12px">L'ora che conta per blocchi e cambi è quella del server, non quella del telefono.</div>`;
}

const TABS = [['form', 'Formazione'], ['seriea', 'Serie A'], ['lega', 'Classifica e calendario'], ['log', 'Registro cambi'], ['punti', 'Punteggi'], ['rose', 'Rose'], ['regole', 'Regole']];
const TABS_ADMIN = [['accessi', 'Accessi'], ['imp', 'Impostazioni']];
function renderTabs() {
  $('#tabs').innerHTML = (isAdmin() ? [...TABS, ...TABS_ADMIN] : TABS).map(([k, l]) => `<button role="tab" aria-selected="${S.view === k}" data-tab="${k}">${l}</button>`).join('');
}

function clubTxt(id) {
  const p = D.P[id];
  return (p.fuori_lista ? '<span style="color:var(--bad)">fuori lista</span> · ' : '') + (p.club ? `${esc(p.club)}${matchOf(p.club) ? ' · ' + fmtH(kickoff(id)) : ' · non gioca'}` : '');
}

function renderForm() {
  const tk = teamTk(), edit = canEdit();
  const sent = D.FORM[tk] ? canon(D.FORM[tk]) : null;
  const f = edit ? S.draft : (sent || null);
  const avv = (D.CAL.find(c => c.g === D.G) || { ms: [] }).ms.find(m => D.KN[m.casa] === tk || D.KN[m.ospite] === tk);
  const adminBox = isAdmin() ? `<div class="card"><div class="field"><label for="presTeam">Squadra da vedere</label><select id="presTeam">${D.TEAMS.map(x => `<option value="${x.k}" ${x.k === tk ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></div><p class="muted" style="margin:0">Il presidente vede le formazioni ma non le modifica.</p></div>` : '';
  if (!f) {
    $('#view').innerHTML = `<div class="form-grid"><div class="card"><h2>${esc(D.TN[tk])}</h2><p class="muted" style="margin:0">${isAdmin() ? 'Questa squadra non ha ancora inviato la formazione per la ' + D.G + 'ª giornata.' : 'Formazione non visibile.'}</p></div><div class="side">${adminBox}</div></div>`;
    return;
  }
  let i = 0; const rowsHtml = [];
  for (const n of D.MODULI[f.mod].lines) {
    const cells = [];
    for (let k = 0; k < n; k++, i++) {
      const id = f.slots[i], roles = slotRoles(f.mod, i), lk = id && lockedNow(id);
      const ob = f.bench.filter(b => fits(b, roles) && !lockedNow(b)), ot = f.tribuna.filter(b => fits(b, roles) && !lockedNow(b));
      const bad = id && !fits(id, roles);
      cells.push(`<div class="slot${!id || bad ? ' err' : ''}">
        <div class="r">${chips(roles)}${id && f.cap === id ? '<span class="cv">C</span>' : ''}${id && f.vice === id ? '<span class="cv v">V</span>' : ''}</div>
        <select data-slot="${i}" ${!edit || lk ? 'disabled' : ''} aria-label="Slot ${i + 1}">
          ${id ? `<option value="${esc(id)}" selected>${esc(id)} (${D.P[id].ruoli.join('/')})</option>` : '<option value="" selected>— scegli —</option>'}
          ${edit && ob.length ? `<optgroup label="Dalla panchina">${ob.map(b => `<option value="${esc(b)}">↔ ${esc(b)} (${D.P[b].ruoli.join('/')})</option>`).join('')}</optgroup>` : ''}
          ${edit && ot.length ? `<optgroup label="Dalla tribuna">${ot.map(b => `<option value="${esc(b)}">↔ ${esc(b)} (${D.P[b].ruoli.join('/')})</option>`).join('')}</optgroup>` : ''}
        </select>
        <div class="meta">${id ? `<span>${clubTxt(id)}</span>${lk ? `<span class="pill lock">${LOCK} in campo</span>` : ''}` : '<span>slot libero</span>'}</div>
      </div>`);
    }
    rowsHtml.push(`<div class="line">${cells.join('')}</div>`);
  }
  const tribOpts = f.tribuna.filter(x => !lockedNow(x));
  const bench = f.bench.map((id, k) => {
    const lk = lockedNow(id);
    const upOk = edit && k > 0 && !lk && !lockedNow(f.bench[k - 1]), dnOk = edit && k < f.bench.length - 1 && !lk && !lockedNow(f.bench[k + 1]);
    return `<div class="brow"><span class="n">${k + 1}</span><span class="r">${chips(D.P[id].ruoli)}</span>
      <span class="nm">${esc(id)} <small>${clubTxt(id)}</small></span><span>${lk ? `<span class="pill lock">${LOCK} giocata</span>` : ''}</span>
      <span class="sw"><select data-trib="${k}" ${!edit || lk || !tribOpts.length ? 'disabled' : ''} aria-label="Scambia con la tribuna"><option value="">scambia con…</option>${tribOpts.map(x => `<option value="${esc(x)}">${esc(x)} (${D.P[x].ruoli.join('/')})</option>`).join('')}</select></span>
      <span class="mv"><button data-up="${k}" ${upOk ? '' : 'disabled'} aria-label="Su">↑</button><button data-down="${k}" ${dnOk ? '' : 'disabled'} aria-label="Giù">↓</button></span></div>`;
  }).join('');
  const trib = f.tribuna.map(id => `<span>${chips(D.P[id].ruoli)} ${esc(id)}</span>`).join('');
  const dirty = edit && JSON.stringify(canon(f)) !== JSON.stringify(sent);
  const cambi = D.CAMBI[tk] || 0, base = D.BASE[tk] || (lockPhase() ? sent : null);
  const pending = lockPhase() && sent ? f.slots.filter(id => id && !sent.slots.includes(id)).length : 0;
  const modNow = base && sent && sent.mod !== base.mod, modAfter = base && f.mod !== base.mod;
  const pc = penCambi(cambi), pm = modNow ? PEN_MODULO : 0;
  const capOpts = (sel, cur) => `<select id="${sel}" ${edit ? '' : 'disabled'}>${cur && f.slots.includes(cur) ? '' : '<option selected value="">— scegli —</option>'}${f.slots.filter(Boolean).map(id => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select>`;
  const statoInvio = !sent ? '<span class="pill bad">non ancora inviata</span>' : dirty ? '<span class="pill lock">modifiche non inviate</span>' : `<span class="pill ok">inviata ${fmtT(new Date(D.FORM[tk].sentAt).getTime())}</span>`;

  $('#view').innerHTML = `<div class="form-grid">
    <div>
      <div class="pitch"><div class="head"><span>${esc(D.TN[tk])} · ${f.mod}</span>${statoInvio}</div>${rowsHtml.reverse().join('')}</div>
      <div class="card bench"><h2>Panchina · ordine delle sostituzioni (${f.bench.length}/${PANCHINA})</h2>${bench}
        <h2 style="margin-top:14px">Tribuna (${f.tribuna.length})</h2><div class="trib">${trib || '<span class="muted">nessuno</span>'}</div></div>
    </div>
    <div class="side">
      ${adminBox}
      ${avv ? `<div class="card"><div class="lab" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:700">${D.G}ª giornata di lega</div><h2 style="margin-top:4px">${esc(avv.casa)} – ${esc(avv.ospite)}</h2><p class="muted" style="margin:0">${D.KN[avv.casa] === tk ? 'In casa: +2 di fattore campo.' : 'In trasferta.'}</p></div>` : ''}
      <div class="card">
        <div class="field"><label for="mod">Modulo</label><select id="mod" ${edit ? '' : 'disabled'}>${Object.keys(D.MODULI).map(m => `<option ${m === f.mod ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="field"><label for="cap">Capitano</label>${capOpts('cap', f.cap)}</div>
        <div class="field"><label for="vice">Vice capitano</label>${capOpts('vice', f.vice)}</div>
        ${edit ? `<div class="btns"><button class="primary" id="send">Invia formazione</button><button id="undo" ${dirty && sent ? '' : 'disabled'}>Annulla modifiche</button></div>` : ''}
        ${fb(S.msg)}
      </div>
      <div class="card"><h2>Cambi e penalità</h2>
        ${lockPhase() ? '' : '<p class="muted" style="margin:0 0 8px">Il conteggio parte al primo calcio d\'inizio della giornata.</p>'}
        <div class="stat"><span>Cambi usati</span><b>${cambi} / ${MAX_CAMBI}</b></div>
        <div class="meter">${Array.from({ length: MAX_CAMBI }, (_, k) => `<i class="${k < cambi ? 'on' : ''}"></i>`).join('')}</div>
        <div class="stat"><span>Penalità cambi</span><b>${pc ? '−' + fmtN(pc) : '0'}</b>
          <span>Cambio modulo${base ? ` (consegnato ${base.mod})` : ''}</span><b>${modNow ? '−' + fmtN(PEN_MODULO) : 'no'}</b>
          <span class="tot">Penalità sulla partita</span><b class="tot">${pc + pm ? '−' + fmtN(pc + pm) : '0'}</b></div>
        ${lockPhase() && dirty && sent ? `<div class="feedback inf">Se invii ora: ${pending} ${pending === 1 ? 'cambio' : 'cambi'} in più${cambi + pending > MAX_CAMBI ? ' (oltre il massimo: invio rifiutato)' : `, penalità cambi −${fmtN(penCambi(Math.min(cambi + pending, MAX_CAMBI)))}`}${modAfter && !modNow ? `, cambio modulo −${fmtN(PEN_MODULO)}` : ''}${!modAfter && modNow ? ', penalità modulo annullata' : ''}.</div>` : ''}
      </div>
    </div></div>`;
}

function renderSerieA() {
  const tk = teamTk(), f = D.FORM[tk];
  const rows = D.MATCHES.map(m => {
    const st = Date.now() < m.t ? '<span class="pill neu">da giocare</span>' : (Date.now() < m.t + DURATA_PARTITA * 60000 ? `<span class="pill lock">${LOCK} in corso</span>` : `<span class="pill bad">${LOCK} finita</span>`);
    const mine = D.ROSA[tk].filter(id => D.P[id].club === m.casa || D.P[id].club === m.ospite)
      .map(id => `${esc(id)}${f && f.slots.includes(id) ? ' <span class="muted">(titolare)</span>' : f && f.bench.includes(id) ? ' <span class="muted">(panchina)</span>' : ''}`).join(', ');
    return `<tr><td>${fmtT(m.t)}</td><td><b>${esc(m.casa)} – ${esc(m.ospite)}</b></td><td>${st}</td><td>${mine || '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
  $('#view').innerHTML = `<div class="card"><h2>${D.SA}ª giornata di Serie A · orari</h2>
    <p class="muted" style="margin:0 0 8px">Ogni giocatore si blocca al calcio d'inizio della sua partita; la prima fa scattare il conteggio dei cambi. Nell'ultima colonna, i giocatori di ${esc(D.TN[tk])}.</p>
    ${D.MATCHES.length ? `<div class="tbl"><table><thead><tr><th>Calcio d'inizio</th><th>Partita</th><th>Stato</th><th>Giocatori coinvolti</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Orari non ancora inseriti dal presidente.</p>'}</div>`;
}

function renderLega() {
  const { list, ultima } = classifica(), tk = teamTk();
  const cl = list.map((r, i) => `<tr class="${D.KN[r.nome] === tk ? 'me' : ''}"><td class="num">${i + 1}</td><td><b>${esc(r.nome)}</b></td><td class="num"><b>${r.tot}</b></td><td class="num">${r.bonus ? '+' + r.bonus : ''}</td><td class="num">${r.g}</td><td class="num">${r.v}</td><td class="num">${r.n}</td><td class="num">${r.p}</td><td class="num">${r.gf}-${r.gs}</td><td class="num">${fmtN(r.fp)}</td></tr>`).join('');
  const g = D.CAL.find(c => c.g === S.calG) || D.CAL[0];
  const ms = g.ms.map(m => `<tr><td>${esc(m.casa)}</td><td class="num">${m.ris ? fmtN(m.pc) : ''}</td><td class="num"><b>${m.ris || '–'}</b></td><td class="num">${m.ris ? fmtN(m.po) : ''}</td><td>${esc(m.ospite)}</td></tr>`).join('');
  $('#view').innerHTML = `<div class="two">
    <div class="card"><h2>Classifica dopo ${ultima} giornate</h2>
      <div class="tbl"><table><thead><tr><th class="num">#</th><th>Squadra</th><th class="num">Pt</th><th class="num">Bonus</th><th class="num">G</th><th class="num">V</th><th class="num">N</th><th class="num">P</th><th class="num">Gol</th><th class="num">Fantapunti</th></tr></thead><tbody>${cl}</tbody></table></div>
      <p class="muted" style="margin:8px 0 0">Punti con i bonus dei blocchi di 10 giornate (+3, +2, +1 ai primi tre per fantapunti). A parità di punti decide il totale dei fantapunti.</p></div>
    <div class="card"><h2>Calendario</h2>
      <div class="field"><label for="calG">Giornata</label><select id="calG">${D.CAL.map(c => `<option value="${c.g}" ${c.g === g.g ? 'selected' : ''}>${c.g}ª di lega · ${c.sa}ª di Serie A${c.ms.some(m => m.ris) ? '' : ' · da giocare'}</option>`).join('')}</select></div>
      <div class="tbl"><table><thead><tr><th>Casa</th><th class="num">Punti</th><th class="num">Ris.</th><th class="num">Punti</th><th>Ospite</th></tr></thead><tbody>${ms}</tbody></table></div></div></div>`;
}

function renderLog() {
  const rows = D.LOG.map(e => `<tr><td>${fmtT(new Date(e.at).getTime())}</td><td>${esc(D.TN[e.team_k])}</td><td>${esc(e.evento)}</td><td class="num">${esc(e.penalita || '')}</td></tr>`).join('');
  $('#view').innerHTML = `<div class="card"><h2>Registro cambi · ${D.G}ª giornata</h2>
    <p class="muted" style="margin:0 0 8px">Orari del server. Prima del primo calcio d'inizio ognuno vede solo i propri movimenti; dopo, quelli di tutti.</p>
    ${D.LOG.length ? `<div class="tbl"><table><thead><tr><th>Orario</th><th>Squadra</th><th>Evento</th><th class="num">Penalità</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Ancora nessun movimento.</p>'}</div>`;
}

function statRows(r) {
  const p = x => x ? '+' + fmtN(x) : '0', m = x => x ? '−' + fmtN(x) : '0';
  return `<span>Somma fantavoti (sostituzioni automatiche: ${r.sost})</span><b>${fmtN(r.tot)}</b>
    <span>Fattore rendimento (${r.nRend} titolari ${S.rend === 'ge6' ? 'da 6 in su' : 'sopra il 6'})</span><b>${p(r.rend)}</b>
    <span>Fattore capitano${r.capId ? ' (' + esc(r.capId) + ', voto ' + fmtN(r.capV) + ')' : ''}</span><b>${p(r.capB)}</b>
    <span>Fattore campo</span><b>${p(r.campo)}</b>
    <span>Fair play (${r.cartellini.length ? 'ammoniti/espulsi: ' + esc(r.cartellini.join(', ')) : 'nessun ammonito'})</span><b>${p(r.fair)}</b>
    <span>Penalità cambi</span><b>${m(r.pc)}</b><span>Penalità cambio modulo</span><b>${m(r.pm)}</b>
    <span class="tot">Totale · gol</span><b class="tot">${fmtN(r.finale)} · ${r.gol}</b>`;
}
function teamCard(nome, f, r) {
  if (!f) return `<div class="card"><h2>${esc(nome)}</h2><p class="muted" style="margin:0">Formazione non inviata o non ancora visibile.</p></div>`;
  if (r.vuoto) return `<div class="card"><h2>${esc(nome)} · ${f.mod}</h2><p class="muted" style="margin:0">Nessun voto per i giocatori di questa formazione.</p></div>`;
  const rows = r.rows.map(x => {
    const fv = x.none ? '—' : fmtN(x.v.fv), vo = x.none ? '—' : fmtN(x.v.voto);
    const who = x.sub ? `<s class="muted">${esc(x.id)}</s> s.v. → <b>${esc(x.sub)}</b>` : (x.none ? `${esc(x.id || 'slot vuoto')} <span class="pill bad">s.v., nessun sostituto</span>` : esc(x.id));
    return `<tr><td>${chips(x.slot.split('|'))}</td><td>${who}${(x.sub || x.id) === r.capId ? ' <span class="cv">C</span>' : ''}</td><td class="num">${vo}</td><td class="num">${fv}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>${esc(nome)} · ${f.mod}</h2><div class="tbl"><table><thead><tr><th>Slot</th><th>Giocatore</th><th class="num">Voto</th><th class="num">Fantavoto</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="stat" style="margin-top:10px">${statRows(r)}</div></div>`;
}

function risultatiGiornata() {
  const ms = (D.CAL.find(c => c.g === D.G) || { ms: [] }).ms;
  return ms.map(m => {
    const kc = D.KN[m.casa], ko = D.KN[m.ospite], fc = D.FORM[kc], fo = D.FORM[ko];
    const c = fc ? computeTeam(fc, D.V, { casa: true, changes: D.CAMBI[kc] || 0, modPen: penModTeam(kc) }) : { vuoto: true, finale: 0, gol: 0 };
    const o = fo ? computeTeam(fo, D.V, { casa: false, changes: D.CAMBI[ko] || 0, modPen: penModTeam(ko) }) : { vuoto: true, finale: 0, gol: 0 };
    return { m, c, o, fc, fo };
  });
}

function renderPunti() {
  const res = risultatiGiornata();
  const cell = r => r.vuoto ? '<span class="muted">—</span>' : `${fmtN(r.finale)} <span class="muted">(${fmtN(r.tot)}${r.rend + r.capB + r.campo + r.fair ? ' +' + fmtN(r.rend + r.capB + r.campo + r.fair) : ''}${r.pc + r.pm ? ' −' + fmtN(r.pc + r.pm) : ''})</span>`;
  const tab = res.map(({ m, c, o }) => `<tr><td><b>${esc(m.casa)}</b></td><td class="num">${cell(c)}</td><td class="num"><b>${c.vuoto || o.vuoto ? '–' : c.gol + '-' + o.gol}</b></td><td class="num">${cell(o)}</td><td><b>${esc(m.ospite)}</b></td></tr>`).join('');
  const tk = teamTk();
  const mi = Math.max(0, Math.min(res.length - 1, S.puntiMatch ?? res.findIndex(x => D.KN[x.m.casa] === tk || D.KN[x.m.ospite] === tk)));
  const det = res[mi];
  const admin = isAdmin() ? `<div class="two" style="margin-top:16px">
      <div class="card"><h2>Voti della ${D.G}ª (presidente)</h2>
        <p class="muted" style="margin:0 0 6px">Incolla il file dei voti: prima riga con i nomi delle colonne (separati da punto e virgola, virgola o tabulazione). Servono giocatore e voto (sv per senza voto); poi fantavoto, oppure gli eventi (${Object.keys(BONUS).join(', ')}) e il fantavoto lo calcola il gestionale. Salvando, i voti già caricati per questa giornata vengono sostituiti.</p>
        <textarea id="voti" spellcheck="false">${esc(S.votiTxt ?? 'giocatore;voto;fantavoto;amm;esp\n')}</textarea>
        <div class="btns" style="margin-top:8px"><button class="primary" id="salvaVoti">Salva i voti</button></div></div>
      <div class="card"><h2>Chiudi la giornata</h2>
        <p class="muted" style="margin:0 0 8px">Scrive nel calendario i punteggi e i risultati calcolati qui sopra: la classifica si aggiorna per tutti. Si può ripetere se cambiano i voti.</p>
        <div class="btns"><button class="primary" id="salvaRis">${S.saveRes ? 'Conferma: scrivi i risultati' : 'Salva i risultati della ' + D.G + 'ª'}</button></div></div></div>` : '';
  $('#view').innerHTML = `<div class="card"><h2>${D.G}ª giornata di lega · punteggi</h2>
      <p class="muted" style="margin:0 0 8px">Calcolati sulle formazioni inviate e sui voti caricati dal presidente (${D.nVoti} giocatori). Tra parentesi: fantavoti, bonus dei fattori e penalità.</p>
      <div class="tbl"><table><thead><tr><th>Casa</th><th class="num">Totale</th><th class="num">Ris.</th><th class="num">Totale</th><th>Ospite</th></tr></thead><tbody>${tab}</tbody></table></div>${fb(S.msg)}</div>
    ${res.length ? `<div class="card" style="margin-top:16px"><div class="field" style="margin:0"><label for="puntiMatch">Dettaglio della partita</label><select id="puntiMatch">${res.map((x, k) => `<option value="${k}" ${k === mi ? 'selected' : ''}>${esc(x.m.casa)} – ${esc(x.m.ospite)}</option>`).join('')}</select></div></div>
    <div class="two" style="margin-top:16px">${teamCard(det.m.casa, det.fc, det.c)}${teamCard(det.m.ospite, det.fo, det.o)}</div>` : ''}
    ${admin}`;
}

function renderRose() {
  const k = S.roseTeam, ids = D.ROSA[k];
  const rows = ids.map(id => { const p = D.P[id]; return `<tr><td>${chips(p.ruoli)}</td><td><b>${esc(id)}</b></td><td>${esc(p.club)}</td><td class="num">${p.costo ?? ''}</td><td>${p.fuori_lista ? '<span class="pill bad">fuori lista</span>' : ''}</td></tr>`; }).join('');
  $('#view').innerHTML = `<div class="card" style="max-width:760px"><div class="field"><label for="roseTeam">Squadra</label><select id="roseTeam">${D.TEAMS.map(x => `<option value="${x.k}" ${x.k === k ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></div>
    <div class="tbl"><table><thead><tr><th>Ruoli</th><th>Giocatore</th><th>Squadra</th><th class="num">Costo</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin:8px 0 0">${ids.length} giocatori · costo totale ${ids.reduce((s, id) => s + (D.P[id].costo || 0), 0)}</p></div>`;
}

function renderRegole() {
  $('#view').innerHTML = `<div class="card rules" style="max-width:860px"><h2>Regole applicate</h2><ul>
    <li>Fino al primo calcio d'inizio della giornata la formazione si cambia liberamente, tutte le volte che vuoi. Al primo calcio d'inizio l'ultima formazione inviata diventa quella <b>consegnata</b>.</li>
    <li>Dopo, ogni giocatore resta modificabile finché non inizia la sua partita: chi ha già giocato non entra, non esce e non cambia posto in panchina.</li>
    <li>Ogni giocatore che entra tra i titolari è <b>un cambio</b>, registrato con l'ora del server. Massimo ${MAX_CAMBI}. Penalità sui punti della partita: 1 cambio −0,5 · 2 −1 · 3 −1,5 · 4 −2 · 5 −3.</li>
    <li>Modulo diverso da quello consegnato: −1, una volta sola; se torni al modulo consegnato la penalità si annulla.</li>
    <li>Panchina di ${PANCHINA}, gli altri in tribuna. Senza voto: entra il primo della panchina, in ordine, con un ruolo ammesso nello slot (massimo ${MAX_SOST_AUTO}).</li>
    <li>Fattore rendimento: da 6 titolari con voto da 6 in su +0,5, poi 7 +1, 8 +1,5, 9 +2, 10 +3, 11 +4.</li>
    <li>Fattore capitano sul voto in pagella: 6,5 +0,5 · 7 +1,5 · 7,5 +2,5 · 8 +3 · 8,5 +3,5 · da 9 +4. Se il capitano è senza voto, vale il vice.</li>
    <li>Fattore campo +2 alla squadra di casa. Fair play +1,5 se nessuno degli undici in campo è ammonito o espulso.</li>
    <li>Bonus e malus (portiere / movimento), se il file dei voti non ha il fantavoto: ${Object.entries(BONUS).map(([k, x]) => `${BONUS_NOMI[k]} ${x[0] === x[1] ? fmtN(x[0]) : fmtN(x[0]) + ' / ' + fmtN(x[1])}`).join(' · ')}.</li>
    <li>Gol: un gol a 66, poi uno ogni 6 punti. Classifica: 3 punti a vittoria, 1 a pareggio, più i bonus dei blocchi di 10 giornate (+3, +2, +1 per fantapunti).</li>
    <li>Le formazioni delle altre squadre si vedono dal primo calcio d'inizio della giornata.</li></ul></div>`;
}

function renderAccessi() {
  const rows = D.TEAMS.map(({ k, nome }) => {
    const u = D.PROFILES.find(p => p.role === 'team' && p.team_k === k);
    if (!u) return `<tr><td><b>${esc(nome)}</b></td><td><input id="nid-${k}" value="${esc(k)}" aria-label="ID per ${esc(nome)}" style="${inputStyle};font-size:13px;padding:4px 6px;width:150px"></td><td><span class="pill neu">da creare</span></td><td>—</td><td><button class="primary" data-crea="${k}">Crea accesso</button></td></tr>`;
    const st = !u.attivo ? '<span class="pill bad">disattivato</span>' : u.must_change ? '<span class="pill lock">password provvisoria</span>' : '<span class="pill ok">attivo</span>';
    return `<tr><td><b>${esc(nome)}</b></td><td>${esc(u.login_id)}</td><td>${st}</td><td>${u.last_login ? fmtT(new Date(u.last_login).getTime()) : '—'}</td>
      <td><div class="btns"><button data-newpw="${u.user_id}">Nuova password</button><button data-toggle="${u.user_id}">${u.attivo ? 'Disattiva' : 'Riattiva'}</button><button data-del="${u.user_id}">${S.delPending === u.user_id ? 'Conferma: elimina' : 'Elimina'}</button></div></td></tr>`;
  }).join('');
  const nc = S.nuovaCred ? `<div class="feedback ok" style="margin:0 0 12px"><b>Credenziali per ${esc(S.nuovaCred.team)}</b> · ID: <b>${esc(S.nuovaCred.id)}</b> · password provvisoria: <b id="ncpw">${esc(S.nuovaCred.pw)}</b>
      <div class="btns" style="margin-top:8px"><button data-copy="1">Copia ID e password</button><button data-hidecred="1">Fatto, nascondi</button></div>
      <div style="margin-top:6px">Copiala adesso e mandala all'allenatore insieme all'indirizzo del sito: dopo non sarà più visibile. Al primo accesso dovrà sceglierne una sua.</div></div>` : '';
  $('#view').innerHTML = `<div class="card"><h2>Accessi degli allenatori</h2>
    <p class="muted" style="margin:0 0 10px">Crei tu ID e password provvisoria per ogni squadra e li consegni all'allenatore. Ognuno vede e modifica solo la propria formazione.</p>
    ${nc}${fb(S.msg)}
    <div class="tbl"><table><thead><tr><th>Squadra</th><th>ID</th><th>Stato</th><th>Ultimo accesso</th><th>Azioni</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function renderImp() {
  const sa = D.CAL.find(c => c.g === D.G)?.sa;
  const txt = S.saTxt ?? D.MATCHES.map(m => `${m.casa};${m.ospite};${new Date(m.t).toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 16)}`).join('\n');
  $('#view').innerHTML = `<div class="two">
    <div class="card"><h2>Giornata corrente</h2>
      <p class="muted" style="margin:0 0 8px">È la giornata su cui gli allenatori lavorano. Passa alla successiva dopo aver salvato i risultati.</p>
      <div class="field"><label for="giornata">Giornata di lega</label><select id="giornata">${D.CAL.map(c => `<option value="${c.g}" ${c.g === D.G ? 'selected' : ''}>${c.g}ª di lega · ${c.sa}ª di Serie A</option>`).join('')}</select></div>
      <button class="primary" id="salvaG">Imposta</button></div>
    <div class="card"><h2>Orari della ${sa}ª di Serie A</h2>
      <p class="muted" style="margin:0 0 6px">Una partita per riga: casa;ospite;data e ora (ora italiana), per esempio <code>Inter;Genoa;2026-11-28 20:45</code>. I nomi delle squadre devono essere come nel listone.</p>
      <textarea id="saTxt" spellcheck="false">${esc(txt)}</textarea>
      <div class="btns" style="margin-top:8px"><button class="primary" id="salvaSA">Salva gli orari</button></div></div></div>${fb(S.msg)}`;
}

let renderCount = 0;
function render() {
  renderUser();
  const dentro = !!PROF && !PROF.must_change && !!D;
  $('#clock').hidden = !dentro; $('#tabs').hidden = !dentro;
  if (!SESSION || !PROF) return renderLogin();
  if (PROF.must_change) return renderPwd(true);
  if (!D) { $('#view').innerHTML = '<p class="muted">Caricamento…</p>'; return; }
  if (TABS_ADMIN.some(([k]) => k === S.view) && !isAdmin()) S.view = 'form';
  renderStato(); renderTabs();
  ({ form: renderForm, seriea: renderSerieA, lega: renderLega, log: renderLog, punti: renderPunti, rose: renderRose, regole: renderRegole, accessi: renderAccessi, imp: renderImp, pwd: () => renderPwd(false) })[S.view]();
  renderCount++;
}

/* ======================= AZIONI ======================= */
async function afterLogin() {
  const { data } = await sb.auth.getSession(); SESSION = data.session;
  if (!SESSION) { PROF = null; D = null; return; }
  PROF = (await q(sb.from('profiles').select('*').eq('user_id', SESSION.user.id))).at(0) || null;
  if (!PROF) { S.msg = { k: 'bad', m: 'Questo utente non è collegato a nessuna squadra: avvisa il presidente.' }; await sb.auth.signOut(); SESSION = null; return; }
  if (!PROF.attivo) { S.msg = { k: 'bad', m: 'Questo accesso è stato disattivato dal presidente.' }; await sb.auth.signOut(); SESSION = null; PROF = null; return; }
  if (!PROF.must_change) { await load(); }
}

document.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    if (e.target.id === 'loginForm') {
      const id = $('#lid').value.trim().toLowerCase(), pw = $('#lpw').value;
      const { error } = await sb.auth.signInWithPassword({ email: emailOf(id), password: pw });
      if (error) { S.msg = { k: 'bad', m: /invalid/i.test(error.message) ? 'ID o password non corretti.' : (/banned/i.test(error.message) ? 'Questo accesso è stato disattivato dal presidente.' : error.message) }; return render(); }
      S.msg = null; await sb.rpc('touch_login'); await afterLogin();
    }
    if (e.target.id === 'pwdForm') {
      const a = $('#pnew').value, b = $('#pnew2').value;
      if (a.length < 8) { S.msg = { k: 'bad', m: 'La nuova password deve avere almeno 8 caratteri.' }; return render(); }
      if (a !== b) { S.msg = { k: 'bad', m: 'Le due password non coincidono.' }; return render(); }
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) { S.msg = { k: 'bad', m: /different|same/i.test(error.message) ? 'Scegli una password diversa da quella attuale.' : error.message }; return render(); }
      await sb.rpc('password_changed'); PROF.must_change = false; S.msg = { k: 'ok', m: 'Password salvata.' }; S.view = 'form';
      if (!D) await load();
    }
  } catch (err) { S.msg = { k: 'bad', m: 'Errore: ' + err.message }; }
  render();
});

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || (b.type === 'submit' && b.form)) return;
  try {
    if (b.dataset.logout) { await sb.auth.signOut(); SESSION = null; PROF = null; D = null; S = { ...S, view: 'form', msg: null, draft: null, nuovaCred: null, presTeam: null, roseTeam: null }; return render(); }
    if (!PROF) return;
    if (b.dataset.pwdview) { S.msg = null; S.view = 'pwd'; return render(); }
    if (b.dataset.reload) { S.msg = null; await load(); return render(); }
    if (b.dataset.tab) { S.view = b.dataset.tab; S.msg = null; S.saveRes = false; S.delPending = null; return render(); }
    // formazione
    const f = S.draft;
    if (b.dataset.up !== undefined || b.dataset.down !== undefined) {
      const k = +(b.dataset.up ?? b.dataset.down), j = b.dataset.up !== undefined ? k - 1 : k + 1;
      [f.bench[k], f.bench[j]] = [f.bench[j], f.bench[k]]; S.msg = null; saveDraft(); return render();
    }
    if (b.id === 'send') {
      b.disabled = true;
      const { data, error } = await sb.rpc('submit_formation', { p_giornata: D.G, p_data: canon(f) });
      if (error) S.msg = { k: 'bad', m: 'Invio non riuscito: ' + error.message };
      else if (!data.ok) S.msg = { k: 'bad', m: 'Formazione non inviata', l: data.errori };
      else { S.msg = { k: 'ok', m: data.messaggio + (data.penalita ? ` Penalità attuale: −${fmtN(data.penalita)}.` : '') }; clearDraft(); const keep = S.msg; await load(); S.msg = keep; }
      return render();
    }
    if (b.id === 'undo') { S.draft = fixRoster(canon(clone(D.FORM[PROF.team_k])), PROF.team_k); clearDraft(); S.msg = null; return render(); }
    // presidente
    if (!isAdmin()) return;
    if (b.dataset.crea) {
      const k = b.dataset.crea, id = $('#nid-' + k).value.trim().toLowerCase();
      const r = await api({ action: 'create', login_id: id, team_k: k });
      S.nuovaCred = { team: D.TN[k], id: r.login_id, pw: r.password }; S.msg = null; await load(); return render();
    }
    if (b.dataset.newpw) { const r = await api({ action: 'reset', user_id: b.dataset.newpw }); const u = D.PROFILES.find(p => p.user_id === b.dataset.newpw); S.nuovaCred = { team: D.TN[u.team_k], id: u.login_id, pw: r.password }; S.msg = null; await load(); return render(); }
    if (b.dataset.toggle) { const r = await api({ action: 'toggle', user_id: b.dataset.toggle }); S.msg = { k: 'ok', m: r.attivo ? 'Accesso riattivato.' : 'Accesso disattivato.' }; await load(); return render(); }
    if (b.dataset.del) {
      if (S.delPending !== b.dataset.del) { S.delPending = b.dataset.del; S.msg = { k: 'inf', m: 'Premi di nuovo «Conferma: elimina» per cancellare l\'accesso. La squadra e le formazioni restano.' }; return render(); }
      await api({ action: 'delete', user_id: b.dataset.del }); S.delPending = null; S.msg = { k: 'ok', m: 'Accesso eliminato.' }; await load(); return render();
    }
    if (b.dataset.hidecred) { S.nuovaCred = null; return render(); }
    if (b.dataset.copy) {
      const c = S.nuovaCred, txt = `Fantacrusco · ${c.team}\nSito: ${location.origin}\nID: ${c.id}\nPassword provvisoria: ${c.pw}`;
      try { await navigator.clipboard.writeText(txt); b.textContent = 'Copiate'; } catch (err) { const r = document.createRange(); r.selectNodeContents($('#ncpw')); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = 'Seleziona e copia a mano'; }
      return;
    }
    if (b.id === 'salvaVoti') {
      S.votiTxt = $('#voti').value;
      const v = parseVoti(S.votiTxt), rows = Object.entries(v).map(([nome, x]) => ({ giornata: D.G, nome, voto: x.voto, fantavoto: x.fv, amm: x.amm || 0, esp: x.esp || 0 }));
      if (!rows.length) { S.msg = { k: 'bad', m: 'Nessun voto riconosciuto: controlla la prima riga con i nomi delle colonne.' }; return render(); }
      const sconosciuti = rows.filter(r => !D.P[r.nome]).length;
      await q(sb.from('votes').delete().eq('giornata', D.G));
      await q(sb.from('votes').insert(rows));
      await load(); S.msg = { k: 'ok', m: `Salvati ${rows.length} voti per la ${D.G}ª.${sconosciuti ? ` ${sconosciuti} nomi non sono in nessuna rosa (normale: il file contiene tutta la Serie A).` : ''}` };
      return render();
    }
    if (b.id === 'salvaRis') {
      if (!S.saveRes) { S.saveRes = true; return render(); }
      S.saveRes = false;
      const res = risultatiGiornata();
      if (res.some(x => x.c.vuoto || x.o.vuoto)) { S.msg = { k: 'bad', m: 'Ci sono squadre senza formazione o senza voti: risultati non salvati.' }; return render(); }
      for (const x of res) await q(sb.from('league_matches').update({ punti_casa: x.c.finale, punti_ospite: x.o.finale, risultato: `${x.c.gol}-${x.o.gol}` }).eq('giornata', D.G).eq('idx', x.m.idx));
      await load(); S.msg = { k: 'ok', m: `Risultati della ${D.G}ª salvati nel calendario.` }; return render();
    }
    if (b.id === 'salvaG') {
      const g = +$('#giornata').value;
      await q(sb.from('settings').upsert({ key: 'giornata_corrente', value: g }));
      S.saTxt = null; await load(); S.msg = { k: 'ok', m: `Giornata corrente: ${g}ª.` }; return render();
    }
    if (b.id === 'salvaSA') {
      S.saTxt = $('#saTxt').value;
      const righe = S.saTxt.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(';').map(x => x.trim()));
      const bad = righe.filter(r => r.length < 3 || isNaN(new Date(r[2].replace(' ', 'T') + ':00+01:00').getTime()));
      if (bad.length) { S.msg = { k: 'bad', m: `Righe non valide: ${bad.map(r => r.join(';')).join(' | ')}` }; return render(); }
      const ofs = d => { const t = new Date(d.replace(' ', 'T') + ':00Z'); const roma = new Date(t.toLocaleString('en-US', { timeZone: 'Europe/Rome' })), utc = new Date(t.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(t.getTime() - (roma - utc)).toISOString(); };
      await q(sb.from('serie_a_matches').delete().eq('serie_a', D.SA));
      await q(sb.from('serie_a_matches').insert(righe.map(r => ({ serie_a: D.SA, casa: r[0], ospite: r[1], kickoff: ofs(r[2]) }))));
      S.saTxt = null; await load(); S.msg = { k: 'ok', m: `Salvati ${righe.length} orari della ${D.SA}ª di Serie A.` }; return render();
    }
  } catch (err) { S.msg = { k: 'bad', m: 'Errore: ' + err.message }; render(); }
});

document.addEventListener('change', e => {
  if (!PROF || !D) return;
  const el = e.target;
  if (el.id === 'presTeam') { S.presTeam = el.value; S.msg = null; return render(); }
  if (el.id === 'roseTeam') { S.roseTeam = el.value; return render(); }
  if (el.id === 'calG') { S.calG = +el.value; return render(); }
  if (el.id === 'puntiMatch') { S.puntiMatch = +el.value; return render(); }
  if (!canEdit()) return;
  const f = S.draft;
  if (el.dataset.slot !== undefined) {
    const i = +el.dataset.slot, inc = el.value, old = f.slots[i];
    if (!inc || inc === old) return;
    let j = f.bench.indexOf(inc);
    if (j >= 0) { if (old) f.bench[j] = old; else f.bench.splice(j, 1); }
    else { j = f.tribuna.indexOf(inc); if (old) f.tribuna[j] = old; else f.tribuna.splice(j, 1); }
    f.slots[i] = inc;
    if (old && f.cap === old) f.cap = null;
    if (old && f.vice === old) f.vice = null;
  } else if (el.dataset.trib !== undefined) {
    const k = +el.dataset.trib, inc = el.value; if (!inc) return;
    const j = f.tribuna.indexOf(inc); f.tribuna[j] = f.bench[k]; f.bench[k] = inc;
  } else if (el.id === 'mod') {
    const m = el.value, order = f.slots.filter(Boolean).sort((a, b) => lockedNow(b) - lockedNow(a));
    const r = matchSlots(order, m), lockedOut = r.unplaced.filter(lockedNow);
    if (lockedOut.length) { S.msg = { k: 'bad', m: `Modulo ${m} non possibile: ${lockedOut.join(', ')} ha già giocato e non ha un posto nel nuovo modulo.` }; return render(); }
    f.mod = m; f.slots = r.slots; f.tribuna = r.unplaced.concat(f.tribuna);
    if (!f.slots.includes(f.cap)) f.cap = null; if (!f.slots.includes(f.vice)) f.vice = null;
    S.msg = r.unplaced.length ? { k: 'inf', m: `Nel ${m} non trovano posto: ${r.unplaced.join(', ')} (spostati in tribuna). Completa gli slot vuoti.` } : null;
    saveDraft(); return render();
  } else if (el.id === 'cap') f.cap = el.value || null;
  else if (el.id === 'vice') f.vice = el.value || null;
  else return;
  S.msg = null; saveDraft(); render();
});

/* ======================= AVVIO ======================= */
(async () => {
  try { await afterLogin(); } catch (err) { S.msg = { k: 'bad', m: 'Errore di collegamento: ' + err.message }; }
  render();
  setInterval(() => { if (D && PROF && !PROF.must_change && (S.view === 'form' || S.view === 'seriea')) { const a = document.activeElement; if (!a || a === document.body) render(); else renderStato(); } }, 60000);
})();
