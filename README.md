# Cortile

App di messaggistica di gruppo: canali, messaggi in tempo reale, utenti online e indicatore "sta scrivendo".

- `server/` — Node.js (Express + Socket.IO), database SQLite integrato in Node (`node:sqlite`), account con password (scrypt) e token JWT.
- `app/` — app mobile Expo (React Native) per iOS e Android, funziona anche nel browser.

## Avvio in locale

Serve Node.js 22.13 o più recente.

```bash
# 1. Server
cd server
npm install
npm start               # http://localhost:3000

# 2. App (in un altro terminale)
cd app
npm install
npx expo start
```

Poi scansiona il QR code con l'app **Expo Go** sul telefono, oppure premi `w` per aprirla nel browser.

**Dal telefono** `localhost` non funziona: nella schermata di accesso scrivi l'indirizzo del computer
sulla rete Wi-Fi, per esempio `http://192.168.1.20:3000`. Puoi anche impostarlo come predefinito:

```bash
EXPO_PUBLIC_SERVER_URL=http://192.168.1.20:3000 npx expo start
```

## Variabili del server

| Variabile    | Default         | Note                                       |
|--------------|-----------------|--------------------------------------------|
| `PORT`       | `3000`          |                                            |
| `DB_FILE`    | `cortile.db`    | file SQLite                                |
| `JWT_SECRET` | chiave di prova | **obbligatoria** con `NODE_ENV=production` |

## Test

```bash
cd server && npm test        # registrazione, login, canali, messaggi e typing via Socket.IO
cd app && npm run typecheck
```

## API

| Metodo | Percorso                             | Descrizione                    |
|--------|--------------------------------------|--------------------------------|
| POST   | `/api/register`                      | `{username, password}` → token |
| POST   | `/api/login`                         | `{username, password}` → token |
| GET    | `/api/me`                            | utente corrente                |
| GET    | `/api/channels`                      | elenco canali                  |
| POST   | `/api/channels`                      | `{name}` crea un canale        |
| GET    | `/api/channels/:id/messages?before=` | ultimi 50 messaggi (paginati)  |

Socket.IO (token in `auth.token`): `message:send` (con ack) e `typing`; il server invia `message:new`,
`channel:new`, `typing` e `presence`.

## Pubblicare l'app

Per installarla sui telefoni senza Expo Go usa EAS Build (`npx eas build`) e metti il server su un
host pubblico con HTTPS (Render, Railway, Fly.io, una VPS…).
