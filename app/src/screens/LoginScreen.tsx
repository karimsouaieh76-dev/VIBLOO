import { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { createApi, SAME_ORIGIN, User } from "../api";
import { Theme, useTheme } from "../theme";
import { Logo } from "../Logo";

type Props = {
  initialServerUrl: string;
  initialInvite?: string | null; // from an invitation link
  onLoggedIn: (session: { serverUrl: string; token: string; user: User }) => void;
};

export function LoginScreen({ initialServerUrl, initialInvite, onLoggedIn }: Props) {
  const t = useTheme();
  const s = styles(t);
  const [mode, setMode] = useState<"login" | "register">(initialInvite ? "register" : "login");
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [invite, setInvite] = useState(initialInvite ?? "");
  const [inviter, setInviter] = useState<string | null>(null);

  // Show who sent the invitation as soon as the code is complete.
  useEffect(() => {
    const code = invite.toUpperCase().replace(/[^A-Z0-9]/g, "");
    setInviter(null);
    if (code.length !== 8) return;
    let cancelled = false;
    createApi(serverUrl.trim()).checkInvite(code)
      .then((r) => { if (!cancelled) setInviter(r.valid ? r.inviter : ""); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [invite, serverUrl]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (!username.trim() || !password) return setError("Inserisci nome utente e password.");
    setBusy(true);
    try {
      const api = createApi(serverUrl.trim());
      const res = mode === "login"
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password, invite.trim() || undefined);
      onLoggedIn({ serverUrl: serverUrl.trim(), ...res });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={{ marginBottom: 6 }}><Logo height={54} /></View>
        <Text style={s.tagline}>Scrivi a chi vuoi, subito.</Text>

        <View style={s.tabs}>
          {(["login", "register"] as const).map((m) => (
            <Pressable key={m} onPress={() => { setMode(m); setError(""); }} style={[s.tab, mode === m && s.tabOn]}>
              <Text style={[s.tabText, mode === m && s.tabTextOn]}>{m === "login" ? "Accedi" : "Registrati"}</Text>
            </Pressable>
          ))}
        </View>

        {mode === "register" && (
          <>
            <Text style={s.label}>Codice invito</Text>
            <TextInput
              style={[s.input, s.mono]} value={invite} onChangeText={setInvite}
              autoCapitalize="characters" autoCorrect={false} placeholder="es. K7PM-3QXA" placeholderTextColor={t.muted}
            />
            {inviter ? (
              <Text style={s.inviteOk}>✓ Ti ha invitato {inviter}: sarete subito in contatto.</Text>
            ) : inviter === "" ? (
              <Text style={s.error}>Questo invito non è valido, è già stato usato o è scaduto.</Text>
            ) : (
              <Text style={s.inviteHint}>Vibloo è su invito: chiedi il link a chi lo usa già.</Text>
            )}
          </>
        )}

        <Text style={s.label}>Nome utente</Text>
        <TextInput
          style={s.input} value={username} onChangeText={setUsername}
          autoCapitalize="none" autoCorrect={false} autoComplete="username" placeholder="es. giulia.r"
          placeholderTextColor={t.muted}
        />
        <Text style={s.label}>Password</Text>
        <TextInput
          style={s.input} value={password} onChangeText={setPassword} secureTextEntry
          autoComplete={mode === "login" ? "password" : "new-password"}
          placeholder={mode === "register" ? "almeno 8 caratteri" : ""} placeholderTextColor={t.muted}
          onSubmitEditing={submit}
        />
        {!SAME_ORIGIN && (
          <>
            <Text style={s.label}>Indirizzo del server</Text>
            <TextInput
              style={[s.input, s.mono]} value={serverUrl} onChangeText={setServerUrl}
              autoCapitalize="none" autoCorrect={false} keyboardType="url"
            />
          </>
        )}

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable style={[s.button, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color={t.accentFg} /> : (
            <Text style={s.buttonText}>{mode === "login" ? "Accedi" : "Crea account"}</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  content: { padding: 24, paddingTop: 64, gap: 8, maxWidth: 440, width: "100%", alignSelf: "center" },
  tagline: { fontSize: 16, color: t.muted, marginBottom: 24 },
  tabs: { flexDirection: "row", backgroundColor: t.panel, borderRadius: 12, padding: 4, borderWidth: 1, borderColor: t.line, marginBottom: 12 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  tabOn: { backgroundColor: t.accent },
  tabText: { color: t.muted, fontWeight: "600" },
  tabTextOn: { color: t.accentFg },
  label: { fontSize: 12, fontWeight: "600", color: t.muted, textTransform: "uppercase", letterSpacing: 0.8, marginTop: 8 },
  input: { backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: t.fg },
  mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 14 },
  inviteOk: { color: t.online, fontSize: 13.5, fontWeight: "600" },
  inviteHint: { color: t.muted, fontSize: 13 },
  error: { color: t.danger, marginTop: 8 },
  button: { backgroundColor: t.accent, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 20 },
  buttonText: { color: t.accentFg, fontWeight: "700", fontSize: 16 },
});
