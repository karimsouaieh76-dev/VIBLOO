# Cortile

App di messaggistica di gruppo: canali, messaggi in tempo reale, utenti online e indicatore "sta scrivendo".

- `server/` — Node.js (Express + Socket.IO), database SQLite integrato in Node (`node:sqlite`), account con password (scrypt) e token JWT.
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

## Metterla online (per usarla anche fuori casa)

Il progetto contiene `Dockerfile` e `render.yaml`: su [Render](https://render.com) crei un
"Blueprint" collegato al repository GitHub e ottieni un indirizzo `https://…` da condividere.
Nel piano gratuito il disco non è permanente: per non perdere i messaggi aggiungi un disco
montato su `/data`.

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
| `DB_FILE`    | `cortile.db`    | file SQLite                                |
| `JWT_SECRET` | generata        | se manca viene creata e salvata accanto al database |

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

## Pubblicare sugli store

Per un'app nativa su App Store / Play Store usa EAS Build (`cd app && npx eas build`).
