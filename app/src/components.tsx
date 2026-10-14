import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { formatDuration, formatSize, initials, Status } from "./format";
import { avatarColor, Theme, useTheme } from "./theme";

export function Avatar({ name, id, size = 48, online, group }: {
  name: string; id: number; size?: number; online?: boolean; group?: boolean;
}) {
  const t = useTheme();
  const dot = Math.max(10, Math.round(size / 4));
  return (
    <View style={{ width: size, height: size }}>
      <View style={{
        width: size, height: size, borderRadius: size / 2, backgroundColor: group ? t.accent : avatarColor(id),
        alignItems: "center", justifyContent: "center",
      }}>
        <Text style={{ color: group ? t.accentFg : "#fff", fontWeight: "700", fontSize: size * 0.38 }}>
          {group ? "#" : initials(name)}
        </Text>
      </View>
      {online && (
        <View style={{
          position: "absolute", right: 0, bottom: 0, width: dot, height: dot, borderRadius: dot / 2,
          backgroundColor: t.online, borderWidth: 2, borderColor: t.bg,
        }} />
      )}
    </View>
  );
}

// ✓ sent · ✓✓ delivered · blue ✓✓ read · clock while sending · ! failed
export function Ticks({ status, size = 13 }: { status: Status; size?: number }) {
  const t = useTheme();
  const s = tickStyles(t, size);
  if (status === "pending") return <Text style={[s.tick, { color: t.tick }]} accessibilityLabel="In invio">🕓</Text>;
  if (status === "failed") return <Text style={[s.tick, { color: t.danger, fontWeight: "800" }]} accessibilityLabel="Non inviato">!</Text>;
  const color = status === "read" ? t.tickRead : t.tick;
  const label = status === "read" ? "Letto" : status === "delivered" ? "Consegnato" : "Inviato";
  return (
    <Text style={[s.tick, { color }]} accessibilityLabel={label}>
      {status === "sent" ? "✓" : "✓✓"}
    </Text>
  );
}

const tickStyles = (_t: Theme, size: number) => StyleSheet.create({
  tick: { fontSize: size, fontWeight: "700", letterSpacing: -3, paddingRight: 3 },
});

export function AudioBubble({ uri, duration, mine }: { uri: string; duration: number | null; mine: boolean }) {
  const t = useTheme();
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  const total = status.duration > 0 && Number.isFinite(status.duration) ? status.duration * 1000 : duration ?? 0;
  const progress = total ? Math.min(1, (status.currentTime * 1000) / total) : 0;

  function toggle() {
    if (status.playing) return player.pause();
    if (status.didJustFinish || (total && status.currentTime * 1000 >= total - 50)) player.seekTo(0);
    player.play();
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, width: 220, paddingVertical: 2 }}>
      <Pressable
        onPress={toggle} accessibilityRole="button" accessibilityLabel={status.playing ? "Pausa" : "Ascolta"}
        style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: t.accentFg, fontSize: 15, fontWeight: "800", marginLeft: status.playing ? 0 : 2 }}>
          {status.playing ? "❚❚" : "▶"}
        </Text>
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: mine ? "rgba(0,0,0,0.12)" : t.line }}>
          <View style={{ height: 4, borderRadius: 2, width: `${progress * 100}%`, backgroundColor: t.accent }} />
        </View>
        <Text style={{ fontSize: 12, color: t.muted, fontVariant: ["tabular-nums"] }}>
          {formatDuration(status.playing || status.currentTime > 0 ? status.currentTime * 1000 : total)}
        </Text>
      </View>
    </View>
  );
}

export function FileBubble({ name, size, onOpen, onLongPress }: {
  name: string; size: number; onOpen: () => void; onLongPress?: () => void;
}) {
  const t = useTheme();
  const ext = (name.split(".").pop() ?? "").slice(0, 4).toUpperCase();
  return (
    <Pressable onPress={onOpen} onLongPress={onLongPress} delayLongPress={350} accessibilityRole="link" accessibilityLabel={`Apri ${name}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, width: 230, paddingVertical: 2 }}>
      <View style={{ width: 40, height: 48, borderRadius: 6, backgroundColor: t.accentSoft, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 10, fontWeight: "800", color: t.accent }}>{ext || "FILE"}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: t.fg, fontWeight: "600", fontSize: 14.5 }} numberOfLines={2}>{name}</Text>
        {size > 0 && <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>{formatSize(size)}</Text>}
      </View>
    </Pressable>
  );
}

// Bubble-sized photo that keeps the picture's proportions.
export function PhotoThumb({ uri, width, height, onPress, onLongPress }: {
  uri: string; width: number | null; height: number | null; onPress: () => void; onLongPress?: () => void;
}) {
  const ratio = width && height ? Math.min(Math.max(width / height, 0.6), 1.8) : 4 / 3;
  const w = 240;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} accessibilityRole="imagebutton" accessibilityLabel="Apri foto">
      <Image source={{ uri }} style={{ width: w, height: w / ratio, borderRadius: 8 }} resizeMode="cover" />
    </Pressable>
  );
}

export function PhotoViewer({ uri, onClose, onDownload }: { uri: string | null; onClose: () => void; onDownload?: () => void }) {
  return (
    <Modal visible={uri != null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.94)" }}>
        {uri && <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel="Foto" />}
        <View style={{ position: "absolute", top: 40, left: 16, right: 16, flexDirection: "row", justifyContent: "space-between" }}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>✕ Chiudi</Text>
          </Pressable>
          {onDownload && (
            <Pressable onPress={onDownload} hitSlop={12} accessibilityRole="button">
              <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>Scarica</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

export type SheetOption = { label: string; onPress: () => void; danger?: boolean };

// Bottom sheet of actions (message menu, attach menu, confirmations).
export function ActionSheet({ visible, title, options, onClose }: {
  visible: boolean; title?: string; options: SheetOption[]; onClose: () => void;
}) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" }} onPress={onClose}>
        <Pressable style={{
          backgroundColor: t.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8, paddingBottom: 28,
          width: "100%", maxWidth: 520, alignSelf: "center",
        }}>
          {title ? <Text style={{ color: t.muted, fontSize: 13, textAlign: "center", paddingVertical: 10, paddingHorizontal: 20 }}>{title}</Text> : null}
          {options.map((o) => (
            <Pressable
              key={o.label} onPress={() => { onClose(); o.onPress(); }} accessibilityRole="button"
              style={({ pressed }) => [{ paddingVertical: 15, paddingHorizontal: 24 }, pressed && { backgroundColor: t.accentSoft }]}
            >
              <Text style={{ fontSize: 16.5, color: o.danger ? t.danger : t.fg, fontWeight: o.danger ? "700" : "500" }}>{o.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={onClose} style={{ paddingVertical: 15, paddingHorizontal: 24 }} accessibilityRole="button">
            <Text style={{ fontSize: 16.5, color: t.muted }}>Annulla</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
