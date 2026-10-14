import { useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Channel, User } from "../api";
import type { Chat } from "../useChat";
import { avatarColor, Theme, useTheme } from "../theme";

type Props = {
  me: User;
  chat: Chat;
  onOpen: (channel: Channel) => void;
  onLogout: () => void;
};

export function ChannelsScreen({ me, chat, onOpen, onLogout }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const others = chat.online.filter((u) => u.id !== me.id);

  async function create() {
    setError("");
    if (!name.trim()) return;
    try {
      const channel = await chat.createChannel(name);
      setName("");
      onOpen(channel);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.brand}>Cortile</Text>
          <Text style={s.status}>
            {chat.connected ? `Connesso come ${me.username}` : "Connessione in corso…"}
          </Text>
        </View>
        <Pressable onPress={onLogout} hitSlop={10}><Text style={s.link}>Esci</Text></Pressable>
      </View>

      <Text style={s.label}>Online ora</Text>
      <ScrollView horizontal style={{ flexGrow: 0 }} showsHorizontalScrollIndicator={false} contentContainerStyle={s.people}>
        {others.length === 0
          ? <Text style={s.muted}>Nessun altro è collegato.</Text>
          : others.map((u) => (
            <View key={u.id} style={s.person}>
              <View style={[s.avatar, { backgroundColor: avatarColor(u.id) }]}>
                <Text style={s.avatarText}>{u.username[0].toUpperCase()}</Text>
                <View style={s.dot} />
              </View>
              <Text style={s.personName} numberOfLines={1}>{u.username}</Text>
            </View>
          ))}
      </ScrollView>

      <Text style={s.label}>Canali</Text>
      <FlatList
        data={chat.channels}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={{ paddingBottom: 12 }}
        renderItem={({ item }) => {
          const unread = chat.unread[item.id] ?? 0;
          const typers = Object.values(chat.typing[item.id] ?? {});
          return (
            <Pressable style={({ pressed }) => [s.row, pressed && { backgroundColor: t.accentSoft }]} onPress={() => onOpen(item)}>
              <Text style={s.hash}>#</Text>
              <View style={{ flex: 1 }}>
                <Text style={[s.channelName, unread > 0 && { fontWeight: "700" }]}>{item.name}</Text>
                {typers.length > 0 && <Text style={s.typing}>{typers.join(", ")} sta scrivendo…</Text>}
              </View>
              {unread > 0 && <View style={s.badge}><Text style={s.badgeText}>{unread > 99 ? "99+" : unread}</Text></View>}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={[s.muted, { paddingHorizontal: 20 }]}>Caricamento canali…</Text>}
      />

      <View style={[s.newRow, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            style={s.input} value={name} onChangeText={setName} placeholder="nuovo-canale"
            placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} onSubmitEditing={create}
          />
          <Pressable style={s.button} onPress={create}><Text style={s.buttonText}>Crea</Text></Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14 },
  brand: { fontSize: 28, fontWeight: "700", color: t.fg, letterSpacing: -0.6 },
  status: { color: t.muted, fontSize: 13 },
  link: { color: t.accent, fontWeight: "600", fontSize: 15 },
  label: { fontSize: 11, fontWeight: "600", color: t.muted, textTransform: "uppercase", letterSpacing: 1, paddingHorizontal: 20, marginTop: 10, marginBottom: 8 },
  people: { paddingHorizontal: 20, gap: 14, minHeight: 64, alignItems: "flex-start" },
  person: { alignItems: "center", width: 56 },
  avatar: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#fff", fontWeight: "700", fontSize: 17 },
  dot: { position: "absolute", right: -2, bottom: -2, width: 12, height: 12, borderRadius: 6, backgroundColor: t.online, borderWidth: 2, borderColor: t.bg },
  personName: { fontSize: 12, color: t.fg, marginTop: 4 },
  muted: { color: t.muted },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 13, gap: 10 },
  hash: { color: t.muted, fontSize: 18, fontFamily: "monospace", width: 16 },
  channelName: { color: t.fg, fontSize: 16 },
  typing: { color: t.accent, fontSize: 12, marginTop: 2 },
  badge: { backgroundColor: t.accent, borderRadius: 10, minWidth: 22, paddingHorizontal: 6, paddingVertical: 2, alignItems: "center" },
  badgeText: { color: t.accentFg, fontSize: 12, fontWeight: "700" },
  newRow: { borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.panel, paddingHorizontal: 16, paddingTop: 12, gap: 6 },
  input: { flex: 1, backgroundColor: t.bg, borderWidth: 1, borderColor: t.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: t.fg, fontSize: 15 },
  button: { backgroundColor: t.accent, borderRadius: 10, paddingHorizontal: 18, justifyContent: "center" },
  buttonText: { color: t.accentFg, fontWeight: "700" },
  error: { color: t.danger, fontSize: 13 },
});
