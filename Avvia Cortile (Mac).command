#!/bin/bash
cd "$(dirname "$0")/server" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Manca Node.js. Scaricalo da https://nodejs.org (versione LTS), installalo"
  echo "  e poi fai di nuovo doppio clic su questo file."
  echo
  open https://nodejs.org
  read -r -p "Premi Invio per chiudere."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Prima installazione, attendi qualche secondo..."
  npm install --omit=dev --no-audit --no-fund
fi
npm start
