import { createElement, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "../components";
import { formatDuration } from "../format";
import type { Calls } from "../useCalls";

// A <video>/<audio> element fed by a MediaStream (web only).
function MediaView({ stream, kind, muted, mirror, style }: {
  stream: MediaStream | null; kind: "video" | "audio"; muted?: boolean; mirror?: boolean; style?: object;
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) el.play().catch(() => {});
  }, [stream]);
  return createElement(kind, {
    ref,
    autoPlay: true,
    playsInline: true,
    muted: Boolean(muted),
    style: {
      width: "100%", height: "100%", objectFit: "cover", backgroundColor: "#000",
      transform: mirror ? "scaleX(-1)" : undefined, ...(kind === "audio" ? { display: "none" } : {}), ...style,
    },
  });
}

function RoundButton({ label, icon, onPress, color = "rgba(255,255,255,0.16)", active }: {
  label: string; icon: string; onPress: () => void; color?: string; active?: boolean;
}) {
  return (
    <View style={styles.btnWrap}>
      <Pressable
        onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
        style={({ pressed }) => [styles.btn, { backgroundColor: active ? "#f2fbf8" : color }, pressed && { opacity: 0.75 }]}
      >
        <Text style={[styles.btnIcon, active && { color: "#0b1514" }]}>{icon}</Text>
      </Pressable>
      <Text style={styles.btnLabel}>{label}</Text>
    </View>
  );
}

export function CallScreen({ calls }: { calls: Calls }) {
  const insets = useSafeAreaInsets();
  const { call, localStream, remoteStream } = calls;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (call?.phase !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.phase]);

  if (!call) return null;
  const video = call.media === "video";
  const remoteHasVideo = video && Boolean(remoteStream?.getVideoTracks().length) && call.phase === "active";

  let status: string;
  if (call.phase === "outgoing") status = call.id ? "Squilla…" : "Chiamata in corso…";
  else if (call.phase === "incoming") status = video ? "Videochiamata in arrivo" : "Chiamata vocale in arrivo";
  else if (call.phase === "connecting") status = "Connessione…";
  else if (call.phase === "active") status = formatDuration(now - (call.startedAt ?? now));
  else status = call.endedReason ?? "Chiamata terminata";

  return (
    <View style={styles.root} accessibilityViewIsModal>
      {remoteHasVideo ? (
        <View style={StyleSheet.absoluteFill}><MediaView stream={remoteStream} kind="video" /></View>
      ) : (
        <MediaView stream={remoteStream} kind="audio" />
      )}

      <View style={[styles.top, { paddingTop: insets.top + 32 }, remoteHasVideo && styles.topOverVideo]}>
        {!remoteHasVideo && <Avatar name={call.peer.username} id={call.peer.id} size={112} />}
        <Text style={styles.name} numberOfLines={1}>{call.peer.username}</Text>
        <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
      </View>

      {video && localStream && call.phase !== "ended" && (
        <View style={[styles.pip, { top: insets.top + 16 }]}>
          {call.cameraOff
            ? <View style={styles.pipOff}><Text style={styles.pipOffText}>Fotocamera spenta</Text></View>
            : <MediaView stream={localStream} kind="video" muted mirror />}
        </View>
      )}

      <View style={[styles.controls, { paddingBottom: insets.bottom + 36 }]}>
        {call.phase === "incoming" ? (
          <>
            <RoundButton label="Rifiuta" icon="✕" color="#d64545" onPress={calls.decline} />
            <RoundButton label="Rispondi" icon={video ? "📹" : "📞"} color="#2fae6c" onPress={calls.accept} />
          </>
        ) : call.phase === "ended" ? null : (
          <>
            <RoundButton label={call.muted ? "Riattiva" : "Muto"} icon={call.muted ? "🔇" : "🎤"} active={call.muted} onPress={calls.toggleMute} />
            {video && (
              <RoundButton label={call.cameraOff ? "Accendi" : "Video"} icon="📷" active={call.cameraOff} onPress={calls.toggleCamera} />
            )}
            {video && <RoundButton label="Gira" icon="🔄" onPress={calls.switchCamera} />}
            <RoundButton label="Chiudi" icon="✕" color="#d64545" onPress={calls.hangup} />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#0b1514", zIndex: 1000 },
  top: { alignItems: "center", gap: 10, paddingHorizontal: 24 },
  topOverVideo: { backgroundColor: "rgba(0,0,0,0.25)", paddingBottom: 12 },
  name: { color: "#f2fbf8", fontSize: 28, fontWeight: "700", marginTop: 12 },
  status: { color: "rgba(242,251,248,0.75)", fontSize: 16, fontVariant: ["tabular-nums"] },
  pip: {
    position: "absolute", right: 16, width: 110, height: 160, borderRadius: 14, overflow: "hidden",
    borderWidth: 2, borderColor: "rgba(255,255,255,0.35)", backgroundColor: "#000",
  },
  pipOff: { flex: 1, alignItems: "center", justifyContent: "center", padding: 8 },
  pipOffText: { color: "#fff", fontSize: 12, textAlign: "center" },
  controls: {
    position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", justifyContent: "center",
    gap: 22, paddingTop: 24, backgroundColor: "rgba(0,0,0,0.25)",
  },
  btnWrap: { alignItems: "center", gap: 6 },
  btn: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  btnIcon: { color: "#fff", fontSize: 24, fontWeight: "700" },
  btnLabel: { color: "rgba(242,251,248,0.85)", fontSize: 12.5 },
});
