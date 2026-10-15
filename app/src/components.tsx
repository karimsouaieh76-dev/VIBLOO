import { useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useAvatarUrl } from "./avatars";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import Ionicons from "@expo/vector-icons/Ionicons";
import { formatDuration, formatSize, initials, Status } from "./format";
import { avatarColor, Theme, useTheme } from "./theme";

export function Avatar({ name, id, size = 48, online, group, photo }: {
  name: string; id: number; size?: number; online?: boolean; group?: boolean;
  photo?: number | null; // when the profile photo last changed, or nothing
}) {
  const t = useTheme();
  const avatarUrl = useAvatarUrl();
  const [broken, setBroken] = useState<number | null>(null);
  const dot = Math.max(10, Math.round(size / 4));
  const showPhoto = !group && photo && avatarUrl && broken !== photo;
  return (
    <View style={{ width: size, height: size }}>
      {showPhoto ? (
        <Image
          source={{ uri: avatarUrl(id, photo) }} accessibilityLabel={`Foto di ${name}`}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(id) }}
          onError={() => setBroken(photo)}
        />
      ) : (
        <View style={{
          width: size, height: size, borderRadius: size / 2, backgroundColor: group ? t.accent : avatarColor(id),
          alignItems: "center", justifyContent: "center",
        }}>
          <Text style={{ color: group ? t.accentFg : "#fff", fontWeight: "700", fontSize: size * 0.38 }}>
            {group ? "#" : initials(name)}
          </Text>
        </View>
      )}
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
export function Ticks({ status, size = 13, onAccent }: { status: Status; size?: number; onAccent?: boolean }) {
  const t = useTheme();
  const s = tickStyles(t, size);
  if (status === "pending") return <Text style={[s.tick, { color: t.tick }]} accessibilityLabel="In invio">🕓</Text>;
  if (status === "failed") return <Text style={[s.tick, { color: t.danger, fontWeight: "800" }]} accessibilityLabel="Non inviato">!</Text>;
  const color = onAccent ? t.accentFg : status === "read" ? t.tickRead : t.tick;
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

// Messenger-style voice note: round play button, waveform bars that fill as
// it plays, duration on the right. `onAccent` when drawn on the coloured bubble.
export function AudioBubble({ uri, duration, seed, onAccent }: {
  uri: string; duration: number | null; seed: number; onAccent: boolean;
}) {
  const t = useTheme();
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  const total = status.duration > 0 && Number.isFinite(status.duration) ? status.duration * 1000 : duration ?? 0;
  const progress = total ? Math.min(1, (status.currentTime * 1000) / total) : 0;
  const bars = waveform(seed, 26);
  const fg = onAccent ? t.accentFg : t.accent;

  function toggle() {
    if (status.playing) return player.pause();
    if (status.didJustFinish || (total && status.currentTime * 1000 >= total - 50)) player.seekTo(0);
    player.play();
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, width: 230, paddingVertical: 2 }}>
      <Pressable
        onPress={toggle} accessibilityRole="button" accessibilityLabel={status.playing ? "Pausa" : "Ascolta"}
        style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: onAccent ? t.accentFg : t.accent, alignItems: "center", justifyContent: "center" }}
      >
        <Ionicons name={status.playing ? "pause" : "play"} size={17} color={onAccent ? t.accent : t.accentFg} style={{ marginLeft: status.playing ? 0 : 2 }} />
      </Pressable>
      <View style={{ flex: 1, height: 28, flexDirection: "row", alignItems: "center", gap: 2 }}>
        {bars.map((h, i) => (
          <View
            key={i}
            style={{
              flex: 1, height: 4 + h * 22, borderRadius: 2, backgroundColor: fg,
              opacity: (i + 0.5) / bars.length <= progress ? 1 : 0.38,
            }}
          />
        ))}
      </View>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: fg, fontVariant: ["tabular-nums"], minWidth: 32, textAlign: "right" }}>
        {formatDuration(status.playing || status.currentTime > 0 ? Math.max(0, total - status.currentTime * 1000) : total)}
      </Text>
    </View>
  );
}

// A stable, natural-looking waveform for each voice note (0–1 heights).
function waveform(seed: number, n: number) {
  let x = Math.abs(seed * 9301 + 49297) % 233280 || 1;
  const rnd = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  return Array.from({ length: n }, (_, i) => {
    const envelope = Math.sin((Math.PI * (i + 1)) / (n + 1));
    return Math.min(1, 0.25 + envelope * 0.55 + rnd() * 0.35);
  });
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
export function ActionSheet({ visible, title, options, onClose, header }: {
  visible: boolean; title?: string; options: SheetOption[]; onClose: () => void; header?: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" }} onPress={onClose}>
        <Pressable style={{
          backgroundColor: t.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8, paddingBottom: 28,
          width: "100%", maxWidth: 520, alignSelf: "center",
        }}>
          {header}
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
