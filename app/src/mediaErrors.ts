import { Platform } from "react-native";

type What = "call" | "video" | "voice";

// Where to switch the microphone/camera back on, for the browser in use.
function whereToAllow(): string {
  if (Platform.OS !== "web") return "Apri Impostazioni del telefono → Vibloo e attiva Microfono e Fotocamera.";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  if (ios && /CriOS/.test(ua)) {
    return "Su iPhone con Chrome: apri Impostazioni dell'iPhone → Chrome e attiva Microfono e Fotocamera. Poi ricarica la pagina e tocca \"Consenti\" quando Chrome lo chiede.";
  }
  if (ios && /FxiOS|EdgiOS/.test(ua)) {
    return "Apri Impostazioni dell'iPhone → il tuo browser e attiva Microfono e Fotocamera, poi ricarica la pagina.";
  }
  if (ios && standalone) {
    return "Apri Impostazioni dell'iPhone → Safari → Microfono (e Fotocamera) e scegli \"Chiedi\" o \"Consenti\", poi chiudi e riapri Vibloo.";
  }
  if (ios) {
    return "In Safari tocca \"aA\" (o l'icona a sinistra dell'indirizzo) → Impostazioni sito web → Microfono e Fotocamera: \"Consenti\". Poi ricarica la pagina.";
  }
  if (/Android/.test(ua)) {
    return "Tocca il lucchetto accanto all'indirizzo → Autorizzazioni → attiva Microfono e Fotocamera, poi ricarica la pagina.";
  }
  return "Clicca il lucchetto accanto all'indirizzo, consenti Microfono e Fotocamera e ricarica la pagina.";
}

// A clear message for a failed getUserMedia / recording start, by error type.
export function mediaErrorMessage(err: unknown, what: What): string {
  const name = (err as { name?: string })?.name ?? "";
  const needs = what === "video" ? "la fotocamera e il microfono" : "il microfono";
  const action = what === "voice" ? "registrare un vocale" : what === "video" ? "videochiamare" : "chiamare";
  if (Platform.OS === "web" && !navigator.mediaDevices?.getUserMedia) {
    return `Questo browser non permette di usare ${needs}. Apri Vibloo con Safari (iPhone) o Chrome (Android).`;
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return `Per ${action} Vibloo deve poter usare ${needs}, ma il permesso è negato. ${whereToAllow()}`;
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return what === "video" ? "Non trovo una fotocamera o un microfono su questo dispositivo." : "Non trovo un microfono su questo dispositivo.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return `${what === "video" ? "La fotocamera o il microfono sono" : "Il microfono è"} già in uso da un'altra app (per esempio una telefonata). Chiudila e riprova.`;
  }
  return `Non riesco a usare ${needs} (${name || "errore sconosciuto"}). Ricarica la pagina e riprova.`;
}
