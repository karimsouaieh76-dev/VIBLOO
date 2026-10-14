// Turns the Expo web export in ../server/public into an installable web app:
// copies the home-screen icons, writes the manifest and links it from index.html.
import { cpSync, readFileSync, writeFileSync } from "node:fs";

const out = new URL("../../server/public/", import.meta.url);
cpSync(new URL("../web-assets/", import.meta.url), out, { recursive: true });

writeFileSync(new URL("manifest.webmanifest", out), JSON.stringify({
  name: "Cortile",
  short_name: "Cortile",
  description: "La chat del tuo gruppo.",
  start_url: "/",
  display: "standalone",
  background_color: "#edf1f0",
  theme_color: "#1d6b60",
  lang: "it",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}, null, 2));

const indexUrl = new URL("index.html", out);
const head = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<meta name="theme-color" content="#1d6b60">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Cortile">',
].join("");
const html = readFileSync(indexUrl, "utf8")
  .replace(/<html lang="[^"]*"/, '<html lang="it"')
  .replace(/<title>[^<]*<\/title>/, "<title>Cortile</title>")
  .replace("</head>", head + "</head>");
writeFileSync(indexUrl, html);
console.log("App web pronta in server/public");
