import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import qrcode from "qrcode-terminal";
import { createServer } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || "vibloo.db";

// Without JWT_SECRET, a local install keeps a generated one next to the SQLite
// file; with DATABASE_URL the server keeps it in the database instead.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.DATABASE_URL) return undefined;
  const file = `${DB_FILE}.secret`;
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

let httpServer;
try {
  ({ httpServer } = await createServer({
    dbFile: DB_FILE,
    databaseUrl: process.env.DATABASE_URL,
    secret: loadSecret(),
  }));
} catch (err) {
  // Say plainly what is wrong with the database link, the usual first-deploy problem.
  const msg = String(err?.message ?? err);
  console.error("\nVibloo non riesce a collegarsi al database.");
  if (/password authentication failed|SASL|Tenant or user not found/i.test(msg)) {
    console.error("→ Password o nome utente sbagliati in DATABASE_URL. Controlla di aver sostituito [YOUR-PASSWORD] (senza parentesi quadre).");
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    console.error("→ L'indirizzo del database non esiste. Copia di nuovo DATABASE_URL da Supabase (Session pooler).");
  } else if (/ENETUNREACH|EHOSTUNREACH/i.test(msg)) {
    console.error("→ Il database non è raggiungibile. Con Supabase usa il \"Session pooler\", non la \"Direct connection\".");
  } else if (/max clients|too many clients|remaining connection slots/i.test(msg)) {
    console.error("→ Troppe connessioni al database: probabilmente ci sono altri servizi Vibloo collegati allo stesso database. Eliminali.");
  } else if (/Invalid URL/i.test(msg)) {
    console.error("→ DATABASE_URL non è un indirizzo valido: deve iniziare con postgresql:// e non contenere spazi.");
  }
  console.error(`Dettaglio tecnico: ${msg}\n`);
  process.exit(1);
}
const online = Boolean(process.env.RENDER || process.env.DATABASE_URL);
httpServer.listen(PORT, "0.0.0.0", () => {
  if (online) return console.log(`Vibloo in ascolto sulla porta ${PORT}`);
  const lan = lanAddresses();
  console.log("\n  Vibloo è acceso.\n");
  console.log(`  Su questo computer:  http://localhost:${PORT}`);
  for (const url of lan) console.log(`  Sul telefono:        ${url}`);
  if (lan.length) {
    console.log("\n  Inquadra il codice con la fotocamera del telefono (stessa rete Wi-Fi):\n");
    qrcode.generate(lan[0], { small: true }, (qr) => console.log(qr.replace(/^/gm, "  ")));
  }
  console.log("  Per spegnerlo chiudi questa finestra o premi Ctrl+C.\n");
});
