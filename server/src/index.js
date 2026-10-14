import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import qrcode from "qrcode-terminal";
import { createServer } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || "cortile.db";

// Without JWT_SECRET, generate one on first start and keep it next to the
// database, so people stay logged in across restarts.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
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

const { httpServer } = createServer({ dbFile: DB_FILE, secret: loadSecret() });
httpServer.listen(PORT, "0.0.0.0", () => {
  const lan = lanAddresses();
  console.log("\n  Cortile è acceso.\n");
  console.log(`  Su questo computer:  http://localhost:${PORT}`);
  for (const url of lan) console.log(`  Sul telefono:        ${url}`);
  if (lan.length) {
    console.log("\n  Inquadra il codice con la fotocamera del telefono (stessa rete Wi-Fi):\n");
    qrcode.generate(lan[0], { small: true }, (qr) => console.log(qr.replace(/^/gm, "  ")));
  }
  console.log("  Per spegnerlo chiudi questa finestra o premi Ctrl+C.\n");
});
