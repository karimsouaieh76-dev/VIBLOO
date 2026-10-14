import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Api, Conversation, User } from "../api";
import type { Messenger } from "../useMessenger";
import { Avatar, Ticks } from "../components";
import { conversationTitle, formatListDate, messagePreview, messageStatus, otherMembers } from "../format";
import { enablePush, pushState, PushState } from "../push";
import { Theme, useTheme } from "../theme";

type Props = {
  me: User;
  api: Api;
  messenger: Messenger;
  onOpen: (c: Conversation) => void;
  onNewChat: () => void;
  onLogout: () => void;
};

export function ChatsScreen({ me, api, messenger, onOpen, onNewChat, onLogout }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [push, setPush] = useState<PushState>(pushState());
  const [pushError, setPushError] = useState("");
  useEffect(() => setPush(pushState()), []);

  async function turnOnPush() {
    setPushError("");
    try {
      setPush(await enablePush(api));
    } catch {
      setPushError("Non sono riuscito ad attivare le notifiche. Riprova più tardi.");
    }
  }

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? messenger.conversations.filter((c) => conversationTitle(c, me).toLowerCase().includes(q)) : messenger.conversations;
  }, [messenger.conversations, query, me]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={s.brand}>Cortile</Text>
        <Pressable onPress={onLogout} hitSlop={10} accessibilityRole="button"><Text style={s.link}>Esci</Text></Pressable>
      </View>
      {!messenger.connected && <Text style={s.offline}>In attesa di connessione…</Text>}
      {push === "default" && (
        <View style={s.banner}>
          <Text style={s.bannerText}>Attiva le notifiche per sapere quando ti scrivono, anche ad app chiusa.</Text>
          <Pressable style={s.bannerButton} onPress={turnOnPush} accessibilityRole="button">
            <Text style={s.bannerButtonText}>Attiva</Text>
          </Pressable>
        </View>
      )}
      {push === "needs-install" && (
        <View style={s.banner}>
          <Text style={s.bannerText}>
            Per ricevere le notifiche su iPhone aggiungi Cortile alla schermata Home: tasto Condividi, poi "Aggiungi alla schermata Home".
          </Text>
        </View>
      )}
      {push === "denied" && (
        <Text style={s.pushOff}>Notifiche bloccate: puoi riattivarle dalle impostazioni del browser per questo sito.</Text>
      )}
      {pushError ? <Text style={s.pushOff}>{pushError}</Text> : null}
      <View style={s.searchWrap}>
        <TextInput
          style={s.search} value={query} onChangeText={setQuery} placeholder="Cerca nelle chat"
          placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false}
        />
      </View>

      <FlatList
        data={list}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={{ paddingBottom: 96 + insets.bottom, flexGrow: 1 }}
        renderItem={({ item }) => <Row c={item} me={me} typing={Object.values(messenger.typing[item.id] ?? {})} onPress={() => onOpen(item)} t={t} />}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={
          messenger.loaded ? (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>{query ? "Nessuna chat trovata" : "Nessuna chat, per ora"}</Text>
              <Text style={s.emptyBody}>
                {query ? "Prova con un altro nome." : "Tocca il pulsante qui sotto per scrivere a qualcuno o creare un gruppo."}
              </Text>
            </View>
          ) : null
        }
      />

      <Pressable
        style={[s.fab, { bottom: 24 + insets.bottom }]} onPress={onNewChat}
        accessibilityRole="button" accessibilityLabel="Nuova chat"
      >
        <Text style={s.fabText}>＋</Text>
      </Pressable>
    </View>
  );
}

function Row({ c, me, typing, onPress, t }: { c: Conversation; me: User; typing: string[]; onPress: () => void; t: Theme }) {
  const s = styles(t);
  const title = conversationTitle(c, me);
  const other = !c.isGroup ? otherMembers(c, me)[0] : undefined;
  const last = c.lastMessage;
  const mine = last?.userId === me.id;

  let preview: React.ReactNode;
  if (typing.length) {
    preview = <Text style={s.typing} numberOfLines={1}>{c.isGroup ? `${typing[0]} sta scrivendo…` : "sta scrivendo…"}</Text>;
  } else if (last) {
    preview = (
      <View style={s.previewRow}>
        {mine && !last.deletedAt && <Ticks status={messageStatus(c, me, last)} />}
        <Text style={s.preview} numberOfLines={1}>
          {c.isGroup && !mine && !last.deletedAt ? `${last.username}: ` : ""}{messagePreview(last, me)}
        </Text>
      </View>
    );
  } else {
    preview = <Text style={s.preview} numberOfLines={1}>{c.isGroup ? "Gruppo creato" : "Scrivi il primo messaggio"}</Text>;
  }

  return (
    <Pressable style={({ pressed }) => [s.row, pressed && { backgroundColor: t.accentSoft }]} onPress={onPress}>
      <Avatar name={title} id={other?.id ?? c.id} online={other?.online} group={c.isGroup} />
      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          <Text style={[s.date, c.unread > 0 && { color: t.accent, fontWeight: "700" }]}>{formatListDate(c.updatedAt)}</Text>
        </View>
        <View style={s.rowTop}>
          <View style={{ flex: 1 }}>{preview}</View>
          {c.unread > 0 && <View style={s.badge}><Text style={s.badgeText}>{c.unread > 99 ? "99+" : c.unread}</Text></View>}
        </View>
      </View>
    </Pressable>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  brand: { fontSize: 30, fontWeight: "800", color: t.fg, letterSpacing: -0.8 },
  link: { color: t.accent, fontWeight: "600", fontSize: 15 },
  offline: { color: t.danger, fontSize: 13, paddingHorizontal: 20 },
  banner: {
    flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 16, marginTop: 6, padding: 12,
    borderRadius: 12, backgroundColor: t.accentSoft,
  },
  bannerText: { flex: 1, color: t.fg, fontSize: 14, lineHeight: 19 },
  bannerButton: { backgroundColor: t.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  bannerButtonText: { color: t.accentFg, fontWeight: "700" },
  pushOff: { color: t.muted, fontSize: 12.5, paddingHorizontal: 20, paddingTop: 4 },
  searchWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  search: { backgroundColor: t.panel, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: t.fg },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 16.5, fontWeight: "600", color: t.fg },
  date: { fontSize: 12, color: t.muted },
  previewRow: { flexDirection: "row", alignItems: "center" },
  preview: { flex: 1, fontSize: 14.5, color: t.muted },
  typing: { fontSize: 14.5, color: t.online, fontWeight: "600" },
  badge: { backgroundColor: t.online, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: t.line, marginLeft: 78 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 6 },
  emptyTitle: { fontSize: 19, fontWeight: "700", color: t.fg },
  emptyBody: { fontSize: 15, color: t.muted, textAlign: "center", maxWidth: 280 },
  fab: {
    position: "absolute", right: 20, width: 60, height: 60, borderRadius: 18, backgroundColor: t.accent,
    alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  fabText: { color: t.accentFg, fontSize: 28, fontWeight: "600", marginTop: -2 },
});
