-- =====================================================================
-- Fantacrusco Gestionale · schema del database (Supabase / PostgreSQL)
-- Da eseguire una volta nell'editor SQL di Supabase (SQL Editor → New query → incolla → Run).
-- Poi eseguire 02_dati.sql e 03_presidente.sql.
-- =====================================================================

-- ---------- Tabelle di base -------------------------------------------
create table if not exists public.teams (
  k     text primary key,               -- chiave breve, es. realpiripacchio
  nome  text not null unique            -- nome della squadra come nel calendario
);

create table if not exists public.players (
  id           text primary key,        -- nome del giocatore come nel listone
  nome         text not null,
  team_k       text not null references public.teams(k),
  costo        int,
  ruoli        text[] not null default '{}',   -- ruoli Mantra, es. {Dd,Ds,E}
  club         text,                    -- squadra di Serie A
  fuori_lista  boolean not null default false
);

create table if not exists public.modules (
  nome   text not null,                 -- es. 3-4-3
  slot   int  not null,                 -- 0..10, il portiere è lo slot 0
  ruoli  text[] not null,               -- ruoli ammessi nello slot
  riga   int  not null,                 -- 0 = portiere, poi difesa, centrocampo...
  primary key (nome, slot)
);

create table if not exists public.league_matches (
  giornata      int  not null,          -- giornata di lega
  idx           int  not null,          -- 0..4
  serie_a       int  not null,          -- giornata di Serie A corrispondente
  casa          text not null references public.teams(nome),
  ospite        text not null references public.teams(nome),
  punti_casa    numeric,
  punti_ospite  numeric,
  risultato     text,                   -- es. '3-1', null se da giocare
  primary key (giornata, idx)
);

create table if not exists public.serie_a_matches (
  id       serial primary key,
  serie_a  int  not null,
  casa     text not null,
  ospite   text not null,
  kickoff  timestamptz not null
);

create table if not exists public.settings (
  key    text primary key,
  value  jsonb not null
);

-- ---------- Utenti -----------------------------------------------------
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  login_id     text not null unique,    -- l'ID con cui si entra (senza @fantacrusco.local)
  role         text not null check (role in ('admin', 'team')),
  team_k       text references public.teams(k),
  attivo       boolean not null default true,
  must_change  boolean not null default true,   -- password provvisoria da cambiare
  created_at   timestamptz not null default now(),
  last_login   timestamptz
);
create unique index if not exists profiles_one_per_team on public.profiles(team_k) where role = 'team';

-- ---------- Formazioni, cambi, voti ---------------------------------------
create table if not exists public.formations (     -- ultima formazione inviata
  giornata  int  not null,
  team_k    text not null references public.teams(k),
  data      jsonb not null,                       -- {mod, slots[11], bench[], tribuna[], cap, vice}
  sent_at   timestamptz not null default now(),
  primary key (giornata, team_k)
);

create table if not exists public.baselines (      -- formazione consegnata al primo calcio d'inizio
  giornata  int  not null,
  team_k    text not null references public.teams(k),
  data      jsonb not null,
  taken_at  timestamptz not null,
  primary key (giornata, team_k)
);

create table if not exists public.round_state (    -- cambi usati dopo il blocco
  giornata  int  not null,
  team_k    text not null references public.teams(k),
  cambi     int  not null default 0,
  primary key (giornata, team_k)
);

create table if not exists public.changes_log (
  id        bigserial primary key,
  giornata  int  not null,
  team_k    text not null references public.teams(k),
  at        timestamptz not null default now(),   -- ora del server
  evento    text not null,
  penalita  text,
  user_id   uuid
);

create table if not exists public.votes (
  giornata   int  not null,
  nome       text not null,
  voto       numeric,                    -- null = senza voto
  fantavoto  numeric,
  amm        int not null default 0,
  esp        int not null default 0,
  primary key (giornata, nome)
);

-- ---------- Funzioni di supporto ----------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin' and attivo);
$$;

create or replace function public.my_team() returns text
language sql stable security definer set search_path = public as $$
  select team_k from profiles where user_id = auth.uid() and role = 'team' and attivo;
$$;

-- primo calcio d'inizio della giornata di lega (blocco)
create or replace function public.first_kick(p_giornata int) returns timestamptz
language sql stable security definer set search_path = public as $$
  select min(s.kickoff) from serie_a_matches s
  where s.serie_a = (select serie_a from league_matches where giornata = p_giornata limit 1);
$$;

-- calcio d'inizio della partita del giocatore (se la squadra non gioca o è sconosciuta: primo calcio d'inizio)
create or replace function public.player_kickoff(p_giornata int, p_player text) returns timestamptz
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.kickoff from serie_a_matches s join players p on p.id = p_player
      where s.serie_a = (select serie_a from league_matches where giornata = p_giornata limit 1)
        and (s.casa = p.club or s.ospite = p.club) limit 1),
    first_kick(p_giornata));
$$;

-- ---------- Invio formazione: tutte le regole sono qui, con l'ora del server ----------
create or replace function public.submit_formation(p_giornata int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pen      numeric[] := array[0, 0.5, 1, 1.5, 2, 3];   -- penalità totale per 0..5 cambi
  max_cambi constant int := 5;
  panchina  constant int := 12;
  v_uid    uuid := auth.uid();
  v_team   text;
  v_now    timestamptz := now();
  v_fk     timestamptz;
  v_mod    text := p_data->>'mod';
  v_slots  text[];
  v_bench  text[];
  v_trib   text[];
  v_cap    text := p_data->>'cap';
  v_vice   text := p_data->>'vice';
  v_all    text[];
  v_roster text[];
  v_prev   jsonb;
  v_base   jsonb;
  p_slots  text[];
  p_bench  text[];
  p_trib   text[];
  v_cambi  int;
  v_entra  text[];
  v_esce   text[];
  v_roles  text[];
  v_pr     text[];
  errs     text[] := '{}';
  i        int;
  x        text;
begin
  select team_k into v_team from profiles where user_id = v_uid and role = 'team' and attivo;
  if v_team is null then
    return jsonb_build_object('ok', false, 'errori', jsonb_build_array('Solo l''allenatore della squadra può inviare la formazione.'));
  end if;

  v_slots := array(select jsonb_array_elements_text(coalesce(p_data->'slots', '[]')));
  v_bench := array(select jsonb_array_elements_text(coalesce(p_data->'bench', '[]')));
  v_trib  := array(select jsonb_array_elements_text(coalesce(p_data->'tribuna', '[]')));

  -- controlli sempre validi
  if not exists (select 1 from modules where nome = v_mod) then errs := errs || format('Modulo %s non previsto', coalesce(v_mod, '?')); end if;
  if coalesce(array_length(v_slots, 1), 0) <> 11 then errs := errs || 'Servono 11 titolari'::text; end if;
  if coalesce(array_length(v_bench, 1), 0) > panchina then errs := errs || format('In panchina vanno al massimo %s giocatori', panchina); end if;
  v_all := v_slots || v_bench || v_trib;
  v_roster := array(select id from players where team_k = v_team order by id);
  if array(select unnest(v_all) order by 1) is distinct from v_roster then
    errs := errs || 'La formazione deve contenere esattamente i giocatori della rosa, una volta sola'::text;
  end if;
  if coalesce(array_length(errs, 1), 0) = 0 then
    for i in 1..11 loop
      x := v_slots[i];
      select ruoli into v_roles from modules where nome = v_mod and slot = i - 1;
      select ruoli into v_pr from players where id = x;
      if x is null then errs := errs || format('Slot %s vuoto', i);
      elsif not (v_pr && v_roles) then errs := errs || format('%s non ha il ruolo per lo slot %s', x, array_to_string(v_roles, '/'));
      end if;
    end loop;
  end if;
  if v_cap is null or not (v_cap = any(v_slots)) then errs := errs || 'Scegli il capitano tra i titolari'::text; end if;
  if v_vice is null or not (v_vice = any(v_slots)) then errs := errs || 'Scegli il vice tra i titolari'::text; end if;
  if v_cap = v_vice then errs := errs || 'Capitano e vice devono essere diversi'::text; end if;

  v_fk := first_kick(p_giornata);
  if v_fk is null then errs := errs || 'Per questa giornata manca il calendario di Serie A'::text; end if;
  if coalesce(array_length(errs, 1), 0) > 0 then
    return jsonb_build_object('ok', false, 'errori', to_jsonb(errs));
  end if;

  select data into v_prev from formations where giornata = p_giornata and team_k = v_team;

  -- prima del blocco: libero
  if v_now < v_fk then
    if v_prev is not distinct from p_data then
      return jsonb_build_object('ok', true, 'messaggio', 'Nessuna modifica da inviare.');
    end if;
    insert into formations (giornata, team_k, data, sent_at) values (p_giornata, v_team, p_data, v_now)
      on conflict (giornata, team_k) do update set data = excluded.data, sent_at = excluded.sent_at;
    insert into changes_log (giornata, team_k, evento, user_id)
      values (p_giornata, v_team, format('Formazione inviata (modulo %s) · prima del blocco, nessuna penalità', v_mod), v_uid);
    return jsonb_build_object('ok', true, 'messaggio', 'Formazione inviata. Fino al primo calcio d''inizio puoi cambiarla senza penalità.');
  end if;

  -- dopo il blocco
  if v_prev is null then
    return jsonb_build_object('ok', false, 'errori', jsonb_build_array('La formazione non era stata inviata prima della prima partita della giornata: contatta il presidente.'));
  end if;
  select data into v_base from baselines where giornata = p_giornata and team_k = v_team;
  if v_base is null then
    insert into baselines (giornata, team_k, data, taken_at) values (p_giornata, v_team, v_prev, v_fk);
    insert into changes_log (giornata, team_k, at, evento, user_id)
      values (p_giornata, v_team, v_fk, format('Blocco: formazione consegnata (modulo %s)', v_prev->>'mod'), v_uid);
    v_base := v_prev;
  end if;

  p_slots := array(select jsonb_array_elements_text(v_prev->'slots'));
  p_bench := array(select jsonb_array_elements_text(v_prev->'bench'));
  p_trib  := array(select jsonb_array_elements_text(v_prev->'tribuna'));

  foreach x in array p_slots loop
    if player_kickoff(p_giornata, x) <= v_now and not (x = any(v_slots)) then errs := errs || format('%s è già sceso in campo: non può uscire', x); end if;
  end loop;
  foreach x in array v_slots loop
    if player_kickoff(p_giornata, x) <= v_now and not (x = any(p_slots)) then errs := errs || format('%s ha già giocato: non può entrare', x); end if;
  end loop;
  for i in 1..coalesce(array_length(p_bench, 1), 0) loop
    if player_kickoff(p_giornata, p_bench[i]) <= v_now and v_bench[i] is distinct from p_bench[i] then
      errs := errs || format('%s ha già giocato: non può cambiare posto in panchina', p_bench[i]);
    end if;
  end loop;
  foreach x in array coalesce(p_trib, '{}') loop
    if player_kickoff(p_giornata, x) <= v_now and not (x = any(v_trib)) then errs := errs || format('%s ha già giocato: non può lasciare la tribuna', x); end if;
  end loop;
  if (v_prev->>'cap') <> v_cap and (player_kickoff(p_giornata, v_prev->>'cap') <= v_now or player_kickoff(p_giornata, v_cap) <= v_now) then
    errs := errs || 'Il capitano non si può cambiare: la sua partita è iniziata'::text;
  end if;
  if (v_prev->>'vice') <> v_vice and (player_kickoff(p_giornata, v_prev->>'vice') <= v_now or player_kickoff(p_giornata, v_vice) <= v_now) then
    errs := errs || 'Il vice non si può cambiare: la sua partita è iniziata'::text;
  end if;

  v_entra := array(select s from unnest(v_slots) with ordinality u(s, o) where not (s = any(p_slots)) order by o);
  v_esce  := array(select s from unnest(p_slots) with ordinality u(s, o) where not (s = any(v_slots)) order by o);
  select cambi into v_cambi from round_state where giornata = p_giornata and team_k = v_team;
  v_cambi := coalesce(v_cambi, 0);
  if v_cambi + coalesce(array_length(v_entra, 1), 0) > max_cambi then
    errs := errs || format('Cambi esauriti: ne hai usati %s su %s, questo invio ne richiede %s', v_cambi, max_cambi, coalesce(array_length(v_entra, 1), 0));
  end if;
  if coalesce(array_length(errs, 1), 0) > 0 then
    return jsonb_build_object('ok', false, 'errori', to_jsonb(errs));
  end if;
  if v_prev = p_data then
    return jsonb_build_object('ok', true, 'messaggio', 'Nessuna modifica da inviare.');
  end if;

  for i in 1..coalesce(array_length(v_entra, 1), 0) loop
    v_cambi := v_cambi + 1;
    insert into changes_log (giornata, team_k, evento, penalita, user_id) values (p_giornata, v_team,
      format('Cambio %s/%s: esce %s, entra %s', v_cambi, max_cambi, coalesce(v_esce[i], '—'), v_entra[i]),
      format('−%s (cambi: −%s)', replace((pen[v_cambi + 1] - pen[v_cambi])::text, '.', ','), replace(pen[v_cambi + 1]::text, '.', ',')), v_uid);
  end loop;
  if v_mod <> (v_prev->>'mod') then
    if v_mod <> (v_base->>'mod') and (v_prev->>'mod') = (v_base->>'mod') then
      insert into changes_log (giornata, team_k, evento, penalita, user_id) values (p_giornata, v_team, format('Cambio modulo %s → %s', v_base->>'mod', v_mod), '−1', v_uid);
    elsif v_mod = (v_base->>'mod') then
      insert into changes_log (giornata, team_k, evento, penalita, user_id) values (p_giornata, v_team, format('Ritorno al modulo consegnato %s: penalità modulo annullata', v_mod), '+1', v_uid);
    else
      insert into changes_log (giornata, team_k, evento, penalita, user_id) values (p_giornata, v_team, format('Cambio modulo %s → %s (resta diverso da %s)', v_prev->>'mod', v_mod, v_base->>'mod'), 'già contata', v_uid);
    end if;
  end if;
  if (v_prev->>'cap') <> v_cap then insert into changes_log (giornata, team_k, evento, user_id) values (p_giornata, v_team, format('Capitano: %s → %s', v_prev->>'cap', v_cap), v_uid); end if;
  if (v_prev->>'vice') <> v_vice then insert into changes_log (giornata, team_k, evento, user_id) values (p_giornata, v_team, format('Vice: %s → %s', v_prev->>'vice', v_vice), v_uid); end if;
  if coalesce(array_length(v_entra, 1), 0) = 0 and (p_bench is distinct from v_bench or p_trib is distinct from v_trib) then
    insert into changes_log (giornata, team_k, evento, user_id) values (p_giornata, v_team, 'Panchina o tribuna modificata', v_uid);
  end if;

  insert into round_state (giornata, team_k, cambi) values (p_giornata, v_team, v_cambi)
    on conflict (giornata, team_k) do update set cambi = excluded.cambi;
  update formations set data = p_data, sent_at = v_now where giornata = p_giornata and team_k = v_team;
  return jsonb_build_object('ok', true, 'messaggio', 'Formazione inviata.', 'cambi', v_cambi,
    'penalita', pen[least(v_cambi, max_cambi) + 1] + case when v_mod <> (v_base->>'mod') then 1 else 0 end);
end;
$$;

-- dopo il primo accesso con password provvisoria
create or replace function public.password_changed() returns void
language sql security definer set search_path = public as $$
  update profiles set must_change = false where user_id = auth.uid();
$$;

create or replace function public.touch_login() returns void
language sql security definer set search_path = public as $$
  update profiles set last_login = now() where user_id = auth.uid();
$$;

-- ---------- Sicurezza: regole di accesso alle righe (RLS) ------------------
alter table public.teams           enable row level security;
alter table public.players         enable row level security;
alter table public.modules         enable row level security;
alter table public.league_matches  enable row level security;
alter table public.serie_a_matches enable row level security;
alter table public.settings        enable row level security;
alter table public.profiles        enable row level security;
alter table public.formations      enable row level security;
alter table public.baselines       enable row level security;
alter table public.round_state     enable row level security;
alter table public.changes_log     enable row level security;
alter table public.votes           enable row level security;

-- dati della lega: tutti gli utenti collegati li leggono, solo il presidente li modifica
do $$ declare t text; begin
  foreach t in array array['teams','players','modules','league_matches','serie_a_matches','settings','votes'] loop
    execute format('drop policy if exists lettura on public.%I', t);
    execute format('create policy lettura on public.%I for select to authenticated using (true)', t);
    execute format('drop policy if exists scrittura_presidente on public.%I', t);
    execute format('create policy scrittura_presidente on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- profili: ognuno vede il proprio, il presidente tutti (le modifiche passano dalla funzione riservata del server)
drop policy if exists lettura on public.profiles;
create policy lettura on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- formazioni, consegne, cambi e registro: la propria squadra sempre; le altre dal primo calcio d'inizio; il presidente tutto.
-- Nessuna scrittura diretta: si passa solo da submit_formation.
do $$ declare t text; begin
  foreach t in array array['formations','baselines','round_state','changes_log'] loop
    execute format('drop policy if exists lettura on public.%I', t);
    execute format('create policy lettura on public.%I for select to authenticated using (public.is_admin() or team_k = public.my_team() or now() >= public.first_kick(giornata))', t);
  end loop;
end $$;

-- permessi di base
revoke all on all tables in schema public from anon;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.teams, public.players, public.modules, public.league_matches,
  public.serie_a_matches, public.settings, public.votes to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function public.submit_formation(int, jsonb), public.password_changed(), public.touch_login(),
  public.is_admin(), public.my_team(), public.first_kick(int), public.player_kickoff(int, text) to authenticated;
