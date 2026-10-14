import { StyleSheet, Text, View } from "react-native";
import { initials, Status } from "./format";
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
