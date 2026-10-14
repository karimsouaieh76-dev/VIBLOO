import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Conversation, User } from "../api";
import type { ChatMessage, Messenger } from "../useMessenger";
import { Avatar, Ticks } from "../components";
import { conversationTitle, formatDay, formatLastSeen, formatTime, messageStatus, otherMembers, Status } from "../format";
import { avatarColor, Theme, useTheme } from "../theme";

type Props = { me: User; messenger: Messenger; conversation: Conversation; onBack: () => void };

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: ChatMessage; first: boolean };

// Rows newest-first for an inverted FlatList: day chips sit above their day and
// consecutive messages from one person within 5 minutes form a group.
function buildRows(list: ChatMessage[]): Row[] {
  const rows: Row[] = [];
  let lastDay = "";
  let prev: ChatMessage | null = null;
  for (const m of list) {
    const day = formatDay(m.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `d${m.id}`, label: day });
      lastDay = day;
      prev = null;
    }
    const first = !prev || prev.userId !== m.userId || m.createdAt - prev.createdAt > 5 * 60 * 1000;
    rows.push({ kind: "msg", key: `m${m.id}`, m, first });
    prev = m;
  }
  return rows.reverse();
}

export function ChatScreen({ me, messenger, conversation: initial, onBack }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noMore, setNoMore] = useState(false);
  const typingOn = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keep receipts and presence live by reading the conversation from the store.
  const c = messenger.conversations.find((x) => x.id === initial.id) ?? initial;
  const list = messenger.messages[c.id];
  const rows = useMemo(() => buildRows(list ?? []), [list]);
  const title = conversationTitle(c, me);
  const others = otherMembers(c, me);
  const typers = Object.values(messenger.typing[c.id] ?? {});

  let subtitle: string;
  if (typers.length) subtitle = c.isGroup ? `${typers.join(", ")} sta scrivendo…` : "sta scrivendo…";
  else if (c.isGroup) subtitle = ["Tu", ...others.map((o) => o.username)].join(", ");
  else subtitle = others[0] ? formatLastSeen(others[0]) : "";

  useEffect(() => {
    setLoading(true);
    messenger.openConversation(c.id)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    return () => {
      messenger.openConversation(null);
      setTypingState(false);
    };
  }, [c.id]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  function setTypingState(on: boolean) {
    clearTimeout(typingTimer.current);
    if (on) typingTimer.current = setTimeout(() => setTypingState(false), 4000);
    if (typingOn.current === on) return;
    typingOn.current = on;
    messenger.sendTyping(c.id, on);
  }

  function send() {
    const body = text.trim();
    if (!body) return;
    setText("");
    setTypingState(false);
    messenger.send(c.id, body);
  }

  async function loadOlder() {
    if (noMore || loading || !list?.length) return;
    const n = await messenger.loadOlder(c.id).catch(() => 0);
    if (n === 0) setNoMore(true);
  }

  const statusOf = (m: ChatMessage): Status => m.local ?? messageStatus(c, me, m);

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} hitSlop={12} accessibilityLabel="Torna alle chat"><Text style={s.back}>‹</Text></Pressable>
        <Avatar name={title} id={others[0]?.id ?? c.id} size={40} group={c.isGroup} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          {subtitle ? (
            <Text style={[s.subtitle, typers.length > 0 && { color: t.online, fontWeight: "600" }]} numberOfLines={1}>{subtitle}</Text>
          ) : null}
        </View>
      </View>
      {!messenger.connected && <Text style={s.offline}>Connessione persa: i messaggi partiranno quando torna la rete.</Text>}

      <View style={s.body}>
        {loading && !list ? (
          <View style={s.center}><ActivityIndicator color={t.accent} /></View>
        ) : error && !list ? (
          <View style={s.center}><Text style={s.emptyBody}>{error}</Text></View>
        ) : rows.length === 0 ? (
          <View style={s.center}>
            <View style={s.hint}>
              <Text style={s.hintText}>
                {c.isGroup ? `Hai creato il gruppo "${title}". Scrivi il primo messaggio.` : `Questo è l'inizio della tua chat con ${title}.`}
              </Text>
            </View>
          </View>
        ) : (
          <FlatList
            inverted
            data={rows}
            keyExtractor={(r) => r.key}
            contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}
            onEndReached={loadOlder}
            onEndReachedThreshold={0.3}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => item.kind === "day"
              ? <View style={s.dayWrap}><Text style={s.day}>{item.label}</Text></View>
              : (
                <Bubble
                  m={item.m} first={item.first} mine={item.m.userId === me.id} showName={c.isGroup}
                  status={statusOf(item.m)} t={t}
                  onRetry={() => messenger.send(c.id, item.m.text, item.m.id)}
                  onDiscard={() => messenger.discard(c.id, item.m.id)}
                />
              )}
          />
        )}
      </View>

      <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput
          style={s.input} value={text} placeholder="Messaggio" placeholderTextColor={t.muted} multiline maxLength={4000}
          onChangeText={(v) => { setText(v); setTypingState(v.trim().length > 0); }}
          onKeyPress={(e) => {
            // On a computer keyboard Enter sends and Shift+Enter starts a new line.
            const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
            if (Platform.OS === "web" && ev.key === "Enter" && !ev.shiftKey) {
              (e as unknown as { preventDefault(): void }).preventDefault();
              send();
            }
          }}
        />
        <Pressable
          style={[s.send, !text.trim() && { opacity: 0.45 }]} onPress={send} disabled={!text.trim()}
          accessibilityRole="button" accessibilityLabel="Invia"
        >
          <Text style={s.sendIcon}>➤</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ m, first, mine, showName, status, t, onRetry, onDiscard }: {
  m: ChatMessage; first: boolean; mine: boolean; showName: boolean; status: Status; t: Theme;
  onRetry: () => void; onDiscard: () => void;
}) {
  const s = styles(t);
  return (
    <View style={[s.msgRow, first && { marginTop: 8 }, mine ? { justifyContent: "flex-end" } : null]}>
      <View style={[s.bubble, mine ? s.mine : s.theirs, first && (mine ? s.mineFirst : s.theirsFirst)]}>
        {showName && !mine && first && <Text style={[s.author, { color: avatarColor(m.userId) }]}>{m.username}</Text>}
        <View style={s.content}>
          <Text style={[s.text, mine && { color: t.mineFg }]} selectable>{m.text}</Text>
          <View style={s.meta}>
            <Text style={s.time}>{formatTime(m.createdAt)}</Text>
            {mine && <Ticks status={status} size={12} />}
          </View>
        </View>
      </View>
      {status === "failed" && (
        <View style={s.failed}>
          <Text style={s.failedText}>Non inviato.</Text>
          <Pressable onPress={onRetry} hitSlop={8}><Text style={s.failedAction}>Riprova</Text></Pressable>
          <Pressable onPress={onDiscard} hitSlop={8}><Text style={s.failedAction}>Elimina</Text></Pressable>
        </View>
      )}
    </View>
  );
}

// Browsers draw a focus ring on text fields; the rounded field is enough here.
const noOutline = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.chatBg },
  header: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 10,
    backgroundColor: t.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line,
  },
  back: { fontSize: 34, lineHeight: 36, color: t.accent, paddingRight: 2 },
  title: { fontSize: 17, fontWeight: "700", color: t.fg },
  subtitle: { fontSize: 12.5, color: t.muted, marginTop: 1 },
  offline: { backgroundColor: t.accentSoft, color: t.fg, fontSize: 13, textAlign: "center", paddingVertical: 6, paddingHorizontal: 12 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyBody: { color: t.muted, textAlign: "center" },
  hint: { backgroundColor: t.panel, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, maxWidth: 300 },
  hintText: { color: t.muted, textAlign: "center", fontSize: 13.5 },
  dayWrap: { alignItems: "center", marginVertical: 10 },
  day: { backgroundColor: t.panel, color: t.muted, fontSize: 12, fontWeight: "600", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden" },
  msgRow: { flexDirection: "row", marginTop: 2 },
  bubble: { maxWidth: "82%", borderRadius: 12, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 6 },
  mine: { backgroundColor: t.mine },
  theirs: { backgroundColor: t.bubble },
  mineFirst: { borderTopRightRadius: 3 },
  theirsFirst: { borderTopLeftRadius: 3 },
  author: { fontSize: 13, fontWeight: "700", color: t.accent, marginBottom: 2 },
  // Text and time share a wrapping row: the time sits beside short messages
  // and drops to its own line, right-aligned, under long ones.
  content: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", columnGap: 8 },
  text: { fontSize: 15.5, lineHeight: 21, color: t.fg, flexShrink: 1 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto", marginBottom: -1 },
  time: { fontSize: 11, color: t.muted },
  failed: { position: "absolute", right: 4, bottom: -18, flexDirection: "row", gap: 10 },
  failedText: { color: t.danger, fontSize: 12 },
  failedAction: { color: t.accent, fontSize: 12, fontWeight: "700" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 8, paddingTop: 8, backgroundColor: t.chatBg },
  input: {
    flex: 1, maxHeight: 140, backgroundColor: t.bg, borderRadius: 22, paddingHorizontal: 16,
    paddingTop: 11, paddingBottom: 11, fontSize: 16, color: t.fg, ...noOutline,
  },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
  sendIcon: { color: t.accentFg, fontSize: 19, marginLeft: 3 },
});
