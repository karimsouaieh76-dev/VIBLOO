import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from "expo-audio";
import type { Api, Conversation, LocalFile, User } from "../api";
import type { ChatMessage, Messenger } from "../useMessenger";
import { ActionSheet, AudioBubble, Avatar, FileBubble, PhotoThumb, PhotoViewer, SheetOption, Ticks } from "../components";
import {
  callLabel, conversationTitle, formatDay, formatDuration, formatLastSeen, formatTime, messageStatus, otherMembers,
  parseCall, Status,
} from "../format";
import { pickFile, pickPhoto, webRecordingMime } from "../media";
import { avatarColor, Theme, useTheme } from "../theme";

type Props = {
  me: User; api: Api; messenger: Messenger; conversation: Conversation; onBack: () => void;
  onCall?: (media: "audio" | "video") => void;
};

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: ChatMessage; first: boolean };

const EDIT_WINDOW = 24 * 60 * 60 * 1000;

const recordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  web: { mimeType: webRecordingMime() ?? "audio/webm", bitsPerSecond: 64000 },
};

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

export function ChatScreen({ me, api, messenger, conversation: initial, onBack, onCall }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noMore, setNoMore] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ChatMessage | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [viewer, setViewer] = useState<{ uri: string; download?: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(recordingOptions);
  const recorderState = useAudioRecorderState(recorder, 250);
  const typingOn = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<TextInput>(null);

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

  async function submit() {
    const body = text.trim();
    setError("");
    if (editing) {
      if (!body && !editing.attachment) return;
      const err = body === editing.text ? null : await messenger.editMessage(editing.id, body);
      if (err) return setError(err);
      setEditing(null);
      setText("");
      return;
    }
    if (!body) return;
    setText("");
    setTypingState(false);
    messenger.send(c.id, { text: body });
  }

  // A photo goes out with whatever is typed as its caption.
  async function attach(pick: () => Promise<LocalFile | null>) {
    setError("");
    try {
      const file = await pick();
      if (!file) return;
      const caption = file.mime.startsWith("image/") ? text.trim() : "";
      if (caption) setText("");
      messenger.send(c.id, { text: caption, file });
    } catch (e) {
      setError((e as Error).message || "Non riesco ad aprire il file.");
    }
  }

  async function startRecording() {
    setError("");
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) return setError("Per i messaggi vocali consenti a Vibloo di usare il microfono.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch {
      setError("Non riesco ad avviare il microfono su questo dispositivo.");
    }
  }

  async function stopRecording(sendIt: boolean) {
    const duration = recorderState.durationMillis;
    setRecording(false);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = recorder.uri;
      if (!sendIt || !uri) return;
      if (duration < 700) return setError("Il vocale era troppo corto: registra almeno un secondo.");
      const mime = Platform.OS === "web" ? recordingOptions.web.mimeType.split(";")[0] : "audio/mp4";
      const ext = mime === "audio/webm" ? "webm" : "m4a";
      messenger.send(c.id, { text: "", file: { uri, mime, name: `vocale-${Date.now()}.${ext}`, duration } });
    } catch {
      setError("La registrazione non è riuscita. Riprova.");
    }
  }

  async function loadOlder() {
    if (noMore || loading || !list?.length) return;
    const n = await messenger.loadOlder(c.id).catch(() => 0);
    if (n === 0) setNoMore(true);
  }

  const fileUrl = (m: ChatMessage, download = false) =>
    m.localFile?.uri ?? (m.attachment ? api.attachmentUrl(m.attachment.id, download) : "");

  function menuOptions(m: ChatMessage): SheetOption[] {
    const opts: SheetOption[] = [];
    const mine = m.userId === me.id;
    if (m.text) opts.push({ label: "Copia testo", onPress: () => { Clipboard.setStringAsync(m.text).catch(() => {}); } });
    if (m.attachment && m.kind !== "audio") opts.push({ label: "Scarica", onPress: () => Linking.openURL(fileUrl(m, true)) });
    if (mine && (m.kind === "text" || m.text) && Date.now() - m.createdAt < EDIT_WINDOW) {
      opts.push({
        label: "Modifica", onPress: () => {
          setEditing(m);
          setText(m.text);
          setTimeout(() => inputRef.current?.focus(), 50);
        },
      });
    }
    if (mine) opts.push({ label: "Elimina per tutti", danger: true, onPress: () => setConfirmDelete(m) });
    return opts;
  }

  const statusOf = (m: ChatMessage): Status => m.local ?? messageStatus(c, me, m);
  const showMic = !editing && !text.trim();

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
        {onCall && !c.isGroup && (
          <>
            <Pressable onPress={() => onCall("video")} hitSlop={8} style={s.callBtn} accessibilityRole="button" accessibilityLabel="Videochiamata">
              <Text style={s.callIcon}>📹</Text>
            </Pressable>
            <Pressable onPress={() => onCall("audio")} hitSlop={8} style={s.callBtn} accessibilityRole="button" accessibilityLabel="Chiamata vocale">
              <Text style={s.callIcon}>📞</Text>
            </Pressable>
          </>
        )}
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
                item.m.kind === "call" && !item.m.deletedAt ? (
                  <CallBubble m={item.m} me={me} t={t} onPress={onCall && !c.isGroup ? () => onCall(parseCall(item.m).media) : undefined} />
                ) : <Bubble
                  m={item.m} first={item.first} mine={item.m.userId === me.id} showName={c.isGroup}
                  status={statusOf(item.m)} t={t} url={fileUrl(item.m)}
                  onOpenPhoto={() => setViewer({ uri: fileUrl(item.m), download: item.m.local ? undefined : fileUrl(item.m, true) })}
                  onOpenFile={() => Linking.openURL(fileUrl(item.m, true))}
                  onMenu={() => { if (!item.m.local && !item.m.deletedAt) setMenuFor(item.m); }}
                  onRetry={() => messenger.send(c.id, { text: item.m.text, file: item.m.localFile }, item.m.id)}
                  onDiscard={() => messenger.discard(c.id, item.m.id)}
                />
              )}
          />
        )}
      </View>

      {error && list ? <Text style={s.error}>{error}</Text> : null}
      {editing && (
        <View style={s.editBar}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.editLabel}>Modifica messaggio</Text>
            <Text style={s.editOld} numberOfLines={1}>{editing.text}</Text>
          </View>
          <Pressable onPress={() => { setEditing(null); setText(""); }} hitSlop={10} accessibilityLabel="Annulla modifica">
            <Text style={s.editClose}>✕</Text>
          </Pressable>
        </View>
      )}

      {recording ? (
        <View style={[s.composer, s.recordBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Pressable onPress={() => stopRecording(false)} style={s.recCancel} accessibilityRole="button" accessibilityLabel="Annulla vocale">
            <Text style={s.recCancelText}>Annulla</Text>
          </Pressable>
          <View style={s.recInfo}>
            <View style={s.recDot} />
            <Text style={s.recTime}>{formatDuration(recorderState.durationMillis)}</Text>
            <Text style={s.recLabel}>Registrazione…</Text>
          </View>
          <Pressable style={s.send} onPress={() => stopRecording(true)} accessibilityRole="button" accessibilityLabel="Invia vocale">
            <Text style={s.sendIcon}>➤</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          {!editing && (
            <Pressable style={s.attach} onPress={() => setAttachOpen(true)} accessibilityRole="button" accessibilityLabel="Allega">
              <Text style={s.attachIcon}>＋</Text>
            </Pressable>
          )}
          <TextInput
            ref={inputRef}
            style={s.input} value={text} placeholder={editing ? "Nuovo testo" : "Messaggio"} placeholderTextColor={t.muted}
            multiline maxLength={4000}
            onChangeText={(v) => { setText(v); if (!editing) setTypingState(v.trim().length > 0); }}
            onKeyPress={(e) => {
              // On a computer keyboard Enter sends and Shift+Enter starts a new line.
              const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
              if (Platform.OS === "web" && ev.key === "Enter" && !ev.shiftKey) {
                (e as unknown as { preventDefault(): void }).preventDefault();
                submit();
              }
            }}
          />
          {showMic ? (
            <Pressable style={s.send} onPress={startRecording} accessibilityRole="button" accessibilityLabel="Registra vocale">
              <Text style={s.micIcon}>🎤</Text>
            </Pressable>
          ) : (
            <Pressable style={s.send} onPress={submit} accessibilityRole="button" accessibilityLabel={editing ? "Salva modifica" : "Invia"}>
              <Text style={s.sendIcon}>{editing ? "✓" : "➤"}</Text>
            </Pressable>
          )}
        </View>
      )}

      <ActionSheet
        visible={attachOpen} onClose={() => setAttachOpen(false)}
        options={[
          { label: "📷  Foto", onPress: () => attach(pickPhoto) },
          { label: "📎  Documento o file", onPress: () => attach(pickFile) },
        ]}
      />
      <ActionSheet
        visible={menuFor != null} onClose={() => setMenuFor(null)}
        options={menuFor ? menuOptions(menuFor) : []}
      />
      <ActionSheet
        visible={confirmDelete != null} onClose={() => setConfirmDelete(null)}
        title="Il messaggio verrà eliminato per tutti i partecipanti della chat."
        options={[{
          label: "Elimina per tutti", danger: true,
          onPress: async () => {
            const m = confirmDelete;
            if (!m) return;
            const err = await messenger.deleteMessage(m.id);
            if (err) setError(err);
            if (editing?.id === m.id) { setEditing(null); setText(""); }
          },
        }]}
      />
      <PhotoViewer
        uri={viewer?.uri ?? null} onClose={() => setViewer(null)}
        onDownload={viewer?.download ? () => Linking.openURL(viewer.download!) : undefined}
      />
    </KeyboardAvoidingView>
  );
}

// A call in the history: tap it to call back.
function CallBubble({ m, me, t, onPress }: { m: ChatMessage; me: User; t: Theme; onPress?: () => void }) {
  const s = styles(t);
  const mine = m.userId === me.id;
  const c = parseCall(m);
  const missed = c.status === "missed" && !mine;
  return (
    <View style={[s.msgRow, { marginTop: 8 }, mine ? { justifyContent: "flex-end" } : null]}>
      <Pressable
        onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityHint={onPress ? "Richiama" : undefined}
        style={[s.bubble, mine ? s.mine : s.theirs, s.callBubble]}
      >
        <Text style={[s.text, mine && { color: t.mineFg }, missed && { color: t.danger, fontWeight: "600" }]}>{callLabel(m, me)}</Text>
        <Text style={s.time}>{formatTime(m.createdAt)}{onPress ? "  ·  Richiama" : ""}</Text>
      </Pressable>
    </View>
  );
}

function Bubble({ m, first, mine, showName, status, t, url, onOpenPhoto, onOpenFile, onMenu, onRetry, onDiscard }: {
  m: ChatMessage; first: boolean; mine: boolean; showName: boolean; status: Status; t: Theme; url: string;
  onOpenPhoto: () => void; onOpenFile: () => void; onMenu: () => void; onRetry: () => void; onDiscard: () => void;
}) {
  const s = styles(t);
  const a = m.attachment;
  const deleted = Boolean(m.deletedAt);
  const photo = !deleted && a != null && m.kind === "image";

  return (
    <View style={[s.msgRow, first && { marginTop: 8 }, mine ? { justifyContent: "flex-end" } : null, m.local === "failed" && { marginBottom: 20 }]}>
      {m.local === "pending" && m.localFile && (
        <ActivityIndicator size="small" color={t.accent} style={{ alignSelf: "center", marginRight: 6 }} />
      )}
      <Pressable
        onLongPress={onMenu} delayLongPress={350}
        style={[s.bubble, mine ? s.mine : s.theirs, first && (mine ? s.mineFirst : s.theirsFirst), photo && s.photoBubble]}
        accessibilityHint={deleted ? undefined : "Tieni premuto per altre azioni"}
      >
        {showName && !mine && first && (
          <Text style={[s.author, { color: avatarColor(m.userId) }, photo && { paddingHorizontal: 6 }]}>{m.username}</Text>
        )}

        {deleted ? (
          <View style={s.content}>
            <Text style={s.deleted}>🚫 {mine ? "Hai eliminato questo messaggio" : "Questo messaggio è stato eliminato"}</Text>
            <Meta m={m} mine={false} status={status} t={t} />
          </View>
        ) : (
          <>
            {a && m.kind === "image" && <PhotoThumb uri={url} width={a.width} height={a.height} onPress={onOpenPhoto} onLongPress={onMenu} />}
            {a && m.kind === "audio" && <AudioBubble uri={url} duration={a.duration} mine={mine} />}
            {a && m.kind === "file" && <FileBubble name={a.name} size={a.size} onOpen={onOpenFile} onLongPress={onMenu} />}
            <View style={[s.content, photo && { paddingHorizontal: 6, paddingTop: 4 }]}>
              {m.text ? <Text style={[s.text, mine && { color: t.mineFg }]} selectable>{m.text}</Text> : null}
              <Meta m={m} mine={mine} status={status} t={t} />
            </View>
          </>
        )}
      </Pressable>
      {m.local === "failed" && (
        <View style={s.failed}>
          <Text style={s.failedText}>Non inviato.</Text>
          <Pressable onPress={onRetry} hitSlop={8}><Text style={s.failedAction}>Riprova</Text></Pressable>
          <Pressable onPress={onDiscard} hitSlop={8}><Text style={s.failedAction}>Elimina</Text></Pressable>
        </View>
      )}
    </View>
  );
}

function Meta({ m, mine, status, t }: { m: ChatMessage; mine: boolean; status: Status; t: Theme }) {
  const s = styles(t);
  return (
    <View style={s.meta}>
      {m.editedAt && !m.deletedAt ? <Text style={s.time}>modificato</Text> : null}
      <Text style={s.time}>{formatTime(m.createdAt)}</Text>
      {mine && <Ticks status={status} size={12} />}
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
  callBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  callIcon: { fontSize: 20 },
  callBubble: { gap: 2, paddingVertical: 8 },
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
  bubble: { maxWidth: "82%", borderRadius: 12, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 5 },
  photoBubble: { paddingHorizontal: 3, paddingTop: 3, paddingBottom: 4 },
  mine: { backgroundColor: t.mine },
  theirs: { backgroundColor: t.bubble },
  mineFirst: { borderTopRightRadius: 3 },
  theirsFirst: { borderTopLeftRadius: 3 },
  author: { fontSize: 13, fontWeight: "700", marginBottom: 2 },
  // Text and time share a wrapping row: the time sits beside short messages
  // and drops to its own line, right-aligned, under long ones.
  content: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", columnGap: 8 },
  text: { fontSize: 15.5, lineHeight: 21, color: t.fg, flexShrink: 1 },
  deleted: { fontSize: 14.5, fontStyle: "italic", color: t.muted, flexShrink: 1 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto", marginBottom: -1 },
  time: { fontSize: 11, color: t.muted },
  failed: { position: "absolute", right: 4, bottom: -18, flexDirection: "row", gap: 10 },
  failedText: { color: t.danger, fontSize: 12 },
  failedAction: { color: t.accent, fontSize: 12, fontWeight: "700" },
  error: { color: t.danger, fontSize: 13, paddingHorizontal: 16, paddingVertical: 4, backgroundColor: t.chatBg },
  editBar: {
    flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 8, marginTop: 4, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: t.bg, borderRadius: 12, borderLeftWidth: 4, borderLeftColor: t.accent,
  },
  editLabel: { color: t.accent, fontWeight: "700", fontSize: 13 },
  editOld: { color: t.muted, fontSize: 13.5 },
  editClose: { color: t.muted, fontSize: 18, fontWeight: "700" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 6, paddingHorizontal: 8, paddingTop: 8, backgroundColor: t.chatBg },
  attach: { width: 42, height: 46, alignItems: "center", justifyContent: "center" },
  attachIcon: { fontSize: 26, color: t.accent, fontWeight: "600" },
  input: {
    flex: 1, maxHeight: 140, backgroundColor: t.bg, borderRadius: 22, paddingHorizontal: 16,
    paddingTop: 11, paddingBottom: 11, fontSize: 16, color: t.fg, ...noOutline,
  },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
  sendIcon: { color: t.accentFg, fontSize: 19, marginLeft: 3, fontWeight: "700" },
  micIcon: { fontSize: 20 },
  recordBar: { alignItems: "center" },
  recCancel: { paddingHorizontal: 10, height: 46, justifyContent: "center" },
  recCancelText: { color: t.danger, fontWeight: "700", fontSize: 15 },
  recInfo: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: t.bg, borderRadius: 22, height: 46, paddingHorizontal: 16 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.danger },
  recTime: { color: t.fg, fontSize: 16, fontWeight: "600", fontVariant: ["tabular-nums"] },
  recLabel: { color: t.muted, fontSize: 14 },
});
