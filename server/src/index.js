import { createServer } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;
let secret = process.env.JWT_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === "production") {
    console.error("Imposta JWT_SECRET prima di avviare il server in produzione.");
    process.exit(1);
  }
  secret = "cortile-dev-secret";
  console.warn("JWT_SECRET non impostato: uso una chiave di sviluppo. Non usarla in produzione.");
}

const { httpServer } = createServer({ dbFile: process.env.DB_FILE || "cortile.db", secret });
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Cortile server in ascolto su http://0.0.0.0:${PORT}`);
});
