-- Collega l'utente del presidente, creato a mano in Authentication → Users
-- con email presidente@fantacrusco.local, al ruolo di presidente.
insert into public.profiles (user_id, login_id, role, must_change)
select id, 'presidente', 'admin', false from auth.users where email = 'presidente@fantacrusco.local'
on conflict (user_id) do update set role = 'admin', login_id = 'presidente', attivo = true;

-- Controllo: deve restituire una riga
select login_id, role, attivo from public.profiles where role = 'admin';
