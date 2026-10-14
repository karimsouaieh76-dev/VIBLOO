import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Api, Channel, Message, User } from "./api";

type Typing = Record<number, Record<number, string>>; // channelId -> userId -> username

// One socket per session: keeps channels, online users, typing state and
// per-channel message lists in sync with the server.
export function useChat(serverUrl: string, token: string, api: Api) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [online, setOnline] = useState<User[]>([]);
  const [typing, setTyping] = useState<Typing>({});
  const [messages, setMessages] = useState<Record<number, Message[]>>({});
  const [unread, setUnread] = useState<Record<number, number>>({});
  const activeChannel = useRef<number | null>(null);
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    api.channels().then((r) => setChannels(r.channels)).catch(() => {});

    const socket = io(serverUrl, { auth: { token }, transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      api.channels().then((r) => setChannels(r.channels)).catch(() => {});
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("presence", (users: User[]) => setOnline(users));
    socket.on("channel:new", (c: Channel) =>
      setChannels((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c])));
    socket.on("message:new", (m: Message) => {
      setMessages((prev) => {
        const list = prev[m.channelId];
        if (!list || list.some((x) => x.id === m.id)) return prev;
        return { ...prev, [m.channelId]: [...list, m] };
      });
      if (activeChannel.current !== m.channelId) {
        setUnread((u) => ({ ...u, [m.channelId]: (u[m.channelId] ?? 0) + 1 }));
      }
      clearTyping(m.channelId, m.userId);
    });
    socket.on("typing", ({ channelId, user, typing: on }: { channelId: number; user: User; typing: boolean }) => {
      const key = `${channelId}:${user.id}`;
      clearTimeout(typingTimers.current[key]);
      if (!on) return clearTyping(channelId, user.id);
      setTyping((t) => ({ ...t, [channelId]: { ...t[channelId], [user.id]: user.username } }));
      // Drop the indicator if the "stopped typing" event never arrives.
      typingTimers.current[key] = setTimeout(() => clearTyping(channelId, user.id), 6000);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      Object.values(typingTimers.current).forEach(clearTimeout);
    };
  }, [serverUrl, token, api]);

  function clearTyping(channelId: number, userId: number) {
    setTyping((t) => {
      if (!t[channelId]?.[userId]) return t;
      const { [userId]: _, ...rest } = t[channelId];
      return { ...t, [channelId]: rest };
    });
  }

  const openChannel = useCallback(async (channelId: number | null) => {
    activeChannel.current = channelId;
    if (channelId == null) return;
    setUnread((u) => ({ ...u, [channelId]: 0 }));
    const { messages: list } = await api.messages(channelId);
    setMessages((prev) => ({ ...prev, [channelId]: list }));
  }, [api]);

  const loadOlder = useCallback(async (channelId: number) => {
    const first = messages[channelId]?.[0];
    if (!first) return 0;
    const { messages: older } = await api.messages(channelId, first.id);
    if (older.length) setMessages((prev) => ({ ...prev, [channelId]: [...older, ...(prev[channelId] ?? [])] }));
    return older.length;
  }, [api, messages]);

  const send = useCallback(async (channelId: number, text: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) throw new Error("Sei offline: il messaggio non è stato inviato.");
    const res = await socket.timeout(8000).emitWithAck("message:send", { channelId, text });
    if (res.error) throw new Error(res.error);
    const m: Message = res.message;
    setMessages((prev) => {
      const list = prev[channelId] ?? [];
      return list.some((x) => x.id === m.id) ? prev : { ...prev, [channelId]: [...list, m] };
    });
  }, []);

  const sendTyping = useCallback((channelId: number, on: boolean) => {
    socketRef.current?.emit("typing", { channelId, typing: on });
  }, []);

  const createChannel = useCallback(async (name: string) => {
    const { channel } = await api.createChannel(name);
    setChannels((prev) => (prev.some((x) => x.id === channel.id) ? prev : [...prev, channel]));
    return channel;
  }, [api]);

  return { connected, channels, online, typing, messages, unread, openChannel, loadOlder, send, sendTyping, createChannel };
}

export type Chat = ReturnType<typeof useChat>;
