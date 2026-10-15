# Vibloo

App di messaggistica istantanea, in stile WhatsApp:

- chat private 1 a 1 (cerchi una persona per nome utente) e gruppi;
- elenco chat ordinato per attività, con anteprima dell'ultimo messaggio e contatore dei non letti;
- spunte ✓ inviato, ✓✓ consegnato, ✓✓ blu letto;
- "online", "ultimo accesso alle…" e "sta scrivendo…";
- messaggi mostrati subito con l'orologio e, se la rete cade, pulsante "Riprova";
- **foto** (ridotte automaticamente), **messaggi vocali** e **file** fino a 15 MB;
- **modifica** (entro 24 ore) ed **eliminazione per tutti**: tieni premuto un tuo messaggio;
- **notifiche push** quando l'app è chiusa o in secondo piano;
- **privacy**: si trova una persona solo scrivendo il suo nome utente esatto; chi ti scrive per
  la prima volta finisce in **Richieste di messaggio** (Accetta / Elimina / Blocca) e finché non
  accetti non può chiamarti né vedere se sei online o se hai letto; puoi **bloccare** chiunque
  (tre puntini in alto nella chat) e sbloccarlo dal Profilo;
- **registrazione su invito**: ci si iscrive solo con un link d'invito (Profilo → Invita amici),
  valido una volta e per 7 giorni; chi si iscrive diventa subito contatto di chi l'ha invitato.
  Il primo account di un database vuoto non ha bisogno di invito;
- **chiamate vocali e videochiamate** 1 a 1 (WebRTC): suoneria, muto, videocamera on/off, cambio
  fotocamera, notifica di chiamata in arrivo e storico delle chiamate nella chat.

### Chiamate

Voce e video viaggiano direttamente tra i due dispositivi; il server fa solo squillare e
mette in contatto. Funzionano nella versione web/installata (non in Expo Go). Su alcune reti
mobili un collegamento diretto è impossibile: in quel caso serve un server **TURN** che faccia
da ponte. Se ne crei uno gratuito (es. Metered.ca o Cloudflare Calls) e imposti `TURN_URLS`,
`TURN_USERNAME` e `TURN_CREDENTIAL`, le chiamate funzionano su qualsiasi rete.

### Notifiche

Alla prima apertura Vibloo mostra "Attiva le notifiche". Funzionano su Android, sui computer e
su iPhone/iPad (iOS 16.4 o successivo) **solo dopo** aver aggiunto Vibloo alla schermata Home.
Le notifiche richiedono un indirizzo `https://`, quindi funzionano con la versione online
(Render), non con quella sulla rete di casa (`http://192.168…`).

- `server/` — Node.js (Express + Socket.IO), database SQLite in locale o Postgres online, account con password (scrypt) e token JWT.
- `app/` — app mobile Expo (React Native) per iOS e Android, funziona anche nel browser.

## Avvio rapido (consigliato)

1. Installa **Node.js** da <https://nodejs.org> (versione LTS, basta farlo una volta).
2. Fai doppio clic su:
   - **`Avvia Vibloo (Windows).bat`** su Windows
   - **`Avvia Vibloo (Mac).command`** su Mac (la prima volta: tasto destro → Apri)
3. Si apre una finestra con un **codice QR**: inquadralo con la fotocamera del telefono
   (il telefono deve essere sulla stessa rete Wi-Fi del computer).
4. Sul telefono scegli **"Aggiungi a schermata Home"** (Safari: tasto Condividi; Chrome: menu ⋮).
   Vibloo compare tra le app, con la sua icona.

Finché la finestra resta aperta, la chat funziona. I messaggi sono salvati in `server/vibloo.db`.

Da terminale è lo stesso: `cd server && npm install && npm start`.

## Metterla online (gratis)

Servono tre account gratuiti: **GitHub** (per il codice), un database Postgres dove restano
salvati i messaggi (**Supabase** oppure **Neon**) e **Render** (il server che tiene accesa la chat).

1. **GitHub** — su <https://github.com/new> crea un repository chiamato `vibloo` e carica
   tutti i file di questa cartella ("uploading an existing file", trascinando i file).
2. **Database**, uno dei due:
   - **Supabase** — su <https://supabase.com> crea un progetto (regione Europa, password con
     sole lettere e numeri). Premi **Connect**, scegli **Session pooler** e copia l'indirizzo
     `postgresql://…`, sostituendo `[YOUR-PASSWORD]` con la password del progetto.
     Non usare "Direct connection": funziona solo in IPv6 e Render non lo supporta.
     Nel piano gratuito un progetto senza attività per 7 giorni viene messo in pausa: si
     riattiva dal pannello di Supabase.
   - **Neon** — su <https://neon.tech> crea un progetto (regione Europa). Nella pagina
     *Connect* copia la **connection string**, quella che inizia con `postgresql://`.
3. **Render** — apri questo link, sostituendo `TUONOME` con il tuo nome utente GitHub:

   `https://render.com/deploy?repo=https://github.com/TUONOME/vibloo`

   Accedi con GitHub, incolla l'indirizzo del database nel campo `DATABASE_URL` e
   premi **Deploy**.

Dopo qualche minuto Render ti dà l'indirizzo, per esempio `https://vibloo-abcd.onrender.com`.
Mandalo a chi vuoi: lo apre dal telefono e sceglie "Aggiungi a schermata Home".

Nel piano gratuito di Render il server si addormenta dopo 15 minuti senza visite: la prima
apertura successiva impiega circa un minuto. I messaggi non si perdono, perché stanno nel database.
Anche foto, vocali e file sono salvati lì: i piani gratuiti di Supabase e Neon hanno circa
0,5 GB, cioè qualche migliaio di foto.
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
| `DATABASE_URL` | —             | Postgres (Supabase, Neon…); se manca usa il file SQLite |
| `DB_FILE`    | `vibloo.db`    | file SQLite                                |
| `JWT_SECRET` | generata        | se manca viene creata e salvata (nel database online, o accanto al file SQLite) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generate | chiavi delle notifiche; se mancano vengono create e salvate nel database |
| `INVITE_ONLY` | `true` | `false` per permettere a chiunque di iscriversi senza invito |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | — | server TURN per le chiamate (facoltativo, `TURN_URLS` separati da virgola) |

## Test

```bash
cd server && npm test        # account, chat, gruppi, spunte, allegati, modifica/eliminazione, push (TEST_DATABASE_URL=… per Postgres)
cd app && npm run typecheck
```

## API

| Metodo | Percorso                                  | Descrizione                                   |
|--------|-------------------------------------------|-----------------------------------------------|
| POST   | `/api/register`, `/api/login`             | `{username, password}` → `{token, user}`      |
| GET    | `/api/me`                                 | utente corrente                               |
| GET    | `/api/users?q=`                           | trova una persona dal nome utente esatto      |
| GET    | `/api/contacts`                           | persone con una chat privata accettata        |
| GET/POST/DELETE | `/api/invites`, `/api/invites/:code` | inviti (GET `/:code` è pubblico: chi invita) |
| POST   | `/api/conversations/:id/accept`, `/decline` | accetta o elimina una richiesta di messaggio |
| GET/POST/DELETE | `/api/blocks`, `/api/blocks/:userId` | persone bloccate                           |
| GET    | `/api/conversations`                      | le mie chat, con membri, ultimo messaggio e non letti |
| POST   | `/api/conversations`                      | `{userId}` chat privata, `{name, userIds}` gruppo |
| GET    | `/api/conversations/:id/messages?before=` | 50 messaggi alla volta                        |
| POST   | `/api/conversations/:id/attachments`      | carica un file (corpo grezzo, `x-file-name`)  |
| GET    | `/api/attachments/:id?token=`             | scarica un file (con supporto `Range`)        |
| GET/POST | `/api/push/key`, `/api/push/subscribe`, `/api/push/unsubscribe` | notifiche push |
| GET    | `/api/call-config`                        | server STUN/TURN per le chiamate              |

Socket.IO (token in `auth.token`). Il client invia `message:send`, `message:edit`, `message:delete`
(con ack), `delivered`, `read`, `typing`, `visibility` e per le chiamate `call:invite`, `call:accept`,
`call:decline`, `call:hangup`, `call:signal`; il server invia `message:new`, `message:update`,
`conversation:new`, `receipt`, `typing`, `presence`, `call:incoming`, `call:accepted`, `call:signal`
e `call:ended`.

## Pubblicare sugli store

Per un'app nativa su App Store / Play Store usa EAS Build (`cd app && npx eas build`).
