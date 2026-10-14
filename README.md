# Cortile

App di messaggistica istantanea, in stile WhatsApp:

- chat private 1 a 1 (cerchi una persona per nome utente) e gruppi;
- elenco chat ordinato per attività, con anteprima dell'ultimo messaggio e contatore dei non letti;
- spunte ✓ inviato, ✓✓ consegnato, ✓✓ blu letto;
- "online", "ultimo accesso alle…" e "sta scrivendo…";
- messaggi mostrati subito con l'orologio e, se la rete cade, pulsante "Riprova".

- `server/` — Node.js (Express + Socket.IO), database SQLite in locale o Postgres online, account con password (scrypt) e token JWT.
- `app/` — app mobile Expo (React Native) per iOS e Android, funziona anche nel browser.

## Avvio rapido (consigliato)

1. Installa **Node.js** da <https://nodejs.org> (versione LTS, basta farlo una volta).
2. Fai doppio clic su:
   - **`Avvia Cortile (Windows).bat`** su Windows
   - **`Avvia Cortile (Mac).command`** su Mac (la prima volta: tasto destro → Apri)
3. Si apre una finestra con un **codice QR**: inquadralo con la fotocamera del telefono
   (il telefono deve essere sulla stessa rete Wi-Fi del computer).
4. Sul telefono scegli **"Aggiungi a schermata Home"** (Safari: tasto Condividi; Chrome: menu ⋮).
   Cortile compare tra le app, con la sua icona.

Finché la finestra resta aperta, la chat funziona. I messaggi sono salvati in `server/cortile.db`.

Da terminale è lo stesso: `cd server && npm install && npm start`.

## Metterla online (gratis)

Servono tre account gratuiti: **GitHub** (per il codice), **Neon** (il database dove restano
salvati i messaggi) e **Render** (il server che tiene accesa la chat).

1. **GitHub** — su <https://github.com/new> crea un repository chiamato `cortile` e carica
   tutti i file di questa cartella ("uploading an existing file", trascinando i file).
2. **Neon** — su <https://neon.tech> crea un progetto (regione Europa). Nella pagina
   *Connect* copia la **connection string**, quella che inizia con `postgresql://`.
3. **Render** — apri questo link, sostituendo `TUONOME` con il tuo nome utente GitHub:

   `https://render.com/deploy?repo=https://github.com/TUONOME/cortile`

   Accedi con GitHub, incolla la connection string di Neon nel campo `DATABASE_URL` e
   premi **Deploy**.

Dopo qualche minuto Render ti dà l'indirizzo, per esempio `https://cortile-abcd.onrender.com`.
Mandalo a chi vuoi: lo apre dal telefono e sceglie "Aggiungi a schermata Home".

Nel piano gratuito di Render il server si addormenta dopo 15 minuti senza visite: la prima
apertura successiva impiega circa un minuto. I messaggi non si perdono, perché stanno su Neon.
Ogni modifica caricata su GitHub viene pubblicata da sola.

`Dockerfile` serve se preferisci un altro servizio (Railway, Fly.io, una VPS).

## Sviluppo dell'app mobile (Expo)

L'app in `app/` è React Native: oltre alla versione web servita dal server può diventare
un'app nativa per gli store.

```bash
cd app
npm install
npx expo start            # anteprima con Expo Go
npm run build:web         # rigenera la versione web in server/public
```

Con Expo Go, nella schermata di accesso scrivi l'indirizzo del server mostrato all'avvio
(per esempio `http://192.168.1.20:3000`).

## Variabili del server

| Variabile    | Default         | Note                                       |
|--------------|-----------------|--------------------------------------------|
| `PORT`       | `3000`          |                                            |
| `DATABASE_URL` | —             | Postgres (es. Neon); se manca usa il file SQLite |
| `DB_FILE`    | `cortile.db`    | file SQLite                                |
| `JWT_SECRET` | generata        | se manca viene creata e salvata accanto al database |

## Test

```bash
cd server && npm test        # account, chat private, gruppi, spunte, presenza (TEST_DATABASE_URL=… per Postgres)
cd app && npm run typecheck
```

## API

| Metodo | Percorso                                  | Descrizione                                   |
|--------|-------------------------------------------|-----------------------------------------------|
| POST   | `/api/register`, `/api/login`             | `{username, password}` → `{token, user}`      |
| GET    | `/api/me`                                 | utente corrente                               |
| GET    | `/api/users?q=`                           | cerca persone per nome utente                 |
| GET    | `/api/conversations`                      | le mie chat, con membri, ultimo messaggio e non letti |
| POST   | `/api/conversations`                      | `{userId}` chat privata, `{name, userIds}` gruppo |
| GET    | `/api/conversations/:id/messages?before=` | 50 messaggi alla volta                        |

Socket.IO (token in `auth.token`). Il client invia `message:send` (con ack), `delivered`, `read`
e `typing`; il server invia `message:new`, `conversation:new`, `receipt`, `typing` e `presence`.

## Pubblicare sugli store

Per un'app nativa su App Store / Play Store usa EAS Build (`cd app && npx eas build`).
