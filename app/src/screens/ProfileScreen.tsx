import { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Api, User } from "../api";
import { Avatar } from "../components";
import { pickAvatar } from "../media";
import { Theme, useTheme } from "../theme";

type Props = {
  me: User;
  api: Api;
  avatarAt: number | null;
  onAvatarChanged: (avatarAt: number | null) => void;
  onBack: () => void;
  onLogout: () => void;
};

export function ProfileScreen({ me, api, avatarAt, onAvatarChanged, onBack, onLogout }: Props) {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  async function change() {
    setError("");
    try {
      const file = await pickAvatar();
      if (!file) return;
      setBusy(true);
      onAvatarChanged((await api.setAvatar(file)).avatarAt);
    } catch (e) {
      setError((e as Error).message || "Non sono riuscito a cambiare la foto. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await api.removeAvatar();
      onAvatarChanged(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={12} accessibilityLabel="Torna alle chat">
          <Ionicons name="chevron-back" size={28} color={t.accent} />
        </Pressable>
        <Text style={s.title}>Profilo</Text>
      </View>

      <View style={s.body}>
        <Pressable onPress={change} disabled={busy} accessibilityRole="button" accessibilityLabel="Cambia foto profilo">
          <Avatar name={me.username} id={me.id} size={140} photo={avatarAt} />
          <View style={s.badge}>
            {busy ? <ActivityIndicator color={t.accentFg} /> : <Ionicons name="camera" size={20} color={t.accentFg} />}
          </View>
        </Pressable>
        <Text style={s.name}>{me.username}</Text>

        <View style={s.actions}>
          <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={change} disabled={busy} accessibilityRole="button">
            <Ionicons name="image-outline" size={22} color={t.accent} />
            <Text style={s.rowText}>{avatarAt ? "Cambia foto" : "Aggiungi una foto"}</Text>
          </Pressable>
          {avatarAt ? (
            <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={remove} disabled={busy} accessibilityRole="button">
              <Ionicons name="trash-outline" size={22} color={t.danger} />
              <Text style={[s.rowText, { color: t.danger }]}>Rimuovi foto</Text>
            </Pressable>
          ) : null}
          <Pressable style={({ pressed }) => [s.row, pressed && s.pressed]} onPress={onLogout} accessibilityRole="button">
            <Ionicons name="log-out-outline" size={22} color={t.muted} />
            <Text style={[s.rowText, { color: t.muted }]}>Esci</Text>
          </Pressable>
        </View>
        {error ? <Text style={s.error}>{error}</Text> : null}
        <Text style={s.hint}>La foto la vedono tutte le persone con cui chatti.</Text>
      </View>
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  title: { fontSize: 20, fontWeight: "700", color: t.fg },
  body: { alignItems: "center", paddingHorizontal: 20, paddingTop: 24, gap: 12 },
  badge: {
    position: "absolute", right: 4, bottom: 4, width: 40, height: 40, borderRadius: 20, backgroundColor: t.accent,
    alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: t.bg,
  },
  name: { fontSize: 24, fontWeight: "700", color: t.fg, marginTop: 4 },
  actions: {
    maxWidth: 480, width: "100%", marginTop: 16, borderRadius: 14, backgroundColor: t.panel,
    borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, overflow: "hidden", alignSelf: "center",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 15 },
  pressed: { backgroundColor: t.accentSoft },
  rowText: { fontSize: 16, color: t.fg, fontWeight: "500" },
  error: { color: t.danger, textAlign: "center" },
  hint: { color: t.muted, fontSize: 13, textAlign: "center", marginTop: 4 },
});
