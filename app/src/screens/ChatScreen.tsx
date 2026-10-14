import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Channel, Message, User } from "../api";
import type { Chat } from "../useChat";
import { avatarColor, Theme, useTheme } from "../theme";

type Props = { me: User; chat: Chat; channel: Channel; onBack: () => void };

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: Message; first: boolean };

const timeFmt = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long" });

function dayLabel(ts: number) {
  const d = new Date(ts).toDateString();
  const today = new Date();
  if (d === today.toDateString()) return "Oggi";
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d === y.toDateString()) return "Ieri";
  return dayFmt.format(ts);
}

// Builds rows newest-first for an inverted FlatList: day separators sit above
// their day, and consecutive messages from one person within 5 minutes group.
function buildRows(list: Message[]): Row[] {
  const rows: Row[] = [];
  let lastDay = "";
  let prev: Message | null = null;
  for (const m of list) {
    const day = dayLabel(m.createdAt);
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

export function ChatScreen({ me, chat, channel, onBack }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [noMore, setNoMore] = useState(false);
  const typingOn = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const list = chat.messages[channel.id];
  const rows = useMemo(() => buildRows(list ?? []), [list]);
  const typers = Object.values(chat.typing[channel.id] ?? {});

  useEffect(() => {
    setLoading(true);
    chat.openChannel(channel.id)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    return () => {
      chat.openChannel(null);
      setTypingState(false);
    };
  }, [channel.id]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  function setTypingState(on: boolean) {
    clearTimeout(typingTimer.current);
    if (on) typingTimer.current = setTimeout(() => setTypingState(false), 4000);
    if (typingOn.current === on) return;
    typingOn.current = on;
    chat.sendTyping(channel.id, on);
  }

  function onChange(value: string) {
    setText(value);
    setTypingState(value.trim().length > 0);
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText("");
    setTypingState(false);
    setError("");
    try {
      await chat.send(channel.id, body);
    } catch (e) {
      setText(body);
      setError((e as Error).message || "Messaggio non inviato. Riprova.");
    }
  }

  async function loadOlder() {
    if (noMore || loading || !list?.length) return;
    const n = await chat.loadOlder(channel.id).catch(() => 0);
    if (n === 0) setNoMore(true);
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} hitSlop={12} accessibilityLabel="Torna ai canali">
          <Text style={s.back}>‹</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}># {channel.name}</Text>
        {!chat.connected && <Text style={s.offline}>offline</Text>}
      </View>

      {loading && !list ? (
        <View style={s.center}><ActivityIndicator color={t.accent} /></View>
      ) : rows.length === 0 ? (
        <View style={s.center}>
          <Text style={s.emptyTitle}>Ancora silenzio in #{channel.name}</Text>
          <Text style={s.emptyBody}>Scrivi il primo messaggio qui sotto.</Text>
        </View>
      ) : (
        <FlatList
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10 }}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => item.kind === "day"
            ? <Text style={s.day}>{item.label}</Text>
            : <Bubble m={item.m} first={item.first} mine={item.m.userId === me.id} t={t} />}
        />
      )}

      <Text style={s.typing}>
        {typers.length === 1 ? `${typers[0]} sta scrivendo…` : typers.length > 1 ? `${typers.join(", ")} stanno scrivendo…` : " "}
      </Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TextInput
          style={s.input} value={text} onChangeText={onChange} placeholder="Scrivi un messaggio"
          placeholderTextColor={t.muted} multiline maxLength={2000}
        />
        <Pressable style={[s.send, !text.trim() && { opacity: 0.4 }]} onPress={send} disabled={!text.trim()}>
          <Text style={s.sendText}>Invia</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ m, first, mine, t }: { m: Message; first: boolean; mine: boolean; t: Theme }) {
  const s = styles(t);
  return (
    <View style={[s.msg, first && { marginTop: 10 }, mine && { flexDirection: "row-reverse" }]}>
      {!mine && (first
        ? <View style={[s.avatar, { backgroundColor: avatarColor(m.userId) }]}><Text style={s.avatarText}>{m.username[0].toUpperCase()}</Text></View>
        : <View style={s.avatarSpacer} />)}
      <View style={[s.bubbleCol, mine && { alignItems: "flex-end" }]}>
        {first && (
          <Text style={s.meta}>
            {!mine && <Text style={s.author}>{m.username}  </Text>}
            {timeFmt.format(m.createdAt)}
          </Text>
        )}
        <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleOther]}>
          <Text style={[s.bubbleText, mine && { color: t.mineFg }]} selectable>{m.text}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.panel },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: t.line, backgroundColor: t.bg },
  back: { fontSize: 34, lineHeight: 34, color: t.accent, marginTop: -4 },
  title: { flex: 1, fontSize: 19, fontWeight: "700", color: t.fg },
  offline: { fontSize: 12, color: t.danger, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 6 },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: t.fg, textAlign: "center" },
  emptyBody: { color: t.muted, textAlign: "center" },
  day: { alignSelf: "center", color: t.muted, fontSize: 12, backgroundColor: t.bg, borderColor: t.line, borderWidth: 1, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 2, marginVertical: 12, overflow: "hidden" },
  msg: { flexDirection: "row", gap: 8, marginTop: 2 },
  avatar: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: 18 },
  avatarSpacer: { width: 32 },
  avatarText: { color: "#fff", fontWeight: "700" },
  bubbleCol: { flexShrink: 1, maxWidth: "80%", alignItems: "flex-start" },
  meta: { fontSize: 11, color: t.muted, marginBottom: 3 },
  author: { fontWeight: "700", color: t.fg, fontSize: 13 },
  bubble: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleOther: { backgroundColor: t.bubble, borderWidth: 1, borderColor: t.line },
  bubbleMine: { backgroundColor: t.mine },
  bubbleText: { color: t.fg, fontSize: 15, lineHeight: 21 },
  typing: { fontSize: 12, color: t.muted, paddingHorizontal: 16, paddingVertical: 2 },
  error: { color: t.danger, fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg },
  input: { flex: 1, maxHeight: 130, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 18, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 15, color: t.fg },
  send: { backgroundColor: t.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 11 },
  sendText: { color: t.accentFg, fontWeight: "700" },
});
