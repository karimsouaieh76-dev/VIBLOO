import { createElement, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Avatar } from "../components";
import { formatDuration } from "../format";
import type { Calls } from "../useCalls";

// A <video>/<audio> element fed by a MediaStream (web only).
// Safari may refuse to start playback on its own: `onBlocked` lets the screen ask for a tap.
const blockedPlayers = new Set<HTMLMediaElement>();

function MediaView({ stream, kind, muted, mirror, style, onBlocked }: {
  stream: MediaStream | null; kind: "video" | "audio"; muted?: boolean; mirror?: boolean; style?: object;
  onBlocked?: () => void;
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) {
      el.play().catch(() => {
        blockedPlayers.add(el);
        onBlocked?.();
      });
    }
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

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function RoundButton({ label, icon, onPress, color = "rgba(255,255,255,0.16)", active, rotate }: {
  label: string; icon: IconName; onPress: () => void; color?: string; active?: boolean; rotate?: boolean;
}) {
  return (
    <View style={styles.btnWrap}>
      <Pressable
        onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
        style={({ pressed }) => [styles.btn, { backgroundColor: active ? "#f2fbf8" : color }, pressed && { opacity: 0.75 }]}
      >
        <Ionicons
          name={icon} size={28} color={active ? "#0b1514" : "#fff"}
          style={rotate ? { transform: [{ rotate: "135deg" }] } : undefined}
        />
      </Pressable>
      <Text style={styles.btnLabel}>{label}</Text>
    </View>
  );
}

export function CallScreen({ calls }: { calls: Calls }) {
  const insets = useSafeAreaInsets();
  const { call, localStream, remoteStream } = calls;
  const [now, setNow] = useState(Date.now());
  const [needsTap, setNeedsTap] = useState(false);
  const resume = () => {
    blockedPlayers.forEach((el) => el.play().catch(() => {}));
    blockedPlayers.clear();
    setNeedsTap(false);
  };

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
        <View style={StyleSheet.absoluteFill}><MediaView stream={remoteStream} kind="video" onBlocked={() => setNeedsTap(true)} /></View>
      ) : (
        <MediaView stream={remoteStream} kind="audio" onBlocked={() => setNeedsTap(true)} />
      )}
      {needsTap && call.phase !== "ended" && (
        <Pressable onPress={resume} style={styles.tapOverlay} accessibilityRole="button">
          <Text style={styles.tapText}>Tocca per vedere e sentire</Text>
        </Pressable>
      )}

      <View style={[styles.top, { paddingTop: insets.top + 32 }, remoteHasVideo && styles.topOverVideo]}>
        {!remoteHasVideo && <Avatar name={call.peer.username} id={call.peer.id} size={112} photo={call.peer.avatarAt} />}
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
            <RoundButton label="Rifiuta" icon="call" rotate color="#e0413d" onPress={calls.decline} />
            <RoundButton label="Rispondi" icon={video ? "videocam" : "call"} color="#2fae6c" onPress={calls.accept} />
          </>
        ) : call.phase === "ended" ? null : (
          <>
            <RoundButton label={call.muted ? "Riattiva" : "Muto"} icon={call.muted ? "mic-off" : "mic"} active={call.muted} onPress={calls.toggleMute} />
            {video && (
              <RoundButton label={call.cameraOff ? "Accendi" : "Video"} icon={call.cameraOff ? "videocam-off" : "videocam"} active={call.cameraOff} onPress={calls.toggleCamera} />
            )}
            {video && <RoundButton label="Gira" icon="camera-reverse" onPress={calls.switchCamera} />}
            <RoundButton label="Chiudi" icon="call" rotate color="#e0413d" onPress={calls.hangup} />
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
  tapOverlay: {
    position: "absolute", left: 24, right: 24, top: "45%", zIndex: 5, padding: 18, borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.92)", alignItems: "center",
  },
  tapText: { color: "#0b1514", fontSize: 17, fontWeight: "700" },
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
  btnLabel: { color: "rgba(242,251,248,0.85)", fontSize: 12.5 },
});
