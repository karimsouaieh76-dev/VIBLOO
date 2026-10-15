import { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Api, User } from "../api";
import { Avatar } from "../components";
import { pickAvatar } from "../media";
import * as Clipboard from "expo-clipboard";
import { Share } from "react-native";
import type { Invite } from "../api";
import { Theme, useTheme } from "../theme";

type Props = {
  me: User;
  api: Api;
  avatarAt: number | null;
  onAvatarChanged: (avatarAt: number | null) => void;
  onBack: () => void;
  onLogout: () => void;
  inviteBase: string; // address invitation links point to
  onTokenChange: (token: string) => void; // after a password change
};

export function ProfileScreen({ me, api, avatarAt, onAvatarChanged, onBack, onLogout, inviteBase, onTokenChange }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState<User[] | null>(null);

  useEffect(() => {
    api.blocks().then((r) => setBlocked(r.users)).catch(() => setBlocked([]));
  }, [api]);

  async function unblock(u: User) {
    try {
      await api.unblock(u.id);
      setBlocked((list) => (list ?? []).filter((x) => x.id !== u.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  async function change() {
    setError("");
    try {
      const file = await pickAvatar();
      if (!file) return;
      setBusy(true);
      onAvatarChanged((await api.setAvatar(file)).avatarAt);
    } catch (e) {
      setError((e as Error).message || "Non sono riuscito a cambiare la foto. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await api.removeAvatar();
      onAvatarChanged(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={12} accessibilityLabel="Torna alle chat">
          <Ionicons name="chevron-back" size={28} color={t.accent} />
        </Pressable>
        <Text style={s.title}>Profilo</Text>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Pressable onPress={change} disabled={busy} accessibilityRole="button" accessibilityLabel="Cambia foto profilo">
          <Avatar name={me.username} id={me.id} size={140} photo={avatarAt} />
          <View style={s.badge}>
            {busy ? <ActivityIndicator color={t.accentFg} /> : <Ionicons name="camera" size={20} color={t.accentFg} />}
          </View>
        </Pressable>
        <Text style={s.name}>{me.username}</Text>

        <View style={s.actions}>
          <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={change} disabled={busy} accessibilityRole="button">
            <Ionicons name="image-outline" size={22} color={t.accent} />
            <Text style={s.rowText}>{avatarAt ? "Cambia foto" : "Aggiungi una foto"}</Text>
          </Pressable>
          {avatarAt ? (
            <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={remove} disabled={busy} accessibilityRole="button">
              <Ionicons name="trash-outline" size={22} color={t.danger} />
              <Text style={[s.rowText, { color: t.danger }]}>Rimuovi foto</Text>
            </Pressable>
          ) : null}
          <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={onLogout} accessibilityRole="button">
            <Ionicons name="log-out-outline" size={22} color={t.muted} />
            <Text style={[s.rowText, { color: t.muted }]}>Esci</Text>
          </Pressable>
        </View>
        {error ? <Text style={s.error}>{error}</Text> : null}
        <Text style={s.hint}>La foto la vedono tutte le persone con cui chatti, tranne chi hai bloccato.</Text>

        <InviteSection api={api} base={inviteBase} t={t} />
        <PasswordSection api={api} t={t} onTokenChange={onTokenChange} />
        <ResetForFriendSection api={api} t={t} />

        <Text style={s.section}>Persone bloccate</Text>
        <View style={s.actions}>
          {blocked == null ? (
            <ActivityIndicator color={t.accent} style={{ padding: 16 }} />
          ) : blocked.length === 0 ? (
            <Text style={[s.rowText, { color: t.muted, padding: 16, fontSize: 14 }]}>
              Nessuno. Per bloccare qualcuno apri la chat e tocca i tre puntini in alto.
            </Text>
          ) : blocked.map((u) => (
            <View key={u.id} style={s.row}>
              <Avatar name={u.username} id={u.id} size={36} />
              <Text style={[s.rowText, { flex: 1 }]}>{u.username}</Text>
              <Pressable onPress={() => unblock(u)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Sblocca ${u.username}`}>
                <Text style={{ color: t.accent, fontWeight: "700" }}>Sblocca</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <DeleteAccountSection api={api} t={t} onDeleted={onLogout} />
      </ScrollView>
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  title: { fontSize: 20, fontWeight: "700", color: t.fg },
  body: { alignItems: "center", paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40, gap: 12 },
  badge: {
    position: "absolute", right: 4, bottom: 4, width: 40, height: 40, borderRadius: 20, backgroundColor: t.accent,
    alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: t.bg,
  },
  name: { fontSize: 24, fontWeight: "700", color: t.fg, marginTop: 4 },
  actions: {
    maxWidth: 480, width: "100%", marginTop: 16, borderRadius: 14, backgroundColor: t.panel,
    borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, overflow: "hidden", alignSelf: "center",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 15 },
  pressed: { backgroundColor: t.accentSoft },
  rowText: { fontSize: 16, color: t.fg, fontWeight: "500" },
  error: { color: t.danger, textAlign: "center" },
  inviteBtn: {
    flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", backgroundColor: t.accent,
    borderRadius: 12, paddingVertical: 12,
  },
  inviteBtnText: { color: t.accentFg, fontWeight: "700", fontSize: 15 },
  freshBox: { backgroundColor: t.accentSoft, borderRadius: 12, padding: 12, gap: 6, alignItems: "center" },
  freshCode: { fontSize: 24, fontWeight: "800", letterSpacing: 2, color: t.fg, fontVariant: ["tabular-nums"] },
  freshLink: { fontSize: 12.5, color: t.muted, textAlign: "center" },
  smallBtn: {
    flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: t.bg,
  },
  smallBtnText: { color: t.accent, fontWeight: "700", fontSize: 13.5 },
  inviteRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 6 },
  inviteCode: { fontWeight: "700", color: t.fg, fontVariant: ["tabular-nums"], letterSpacing: 1 },
  inviteState: { flex: 1, color: t.muted, fontSize: 13 },
  section: {
    alignSelf: "center", maxWidth: 480, width: "100%", marginTop: 18, fontSize: 12, fontWeight: "600", color: t.muted,
    textTransform: "uppercase", letterSpacing: 0.8,
  },
  hint: { color: t.muted, fontSize: 13, textAlign: "center", marginTop: 4 },
  input: {
    backgroundColor: t.bg, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 11, fontSize: 16, color: t.fg,
  },
  small: { color: t.muted, fontSize: 13.5, lineHeight: 19 },
});

// "Cambia password": the other devices are signed out.
function PasswordSection({ api, t, onTokenChange }: { api: Api; t: Theme; onTokenChange: (token: string) => void }) {
  const s = styles(t);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setNote("");
    if (next.length < 4) return setNote("La nuova password deve avere almeno 4 caratteri.");
    setBusy(true);
    try {
      const { token } = await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setOpen(false);
      onTokenChange(token);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Text style={s.section}>Password</Text>
      <View style={[s.actions, { padding: open ? 16 : 0, gap: 10 }]}>
        {!open ? (
          <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={() => setOpen(true)} accessibilityRole="button">
            <Ionicons name="key-outline" size={22} color={t.accent} />
            <Text style={s.rowText}>Cambia password</Text>
          </Pressable>
        ) : (
          <>
            <TextInput
              style={s.input} value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password"
              placeholder="Password attuale" placeholderTextColor={t.muted}
            />
            <TextInput
              style={s.input} value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password"
              placeholder="Nuova password (almeno 4 caratteri)" placeholderTextColor={t.muted} onSubmitEditing={save}
            />
            {note ? <Text style={s.error}>{note}</Text> : null}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable style={[s.inviteBtn, { flex: 1 }]} onPress={save} disabled={busy} accessibilityRole="button">
                {busy ? <ActivityIndicator color={t.accentFg} /> : <Text style={s.inviteBtnText}>Salva</Text>}
              </Pressable>
              <Pressable
                style={[s.inviteBtn, { flex: 1, backgroundColor: t.bg }]} accessibilityRole="button"
                onPress={() => { setOpen(false); setNote(""); setCurrent(""); setNext(""); }}
              >
                <Text style={[s.inviteBtnText, { color: t.fg }]}>Annulla</Text>
              </Pressable>
            </View>
            <Text style={s.small}>Sugli altri dispositivi dovrai accedere di nuovo con la nuova password.</Text>
          </>
        )}
      </View>
    </>
  );
}

// A friend forgot the password: whoever invited them (or the admin) makes a one-time code.
function ResetForFriendSection({ api, t }: { api: Api; t: Theme }) {
  const s = styles(t);
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ code: string; username: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setNote("");
    setResult(null);
    if (!username.trim()) return setNote("Scrivi il nome utente del tuo amico.");
    setBusy(true);
    try {
      const r = await api.createPasswordReset(username.trim());
      setResult(r);
      setUsername("");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Text style={s.section}>Un amico ha dimenticato la password?</Text>
      <View style={[s.actions, { padding: 16, gap: 10 }]}>
        <Text style={s.small}>
          Se l'hai invitato tu, crea un codice di ripristino e daglielo (a voce, al telefono o in un messaggio fuori da Vibloo).
          Lui tocca «Password dimenticata?» e sceglie una nuova password. Il codice vale 24 ore, una volta sola.
        </Text>
        <TextInput
          style={s.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false}
          placeholder="Nome utente dell'amico" placeholderTextColor={t.muted} onSubmitEditing={create}
        />
        <Pressable style={s.inviteBtn} onPress={create} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={t.accentFg} /> : (
            <>
              <Ionicons name="key" size={18} color={t.accentFg} />
              <Text style={s.inviteBtnText}>Crea codice di ripristino</Text>
            </>
          )}
        </Pressable>
        {result && (
          <View style={s.freshBox}>
            <Text style={s.small}>Codice per {result.username}:</Text>
            <Text style={s.freshCode} selectable>{prettyCode(result.code)}</Text>
          </View>
        )}
        {note ? <Text style={s.error}>{note}</Text> : null}
      </View>
    </>
  );
}

const dateFmt = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long" });
const prettyCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

// "Invita amici": single-use links valid 7 days; whoever joins becomes a contact.
function InviteSection({ api, base, t }: { api: Api; base: string; t: Theme }) {
  const s = styles(t);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [inviteOnly, setInviteOnly] = useState(true);
  const [fresh, setFresh] = useState<Invite | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const linkFor = (code: string) => `${base.replace(/\/+$/, "")}/?invito=${code}`;

  const load = () => api.invites().then((r) => { setInvites(r.invites); setInviteOnly(r.inviteOnly); }).catch(() => setInvites([]));
  useEffect(() => { load(); }, [api]);

  async function create() {
    setNote("");
    setBusy(true);
    try {
      const { invite } = await api.createInvite();
      setFresh(invite);
      setInvites((list) => [invite, ...(list ?? [])]);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(code: string) {
    try {
      await Clipboard.setStringAsync(linkFor(code));
      setNote("Link copiato: incollalo in un messaggio.");
    } catch {
      setNote(`Copia a mano: ${linkFor(code)}`);
    }
  }

  async function share(code: string) {
    const message = `Ti invito su Vibloo, la nostra chat! Iscriviti da qui (vale 7 giorni, una sola volta): ${linkFor(code)}`;
    try {
      await Share.share({ message, url: linkFor(code), title: "Invito a Vibloo" });
    } catch {
      copy(code);
    }
  }

  async function cancel(code: string) {
    try {
      await api.deleteInvite(code);
      setInvites((list) => (list ?? []).filter((i) => i.code !== code));
      if (fresh?.code === code) setFresh(null);
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <>
      <Text style={s.section}>Invita amici</Text>
      <View style={[s.actions, { padding: 16, gap: 10 }]}>
        <Text style={{ color: t.muted, fontSize: 13.5, lineHeight: 19 }}>
          {inviteOnly
            ? "Su Vibloo ci si iscrive solo su invito. Ogni link vale per una persona e scade dopo 7 giorni; chi si iscrive diventa subito un tuo contatto."
            : "Manda un link: chi si iscrive da lì diventa subito un tuo contatto."}
        </Text>
        <Pressable style={s.inviteBtn} onPress={create} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={t.accentFg} /> : (
            <>
              <Ionicons name="person-add" size={18} color={t.accentFg} />
              <Text style={s.inviteBtnText}>Crea link d'invito</Text>
            </>
          )}
        </Pressable>
        {fresh && (
          <View style={s.freshBox}>
            <Text style={s.freshCode} selectable>{prettyCode(fresh.code)}</Text>
            <Text style={s.freshLink} selectable numberOfLines={2}>{linkFor(fresh.code)}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable style={s.smallBtn} onPress={() => share(fresh.code)} accessibilityRole="button">
                <Ionicons name="share-social-outline" size={16} color={t.accent} />
                <Text style={s.smallBtnText}>Condividi</Text>
              </Pressable>
              <Pressable style={s.smallBtn} onPress={() => copy(fresh.code)} accessibilityRole="button">
                <Ionicons name="copy-outline" size={16} color={t.accent} />
                <Text style={s.smallBtnText}>Copia link</Text>
              </Pressable>
            </View>
          </View>
        )}
        {note ? <Text style={{ color: t.muted, fontSize: 13 }}>{note}</Text> : null}
        {(invites ?? []).filter((i) => i.code !== fresh?.code).slice(0, 10).map((i) => (
          <View key={i.code} style={s.inviteRow}>
            <Text style={s.inviteCode}>{prettyCode(i.code)}</Text>
            <Text style={[s.inviteState, i.status === "used" && { color: t.online }]} numberOfLines={1}>
              {i.status === "used" ? `Usato da ${i.usedBy ?? "—"}` : i.status === "expired" ? "Scaduto" : `Libero · scade il ${dateFmt.format(i.expiresAt)}`}
            </Text>
            {i.status === "open" && (
              <>
                <Pressable onPress={() => share(i.code)} hitSlop={8} accessibilityLabel={`Condividi ${prettyCode(i.code)}`}>
                  <Ionicons name="share-social-outline" size={18} color={t.accent} />
                </Pressable>
                <Pressable onPress={() => cancel(i.code)} hitSlop={8} accessibilityLabel={`Annulla ${prettyCode(i.code)}`}>
                  <Ionicons name="close-circle-outline" size={19} color={t.muted} />
                </Pressable>
              </>
            )}
          </View>
        ))}
      </View>
    </>
  );
}

// Deleting the account for good, after typing the password.
function DeleteAccountSection({ api, t, onDeleted }: { api: Api; t: Theme; onDeleted: () => void }) {
  const s = styles(t);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setNote("");
    if (!password) return setNote("Scrivi la tua password per confermare.");
    setBusy(true);
    try {
      await api.deleteAccount(password);
      onDeleted();
    } catch (e) {
      setNote((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <View style={[s.actions, { marginTop: 28, padding: open ? 16 : 0, gap: 10 }]}>
      {!open ? (
        <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={() => setOpen(true)} accessibilityRole="button">
          <Ionicons name="trash-outline" size={22} color={t.danger} />
          <Text style={[s.rowText, { color: t.danger }]}>Elimina account</Text>
        </Pressable>
      ) : (
        <>
          <Text style={[s.rowText, { color: t.danger, fontWeight: "700" }]}>Eliminare l'account?</Text>
          <Text style={s.small}>
            Non si può annullare. Il tuo nome utente, la foto e le notifiche vengono cancellati e esci dai gruppi.
            I messaggi che hai già mandato restano a chi li ha ricevuti, firmati «Account eliminato».
          </Text>
          <TextInput
            style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password"
            placeholder="La tua password" placeholderTextColor={t.muted} onSubmitEditing={confirm}
          />
          {note ? <Text style={s.error}>{note}</Text> : null}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Pressable style={[s.inviteBtn, { flex: 1, backgroundColor: t.danger }]} onPress={confirm} disabled={busy} accessibilityRole="button">
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={[s.inviteBtnText, { color: "#fff" }]}>Elimina per sempre</Text>}
            </Pressable>
            <Pressable
              style={[s.inviteBtn, { flex: 1, backgroundColor: t.bg }]} accessibilityRole="button"
              onPress={() => { setOpen(false); setPassword(""); setNote(""); }}
            >
              <Text style={[s.inviteBtnText, { color: t.fg }]}>Annulla</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
