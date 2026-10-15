import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Api, Conversation, Person, User } from "../api";
import { ActionSheet, Avatar } from "../components";
import { Theme, useTheme } from "../theme";

type Props = {
  api: Api;
  me: User;
  conversation: Conversation;
  visible: boolean;
  onClose: () => void;
  onLeft: () => void; // I left the group
};

// Group details: name, members, add/remove people (admin), leave.
export function GroupInfoScreen({ api, me, conversation: c, visible, onClose, onLeft }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const isAdmin = c.createdBy === me.id;
  const [name, setName] = useState(c.name ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removeFor, setRemoveFor] = useState<User | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => { setName(c.name ?? ""); }, [c.name]);
  useEffect(() => { if (!visible) { setError(""); setAdding(false); } }, [visible]);

  async function run(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rename = () => run(async () => {
    if (name.trim() && name.trim() !== c.name) await api.renameGroup(c.id, name.trim());
  });

  const members = [...c.members].sort((a, b) =>
    (a.id === me.id ? -1 : b.id === me.id ? 1 : 0) || (a.id === c.createdBy ? -1 : b.id === c.createdBy ? 1 : 0)
    || a.username.localeCompare(b.username));

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={adding ? () => setAdding(false) : onClose} hitSlop={12} accessibilityLabel="Indietro">
            <Ionicons name="chevron-back" size={28} color={t.accent} />
          </Pressable>
          <Text style={s.title}>{adding ? "Aggiungi persone" : "Info gruppo"}</Text>
        </View>

        {adding ? (
          <AddPeople api={api} t={t} exclude={new Set(c.members.map((m) => m.id))} onDone={(ids) => run(async () => {
            await api.addMembers(c.id, ids);
            setAdding(false);
          })} busy={busy} error={error} />
        ) : (
          <ScrollView contentContainerStyle={[s.body, { paddingBottom: insets.bottom + 32 }]}>
            <View style={{ alignItems: "center", gap: 8 }}>
              <Avatar name={c.name ?? "Gruppo"} id={c.id} size={96} group />
              <Text style={s.count}>{c.members.length} partecipanti</Text>
            </View>

            <Text style={s.section}>Nome del gruppo</Text>
            <View style={s.nameRow}>
              <TextInput
                style={s.input} value={name} onChangeText={setName} maxLength={40} onSubmitEditing={rename}
                placeholder="Nome del gruppo" placeholderTextColor={t.muted}
              />
              {name.trim() && name.trim() !== c.name ? (
                <Pressable style={s.saveBtn} onPress={rename} disabled={busy} accessibilityRole="button">
                  <Text style={s.saveText}>Salva</Text>
                </Pressable>
              ) : null}
            </View>
            {error ? <Text style={s.error}>{error}</Text> : null}

            <Text style={s.section}>Partecipanti</Text>
            <View style={s.card}>
              {isAdmin && (
                <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={() => setAdding(true)} accessibilityRole="button">
                  <View style={s.addIcon}><Ionicons name="person-add" size={20} color={t.accentFg} /></View>
                  <Text style={[s.rowText, { color: t.accent, fontWeight: "700" }]}>Aggiungi persone</Text>
                </Pressable>
              )}
              {members.map((m) => (
                <Pressable
                  key={m.id} style={({ pressed }) => [s.row, pressed && isAdmin && m.id !== me.id && s.pressed]}
                  onPress={isAdmin && m.id !== me.id ? () => setRemoveFor(m) : undefined}
                  accessibilityRole={isAdmin && m.id !== me.id ? "button" : undefined}
                >
                  <Avatar name={m.username} id={m.id} size={40} photo={m.avatarAt} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.rowText} numberOfLines={1}>{m.id === me.id ? "Tu" : m.username}</Text>
                    {m.status === "pending" ? <Text style={s.small}>Invito non ancora accettato</Text> : null}
                  </View>
                  {m.id === c.createdBy ? <Text style={s.adminTag}>Amministratore</Text> : null}
                </Pressable>
              ))}
            </View>
            {!isAdmin && (
              <Text style={s.small}>Solo l'amministratore del gruppo può aggiungere o togliere persone.</Text>
            )}

            <View style={[s.card, { marginTop: 20 }]}>
              <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={() => setConfirmLeave(true)} accessibilityRole="button">
                <Ionicons name="exit-outline" size={22} color={t.danger} />
                <Text style={[s.rowText, { color: t.danger, fontWeight: "700" }]}>Esci dal gruppo</Text>
              </Pressable>
            </View>
          </ScrollView>
        )}

        <ActionSheet
          visible={removeFor != null} onClose={() => setRemoveFor(null)}
          options={removeFor ? [{
            label: `Togli ${removeFor.username} dal gruppo`, danger: true,
            onPress: () => { const u = removeFor; run(() => api.removeMember(c.id, u.id)); },
          }] : []}
        />
        <ActionSheet
          visible={confirmLeave} onClose={() => setConfirmLeave(false)}
          title={isAdmin && c.members.length > 1
            ? "Sei l'amministratore: il ruolo passerà a chi è nel gruppo da più tempo. Non vedrai più i messaggi del gruppo."
            : "Non vedrai più i messaggi del gruppo e non potrai rientrare da solo."}
          options={[{
            label: "Esci dal gruppo", danger: true,
            onPress: () => run(async () => { await api.removeMember(c.id, me.id); onLeft(); }),
          }]}
        />
      </View>
    </Modal>
  );
}

// Contacts to pick, plus an exact username search for anyone else.
function AddPeople({ api, t, exclude, onDone, busy, error }: {
  api: Api; t: Theme; exclude: Set<number>; onDone: (ids: number[]) => void; busy: boolean; error: string;
}) {
  const s = styles(t);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picked, setPicked] = useState<Person[]>([]);

  useEffect(() => {
    let cancelled = false;
    const q = query.trim().replace(/^@/, "");
    const timer = setTimeout(() => {
      (q ? api.searchUsers(q) : api.contacts())
        .then((r) => { if (!cancelled) setPeople(r.users.filter((u) => !exclude.has(u.id))); })
        .catch(() => { if (!cancelled) setPeople([]); });
    }, q ? 300 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, api]);

  const toggle = (p: Person) =>
    setPicked((list) => (list.some((x) => x.id === p.id) ? list.filter((x) => x.id !== p.id) : [...list, p]));

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <TextInput
          style={s.input} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
          placeholder="I tuoi contatti, o un nome utente esatto" placeholderTextColor={t.muted}
        />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}>
        {people == null ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : people.length === 0 ? (
          <Text style={[s.small, { padding: 16, textAlign: "center" }]}>
            {query.trim() ? "Nessuno con questo nome utente." : "Nessun contatto da aggiungere: cerca un nome utente esatto."}
          </Text>
        ) : (
          <View style={s.card}>
            {people.map((p) => {
              const on = picked.some((x) => x.id === p.id);
              return (
                <Pressable key={p.id} style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={() => toggle(p)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                  <Avatar name={p.username} id={p.id} size={40} photo={p.avatarAt} />
                  <Text style={[s.rowText, { flex: 1 }]}>{p.username}</Text>
                  <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={24} color={on ? t.accent : t.line} />
                </Pressable>
              );
            })}
          </View>
        )}
        {error ? <Text style={[s.error, { marginTop: 10 }]}>{error}</Text> : null}
      </ScrollView>
      {picked.length > 0 && (
        <Pressable style={s.doneBtn} onPress={() => onDone(picked.map((p) => p.id))} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={t.accentFg} /> : (
            <Text style={s.saveText}>Aggiungi {picked.length === 1 ? picked[0].username : `${picked.length} persone`}</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  title: { fontSize: 20, fontWeight: "700", color: t.fg },
  body: { paddingHorizontal: 16, paddingTop: 12, gap: 8, maxWidth: 520, width: "100%", alignSelf: "center" },
  count: { color: t.muted, fontSize: 14 },
  section: { marginTop: 16, fontSize: 12, fontWeight: "600", color: t.muted, textTransform: "uppercase", letterSpacing: 0.8 },
  nameRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 11, fontSize: 16, color: t.fg,
  },
  saveBtn: { backgroundColor: t.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12 },
  saveText: { color: t.accentFg, fontWeight: "700", fontSize: 15 },
  card: {
    borderRadius: 14, backgroundColor: t.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, overflow: "hidden",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  pressed: { backgroundColor: t.accentSoft },
  rowText: { fontSize: 16, color: t.fg, fontWeight: "500" },
  small: { color: t.muted, fontSize: 13 },
  adminTag: { color: t.accent, fontSize: 12, fontWeight: "700" },
  addIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
  error: { color: t.danger, fontSize: 14 },
  doneBtn: {
    position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: t.accent, borderRadius: 14, paddingVertical: 15,
    alignItems: "center",
  },
});
