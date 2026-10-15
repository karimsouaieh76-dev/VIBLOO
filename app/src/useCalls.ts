import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { Socket } from "socket.io-client";
import type { Api, User } from "./api";
import { mediaErrorMessage } from "./mediaErrors";

// Voice and video calls with WebRTC. Audio and video go straight between the
// two devices; the socket only carries ringing and the connection setup.

export type CallMedia = "audio" | "video";
export type CallPhase = "outgoing" | "incoming" | "connecting" | "active" | "ended";
export type CallState = {
  id: string | null;
  conversationId: number;
  peer: User;
  media: CallMedia;
  phase: CallPhase;
  startedAt: number | null;
  muted: boolean;
  cameraOff: boolean;
  endedReason?: string;
};

export const callsSupported = () =>
  Platform.OS === "web" && typeof window !== "undefined" && "RTCPeerConnection" in window && !!navigator.mediaDevices?.getUserMedia;

const END_TEXT: Record<string, string> = {
  hangup: "Chiamata terminata",
  declined: "Chiamata rifiutata",
  missed: "Nessuna risposta",
  busy: "Occupato in un'altra chiamata",
  disconnected: "Connessione persa",
  failed: "Connessione non riuscita",
  no_route: "Le due reti non riescono a collegarsi",
  answered_elsewhere: "Hai risposto su un altro dispositivo",
};

// Tones with WebAudio, no files needed: the Italian ringback (425 Hz, 1 s on,
// 4 s off) for the caller, a two-note ring for the callee.
function createTones() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const beep = (freq: number, ms: number, at = 0) => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.12;
    osc.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime + at;
    osc.start(t);
    osc.stop(t + ms / 1000);
  };
  const start = (kind: "ringback" | "ring") => {
    stop();
    try {
      ctx = new AudioContext();
      ctx.resume().catch(() => {});
    } catch {
      return;
    }
    const play = () => {
      if (kind === "ringback") beep(425, 1000);
      else { beep(880, 250); beep(660, 250, 0.3); beep(880, 250, 0.9); beep(660, 250, 1.2); }
      if (kind === "ring") navigator.vibrate?.([400, 200, 400]);
    };
    play();
    timer = setInterval(play, kind === "ringback" ? 5000 : 3000);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    ctx?.close().catch(() => {});
    ctx = null;
    navigator.vibrate?.(0);
  };
  return { start, stop };
}

export function useCalls(socket: Socket | null, api: Api) {
  const [call, setCall] = useState<CallState | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const callRef = useRef<CallState | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const local = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const tones = useRef(createTones());
  const facing = useRef<"user" | "environment">("user");
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ice = useRef<RTCIceServer[] | null>(null);
  const hasTurn = useRef(false);
  const connectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // STUN/TURN servers from our server, fetched once.
  const iceConfig = async () => {
    if (!ice.current) {
      const cfg = await api.callConfig().catch(() => null);
      ice.current = cfg?.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
      hasTurn.current = Boolean(cfg?.hasTurn);
    }
    return ice.current;
  };

  const update = (patch: Partial<CallState> | null) => {
    const next = patch === null ? null : ({ ...callRef.current!, ...patch } as CallState);
    callRef.current = next;
    setCall(next);
  };

  const cleanup = useCallback(() => {
    tones.current.stop();
    clearTimeout(connectTimer.current);
    pc.current?.close();
    pc.current = null;
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    pendingCandidates.current = [];
    setLocalStream(null);
    setRemoteStream(null);
  }, []);

  // Shows the reason for a moment, then closes the call screen.
  const finish = useCallback((reason: string) => {
    cleanup();
    if (!callRef.current) return;
    update({ phase: "ended", endedReason: END_TEXT[reason] ?? END_TEXT.hangup });
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => update(null), 1800);
  }, [cleanup]);

  async function getMedia(media: CallMedia) {
    const audio = { echoCancellation: true, noiseSuppression: true };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: media === "video" ? { facingMode: facing.current, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      // No usable camera: still join the video call with voice only.
      const name = (err as { name?: string })?.name;
      if (media !== "video" || name === "NotAllowedError" || name === "SecurityError") throw err;
      stream = await navigator.mediaDevices.getUserMedia({ audio });
      update({ cameraOff: true });
    }
    local.current = stream;
    setLocalStream(stream);
    return stream;
  }

  const send = (data: unknown) => socket?.emit("call:signal", { callId: callRef.current?.id, data });

  // Why the call did not connect: ICE states and which kinds of paths each side found.
  async function reportFailure(peer: RTCPeerConnection, reason: string) {
    try {
      const kinds = { local: new Set<string>(), remote: new Set<string>() };
      (await peer.getStats()).forEach((r: { type: string; candidateType?: string }) => {
        if (r.type === "local-candidate" && r.candidateType) kinds.local.add(r.candidateType);
        if (r.type === "remote-candidate" && r.candidateType) kinds.remote.add(r.candidateType);
      });
      socket?.emit("call:diag", {
        reason, ice: peer.iceConnectionState, conn: peer.connectionState, hasTurn: hasTurn.current,
        local: [...kinds.local], remote: [...kinds.remote], ua: navigator.userAgent,
      });
    } catch { /* diagnostics are best effort */ }
  }

  // The usual cause on 4G/5G: no direct path and no TURN relay configured.
  function explainFailure() {
    setError(hasTurn.current
      ? "La chiamata non si è collegata. Controlla la connessione di entrambi e riprova."
      : "La chiamata non si è collegata: le reti dei due telefoni (spesso 4G/5G) bloccano il collegamento diretto. "
        + "Per farla funzionare ovunque va configurato un server TURN su Render. Su due Wi-Fi diversi di solito funziona.");
  }

  function giveUp(peer: RTCPeerConnection, why: string) {
    if (!callRef.current || callRef.current.phase === "ended") return;
    reportFailure(peer, why);
    const reason = why === "timeout" ? "no_route" : "failed";
    socket?.emit("call:hangup", { callId: callRef.current.id, reason });
    explainFailure();
    finish(reason);
  }

  async function createPeer() {
    const peer = new RTCPeerConnection({ iceServers: await iceConfig() });
    pc.current = peer;
    local.current?.getTracks().forEach((t) => peer.addTrack(t, local.current!));
    peer.onicecandidate = (e) => { if (e.candidate) send({ type: "candidate", candidate: e.candidate.toJSON() }); };
    peer.ontrack = (e) => setRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
    // Safari may report only iceConnectionState, so both are watched.
    const onState = () => {
      const conn = peer.connectionState;
      const ice = peer.iceConnectionState;
      if ((conn === "connected" || ice === "connected" || ice === "completed") && callRef.current?.phase !== "active") {
        clearTimeout(connectTimer.current);
        update({ phase: "active", startedAt: Date.now() });
      }
      if (conn === "failed" || ice === "failed") giveUp(peer, "failed");
    };
    peer.onconnectionstatechange = onState;
    peer.oniceconnectionstatechange = onState;
    // Without a connection after 25 s, stop instead of hanging on "Connessione…".
    clearTimeout(connectTimer.current);
    connectTimer.current = setTimeout(() => {
      if (callRef.current && callRef.current.phase !== "active" && callRef.current.phase !== "ended") giveUp(peer, "timeout");
    }, 25000);
    return peer;
  }

  const flushCandidates = async () => {
    for (const c of pendingCandidates.current) await pc.current?.addIceCandidate(c).catch(() => {});
    pendingCandidates.current = [];
  };

  // ---------- caller ----------
  const startCall = useCallback(async (conversationId: number, peer: User, media: CallMedia) => {
    if (!socket?.connected) return setError("Sei offline: riprova quando torna la connessione.");
    if (callRef.current) return;
    setError("");
    clearTimeout(closeTimer.current);
    update({ id: null, conversationId, peer, media, phase: "outgoing", startedAt: null, muted: false, cameraOff: false });
    try {
      await getMedia(media);
    } catch (err) {
      update(null);
      cleanup();
      return setError(mediaErrorMessage(err, media === "video" ? "video" : "call"));
    }
    const res = await socket.emitWithAck("call:invite", { conversationId, media });
    if (res.error) {
      cleanup();
      update(null);
      return setError(res.error);
    }
    update({ id: res.callId });
    tones.current.start("ringback");
  }, [socket, cleanup]);

  // ---------- callee ----------
  const accept = useCallback(async () => {
    const c = callRef.current;
    if (!c || c.phase !== "incoming" || !socket) return;
    tones.current.stop();
    try {
      await getMedia(c.media);
    } catch (err) {
      socket.emit("call:decline", { callId: c.id });
      finish("hangup");
      return setError(mediaErrorMessage(err, c.media === "video" ? "video" : "call"));
    }
    update({ phase: "connecting" });
    // Ready before saying yes: the caller's offer arrives right after.
    await createPeer();
    const res = await socket.emitWithAck("call:accept", { callId: c.id });
    if (res.error) return finish("hangup");
  }, [socket, finish]);

  const decline = useCallback(() => {
    const c = callRef.current;
    if (c?.id) socket?.emit("call:decline", { callId: c.id });
    finish("declined");
  }, [socket, finish]);

  const hangup = useCallback(() => {
    const c = callRef.current;
    if (c?.id) socket?.emit("call:hangup", { callId: c.id });
    finish("hangup");
  }, [socket, finish]);

  const toggleMute = useCallback(() => {
    const muted = !callRef.current?.muted;
    local.current?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    update({ muted });
  }, []);

  const toggleCamera = useCallback(() => {
    const cameraOff = !callRef.current?.cameraOff;
    local.current?.getVideoTracks().forEach((t) => { t.enabled = !cameraOff; });
    update({ cameraOff });
  }, []);

  // Front/back camera on phones: swap the video track without renegotiating.
  const switchCamera = useCallback(async () => {
    const old = local.current?.getVideoTracks()[0];
    if (!old) return;
    facing.current = facing.current === "user" ? "environment" : "user";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing.current } });
      const track = fresh.getVideoTracks()[0];
      const sender = pc.current?.getSenders().find((s) => s.track?.kind === "video");
      await sender?.replaceTrack(track);
      local.current!.removeTrack(old);
      old.stop();
      local.current!.addTrack(track);
      setLocalStream(new MediaStream(local.current!.getTracks()));
    } catch {
      facing.current = facing.current === "user" ? "environment" : "user";
    }
  }, []);

  useEffect(() => {
    if (!socket) return;
    if (callsSupported()) iceConfig().catch(() => {});

    const onIncoming = (p: { callId: string; conversationId: number; media: CallMedia; from: User }) => {
      if (callRef.current && callRef.current.id === p.callId) return;
      if (callRef.current && callRef.current.phase !== "ended") return; // busy here; the server answers "busy"
      clearTimeout(closeTimer.current);
      update({ id: p.callId, conversationId: p.conversationId, peer: p.from, media: p.media, phase: "incoming", startedAt: null, muted: false, cameraOff: false });
      tones.current.start("ring");
    };

    const onAccepted = async ({ callId }: { callId: string }) => {
      if (callRef.current?.id !== callId) return;
      tones.current.stop();
      update({ phase: "connecting" });
      const peer = await createPeer();
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      send({ type: "offer", sdp: offer.sdp });
    };

    const onSignal = async ({ callId, data }: { callId: string; data: { type: string; sdp?: string; candidate?: RTCIceCandidateInit } }) => {
      if (callRef.current?.id !== callId || !pc.current) return;
      const peer = pc.current;
      if (data.type === "offer") {
        await peer.setRemoteDescription({ type: "offer", sdp: data.sdp });
        await flushCandidates();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send({ type: "answer", sdp: answer.sdp });
      } else if (data.type === "answer") {
        await peer.setRemoteDescription({ type: "answer", sdp: data.sdp });
        await flushCandidates();
      } else if (data.type === "candidate" && data.candidate) {
        if (peer.remoteDescription) await peer.addIceCandidate(data.candidate).catch(() => {});
        else pendingCandidates.current.push(data.candidate);
      }
    };

    const onEnded = ({ callId, reason }: { callId: string; reason: string }) => {
      if (callRef.current?.id !== callId) return;
      if (reason === "no_route" || reason === "failed") explainFailure();
      finish(reason);
    };

    socket.on("call:incoming", onIncoming);
    socket.on("call:accepted", onAccepted);
    socket.on("call:signal", onSignal);
    socket.on("call:ended", onEnded);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:accepted", onAccepted);
      socket.off("call:signal", onSignal);
      socket.off("call:ended", onEnded);
    };
  }, [socket, finish]);

  useEffect(() => () => cleanup(), [cleanup]);

  return {
    call, localStream, remoteStream, error, clearError: () => setError(""),
    startCall, accept, decline, hangup, toggleMute, toggleCamera, switchCamera,
  };
}

export type Calls = ReturnType<typeof useCalls>;
