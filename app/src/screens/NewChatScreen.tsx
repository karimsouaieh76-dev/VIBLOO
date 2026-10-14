import { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Api, Conversation, Person } from "../api";
import { Avatar } from "../components";
import { formatLastSeen } from "../format";
import { Theme, useTheme } from "../theme";

type Props = {
  api: Api;
  onBack: () => void;
  onOpened: (c: Conversation) => void;
};

export function NewChatScreen({ api, onBack, onOpened }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [groupMode, setGroupMode] = useState(false);
  const [selected, setSelected] = useState<Person[]>([]);
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  // Debounced search; an empty query lists everyone (up to 30).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.searchUsers(query.trim())
        .then((r) => { if (!cancelled) setPeople(r.users); })
        .catch((e) => { if (!cancelled) setError((e as Error).message); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, api]);

  async function openDirect(p: Person) {
    setBusy(true);
    setError("");
    try {
      onOpened((await api.openDirect(p.id)).conversation);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function createGroup() {
    setError("");
    if (!groupName.trim()) return setError("Dai un nome al gruppo.");
    if (!selected.length) return setError("Scegli almeno una persona.");
    setBusy(true);
    try {
      onOpened((await api.createGroup(groupName.trim(), selected.map((p) => p.id))).conversation);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const toggle = (p: Person) =>
    setSelected((list) => (list.some((x) => x.id === p.id) ? list.filter((x) => x.id !== p.id) : [...list, p]));

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={groupMode ? () => { setGroupMode(false); setSelected([]); } : onBack} hitSlop={12} accessibilityLabel="Indietro">
          <Text style={s.back}>‹</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{groupMode ? "Nuovo gruppo" : "Nuova chat"}</Text>
          {groupMode && <Text style={s.subtitle}>{selected.length ? `${selected.length} selezionati` : "Scegli i partecipanti"}</Text>}
        </View>
      </View>

      {groupMode && (
        <View style={s.groupBox}>
          <TextInput
            style={s.input} value={groupName} onChangeText={setGroupName} placeholder="Nome del gruppo"
            placeholderTextColor={t.muted} maxLength={40}
          />
          {selected.length > 0 && (
            <Text style={s.chips} numberOfLines={2}>{selected.map((p) => p.username).join(", ")}</Text>
          )}
        </View>
      )}

      <View style={s.searchWrap}>
        <TextInput
          style={s.input} value={query} onChangeText={setQuery} placeholder="Cerca per nome utente"
          placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} autoFocus
        />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}

      <FlatList
        data={people ?? []}
        keyExtractor={(p) => String(p.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 110 + insets.bottom }}
        ListHeaderComponent={!groupMode ? (
          <Pressable style={({ pressed }) => [s.row, pressed && { backgroundColor: t.accentSoft }]} onPress={() => setGroupMode(true)}>
            <View style={s.groupIcon}><Text style={s.groupIconText}>#</Text></View>
            <Text style={s.name}>Nuovo gruppo</Text>
          </Pressable>
        ) : null}
        ListEmptyComponent={
          people == null ? <ActivityIndicator color={t.accent} style={{ marginTop: 24 }} /> : (
            <Text style={s.empty}>
              {query ? `Nessuno si chiama "${query}". Controlla il nome utente.` : "Non ci sono ancora altre persone. Invita qualcuno a registrarsi."}
            </Text>
          )
        }
        renderItem={({ item }) => {
          const on = selected.some((p) => p.id === item.id);
          return (
            <Pressable
              style={({ pressed }) => [s.row, pressed && { backgroundColor: t.accentSoft }]}
              onPress={() => (groupMode ? toggle(item) : openDirect(item))} disabled={busy}
            >
              <Avatar name={item.username} id={item.id} size={44} online={item.online} photo={item.avatarAt} />
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.username}</Text>
                {formatLastSeen(item) ? <Text style={s.seen}>{formatLastSeen(item)}</Text> : null}
              </View>
              {groupMode && <View style={[s.check, on && s.checkOn]}>{on && <Text style={s.checkMark}>✓</Text>}</View>}
            </Pressable>
          );
        }}
      />

      {groupMode && (
        <Pressable
          style={[s.create, { bottom: 24 + insets.bottom }, (busy || !selected.length) && { opacity: 0.5 }]}
          onPress={createGroup} disabled={busy}
        >
          {busy ? <ActivityIndicator color={t.accentFg} /> : <Text style={s.createText}>Crea gruppo</Text>}
        </Pressable>
      )}
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  back: { fontSize: 34, lineHeight: 36, color: t.accent },
  title: { fontSize: 20, fontWeight: "700", color: t.fg },
  subtitle: { fontSize: 13, color: t.muted },
  groupBox: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
  chips: { color: t.accent, fontSize: 14, fontWeight: "600" },
  searchWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  input: { backgroundColor: t.panel, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, color: t.fg },
  error: { color: t.danger, paddingHorizontal: 16, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  name: { fontSize: 16, fontWeight: "600", color: t.fg },
  seen: { fontSize: 13, color: t.muted, marginTop: 1 },
  groupIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
  groupIconText: { color: t.accentFg, fontWeight: "800", fontSize: 18 },
  empty: { color: t.muted, textAlign: "center", padding: 24, fontSize: 15 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: t.line, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: t.accent, borderColor: t.accent },
  checkMark: { color: t.accentFg, fontWeight: "800", fontSize: 13 },
  create: { position: "absolute", left: 16, right: 16, backgroundColor: t.accent, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  createText: { color: t.accentFg, fontWeight: "700", fontSize: 16 },
});
