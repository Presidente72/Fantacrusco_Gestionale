// Funzione riservata al presidente: crea, reimposta, disattiva ed elimina gli accessi degli allenatori.
// Gira su Vercel e usa la chiave segreta di Supabase, letta dalle variabili d'ambiente (mai nel codice).
import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';

const DOMAIN = process.env.EMAIL_DOMAIN || 'fantacrusco.local';
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const genPw = () => Array.from({ length: 10 }, () => CHARS[randomInt(CHARS.length)]).join('');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return res.status(500).json({ error: 'Configurazione mancante su Vercel: SUPABASE_URL e SUPABASE_SECRET_KEY.' });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // chi chiama deve essere il presidente
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sessione mancante: rientra.' });
  const { data: ud, error: ue } = await admin.auth.getUser(token);
  if (ue || !ud?.user) {
    const det = ue?.message || 'utente non trovato';
    const chiave = /api key|apikey|invalid.*key|unauthorized/i.test(det);
    return res.status(401).json({ error: chiave
      ? `La chiave segreta su Vercel non è accettata da Supabase (${det}). Controlla SUPABASE_SECRET_KEY: deve iniziare con sb_secret_ e appartenere a questo progetto.`
      : `Sessione non riconosciuta (${det}). Esci e rientra; se il problema resta, controlla SUPABASE_URL e SUPABASE_SECRET_KEY su Vercel.` });
  }
  const { data: me } = await admin.from('profiles').select('role, attivo').eq('user_id', ud.user.id).maybeSingle();
  if (!me || me.role !== 'admin' || !me.attivo) return res.status(403).json({ error: 'Solo il presidente può gestire gli accessi.' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action } = body;

  try {
    if (action === 'create') {
      const login_id = String(body.login_id || '').trim().toLowerCase(), team_k = String(body.team_k || '');
      if (!/^[a-z0-9._-]{3,20}$/.test(login_id)) return res.status(400).json({ error: 'ID non valido: da 3 a 20 caratteri tra lettere minuscole, numeri, punto e trattini.' });
      const { data: team } = await admin.from('teams').select('k').eq('k', team_k).maybeSingle();
      if (!team) return res.status(400).json({ error: 'Squadra sconosciuta.' });
      const { data: d1 } = await admin.from('profiles').select('user_id').eq('login_id', login_id);
      if (d1 && d1.length) return res.status(400).json({ error: `L'ID «${login_id}» è già usato.` });
      const { data: d2 } = await admin.from('profiles').select('user_id').eq('team_k', team_k);
      if (d2 && d2.length) return res.status(400).json({ error: 'Questa squadra ha già un accesso.' });
      const password = genPw();
      const { data: cu, error: ce } = await admin.auth.admin.createUser({ email: `${login_id}@${DOMAIN}`, password, email_confirm: true });
      if (ce) return res.status(400).json({ error: 'Creazione non riuscita: ' + ce.message });
      const { error: pe } = await admin.from('profiles').insert({ user_id: cu.user.id, login_id, role: 'team', team_k, must_change: true });
      if (pe) { await admin.auth.admin.deleteUser(cu.user.id); return res.status(400).json({ error: 'Creazione non riuscita: ' + pe.message }); }
      return res.status(200).json({ login_id, password });
    }

    const user_id = String(body.user_id || '');
    const { data: prof } = await admin.from('profiles').select('*').eq('user_id', user_id).maybeSingle();
    if (!prof) return res.status(404).json({ error: 'Accesso non trovato.' });
    if (prof.role === 'admin') return res.status(400).json({ error: "L'accesso del presidente non si gestisce da qui." });

    if (action === 'reset') {
      const password = genPw();
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) return res.status(400).json({ error: error.message });
      await admin.from('profiles').update({ must_change: true }).eq('user_id', user_id);
      return res.status(200).json({ password });
    }
    if (action === 'toggle') {
      const attivo = !prof.attivo;
      const { error } = await admin.auth.admin.updateUserById(user_id, { ban_duration: attivo ? 'none' : '876000h' });
      if (error) return res.status(400).json({ error: error.message });
      await admin.from('profiles').update({ attivo }).eq('user_id', user_id);
      return res.status(200).json({ attivo });
    }
    if (action === 'delete') {
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Azione sconosciuta.' });
  } catch (err) {
    return res.status(500).json({ error: 'Errore del server: ' + err.message });
  }
}
