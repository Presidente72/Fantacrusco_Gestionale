# Fantacrusco Gestionale

Gestionale online della lega Fantacrusco: formazioni Mantra, blocco dei giocatori al calcio d'inizio
della loro partita, cambi tracciati con l'ora del server e penalità automatiche, classifica con bonus,
calcolo dei punteggi, accessi degli allenatori creati dal presidente.

- Sito: Vercel (piano Hobby) · Database e accessi: Supabase (piano Free)
- `index.html`, `app.js`, `config.js`: il sito
- `api/admin-users.js`: funzione riservata al presidente per gestire gli accessi
- `supabase/`: script SQL da eseguire una volta su Supabase

## Messa in funzione

### 1. Supabase
1. SQL Editor → New query → incolla `supabase/01_schema.sql` → Run.
2. Nuova query → incolla `supabase/02_dati.sql` → Run.
3. Authentication → Sign In / Providers → Email: **disattiva «Allow new users to sign up»**
   (gli account li crea solo il presidente).
4. Authentication → Users → Add user → Create new user:
   email `presidente@fantacrusco.local`, una password tua, spunta «Auto Confirm User».
5. Nuova query → incolla `supabase/03_presidente.sql` → Run (deve restituire la riga del presidente).
6. Project Settings → API Keys: crea o copia una **secret key** (`sb_secret_…`). Serve solo al punto 3.3.

### 2. GitHub
Carica tutti i file di questa cartella nel repository (Add file → Upload files), mantenendo le cartelle `api` e `supabase`.

### 3. Vercel
1. Add New → Project → importa il repository.
2. Framework Preset: **Other**. Nessun comando di build.
3. Environment Variables:
   - `SUPABASE_URL` = `https://nuhrpcfvyjmuryfbryba.supabase.co`
   - `SUPABASE_SECRET_KEY` = la secret key del punto 1.6
4. Deploy. All'indirizzo che ti dà Vercel entri con ID `presidente` e la password del punto 1.4.

### 4. Uso settimanale (presidente)
- **Impostazioni**: giornata corrente e orari della giornata di Serie A (casa;ospite;AAAA-MM-GG HH:MM).
- **Accessi**: crea ID e password provvisoria per ogni squadra.
- **Punteggi**: dopo le partite incolla i voti e salva; poi «Salva i risultati» aggiorna calendario e classifica.
- Passa alla giornata successiva da **Impostazioni**.
