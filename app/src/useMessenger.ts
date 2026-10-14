import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Vibration } from "react-native";
import { io, Socket } from "socket.io-client";
import type { Api, Conversation, Message, User } from "./api";

export type ChatMessage = Message & { local?: "pending" | "failed" };
type Typing = Record<number, Record<number, string>>; // conversationId -> userId -> username
type Receipt = { conversationId: number; userId: number; lastReadId: number; lastDeliveredId: number };
type Presence = { userId: number; online: boolean; lastSeen: number | null };

const byActivity = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;
let tempIds = -1;

// One socket per session, keeping the chat list, messages, receipts,
// presence and typing indicators in sync with the server.
export function useMessenger(serverUrl: string, token: string, me: User, api: Api) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Record<number, ChatMessage[]>>({});
  const [typing, setTyping] = useState<Typing>({});
  const active = useRef<number | null>(null);
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const emit = (event: string, payload: unknown) => socketRef.current?.emit(event, payload);
  const appVisible = () => AppState.currentState === "active";

  const patchConversation = (id: number, fn: (c: Conversation) => Conversation) =>
    setConversations((list) => list.map((c) => (c.id === id ? fn(c) : c)).sort(byActivity));

  const clearTyping = (conversationId: number, userId: number) =>
    setTyping((t) => {
      if (!t[conversationId]?.[userId]) return t;
      const { [userId]: _gone, ...rest } = t[conversationId];
      return { ...t, [conversationId]: rest };
    });

  const refreshConversations = useCallback(async () => {
    const { conversations: list } = await api.conversations();
    setConversations(list.sort(byActivity));
    setLoaded(true);
    // Tell senders their latest messages reached this device.
    for (const c of list) {
      const last = c.lastMessage;
      const mine = c.members.find((m) => m.id === me.id);
      if (last && last.userId !== me.id && mine && mine.lastDeliveredId < last.id) {
        emit("delivered", { conversationId: c.id, messageId: last.id });
      }
    }
    return list;
  }, [api, me.id]);

  const markRead = useCallback((conversationId: number, messageId: number) => {
    emit("read", { conversationId, messageId });
    patchConversation(conversationId, (c) => ({
      ...c,
      unread: 0,
      members: c.members.map((m) => (m.id === me.id ? { ...m, lastReadId: Math.max(m.lastReadId, messageId) } : m)),
    }));
  }, [me.id]);

  useEffect(() => {
    const socket = io(serverUrl, { auth: { token }, transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", async () => {
      setConnected(true);
      const list = await refreshConversations().catch(() => null);
      // Catch up on whatever arrived in the open chat while offline.
      const open = active.current;
      if (list && open) {
        const { messages: fresh } = await api.messages(open).catch(() => ({ messages: [] as Message[] }));
        setMessages((prev) => ({ ...prev, [open]: [...fresh, ...(prev[open] ?? []).filter((m) => m.local)] }));
        const last = fresh.at(-1);
        if (last) markRead(open, last.id);
      }
    });
    socket.on("disconnect", () => setConnected(false));

    socket.on("conversation:new", (c: Conversation) =>
      setConversations((list) => (list.some((x) => x.id === c.id) ? list : [...list, c].sort(byActivity))));

    socket.on("message:new", (m: Message) => {
      const mine = m.userId === me.id;
      const isActive = active.current === m.conversationId && appVisible();
      setMessages((prev) => {
        const list = prev[m.conversationId];
        if (!list || list.some((x) => x.id === m.id)) return prev;
        return { ...prev, [m.conversationId]: [...list, m] };
      });
      setConversations((list) => {
        if (!list.some((c) => c.id === m.conversationId)) {
          refreshConversations().catch(() => {});
          return list;
        }
        return list.map((c) => c.id !== m.conversationId ? c : {
          ...c,
          lastMessage: m,
          updatedAt: m.createdAt,
          unread: mine || isActive ? c.unread : c.unread + 1,
        }).sort(byActivity);
      });
      clearTyping(m.conversationId, m.userId);
      if (!mine) {
        if (isActive) markRead(m.conversationId, m.id);
        else {
          emit("delivered", { conversationId: m.conversationId, messageId: m.id });
          if (Platform.OS !== "web") Vibration.vibrate(60);
        }
      }
    });

    socket.on("receipt", (r: Receipt) =>
      setConversations((list) => list.map((c) => c.id !== r.conversationId ? c : {
        ...c,
        members: c.members.map((m) => m.id !== r.userId ? m : { ...m, lastReadId: r.lastReadId, lastDeliveredId: r.lastDeliveredId }),
      })));

    socket.on("presence", (p: Presence) =>
      setConversations((list) => list.map((c) => c.members.some((m) => m.id === p.userId) ? {
        ...c,
        members: c.members.map((m) => m.id !== p.userId ? m : { ...m, online: p.online, lastSeen: p.lastSeen ?? m.lastSeen }),
      } : c)));

    socket.on("typing", ({ conversationId, user, typing: on }: { conversationId: number; user: User; typing: boolean }) => {
      const key = `${conversationId}:${user.id}`;
      clearTimeout(typingTimers.current[key]);
      if (!on) return clearTyping(conversationId, user.id);
      setTyping((t) => ({ ...t, [conversationId]: { ...t[conversationId], [user.id]: user.username } }));
      // Drop the indicator if the "stopped typing" event never arrives.
      typingTimers.current[key] = setTimeout(() => clearTyping(conversationId, user.id), 6000);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      Object.values(typingTimers.current).forEach(clearTimeout);
    };
  }, [serverUrl, token, api, me.id, refreshConversations, markRead]);

  // Opening a chat (or coming back to the app) reads its messages.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      const open = active.current;
      if (state !== "active" || !open) return;
      const last = messages[open]?.filter((m) => !m.local).at(-1);
      if (last) markRead(open, last.id);
    });
    return () => sub.remove();
  }, [messages, markRead]);

  const openConversation = useCallback(async (conversationId: number | null) => {
    active.current = conversationId;
    if (conversationId == null) return;
    const { messages: list } = await api.messages(conversationId);
    setMessages((prev) => ({ ...prev, [conversationId]: [...list, ...(prev[conversationId] ?? []).filter((m) => m.local)] }));
    const last = list.at(-1);
    if (last) markRead(conversationId, last.id);
  }, [api, markRead]);

  const loadOlder = useCallback(async (conversationId: number) => {
    const first = messages[conversationId]?.find((m) => !m.local);
    if (!first) return 0;
    const { messages: older } = await api.messages(conversationId, first.id);
    if (older.length) setMessages((prev) => ({ ...prev, [conversationId]: [...older, ...(prev[conversationId] ?? [])] }));
    return older.length;
  }, [api, messages]);

  // Shows the message straight away with a clock, then swaps in the saved one.
  const send = useCallback(async (conversationId: number, text: string, retryId?: number) => {
    const tempId = retryId ?? tempIds--;
    const draft: ChatMessage = {
      id: tempId, conversationId, userId: me.id, username: me.username, text, createdAt: Date.now(), local: "pending",
    };
    setMessages((prev) => {
      const list = (prev[conversationId] ?? []).filter((m) => m.id !== tempId);
      return { ...prev, [conversationId]: [...list, draft] };
    });
    const fail = () => setMessages((prev) => ({
      ...prev,
      [conversationId]: (prev[conversationId] ?? []).map((m) => (m.id === tempId ? { ...m, local: "failed" } : m)),
    }));
    const socket = socketRef.current;
    if (!socket?.connected) return fail();
    try {
      const res = await socket.timeout(10000).emitWithAck("message:send", { conversationId, text });
      if (res.error) return fail();
      const saved: Message = res.message;
      setMessages((prev) => {
        const list = (prev[conversationId] ?? []).filter((m) => m.id !== tempId && m.id !== saved.id);
        return { ...prev, [conversationId]: [...list.filter((m) => !m.local), saved, ...list.filter((m) => m.local)] };
      });
      patchConversation(conversationId, (c) => ({ ...c, lastMessage: saved, updatedAt: saved.createdAt }));
    } catch {
      fail();
    }
  }, [me]);

  const discard = useCallback((conversationId: number, tempId: number) =>
    setMessages((prev) => ({ ...prev, [conversationId]: (prev[conversationId] ?? []).filter((m) => m.id !== tempId) })), []);

  const sendTyping = useCallback((conversationId: number, on: boolean) => emit("typing", { conversationId, typing: on }), []);

  const addConversation = useCallback((c: Conversation) =>
    setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort(byActivity)), []);

  const totalUnread = conversations.reduce((n, c) => n + c.unread, 0);
  useEffect(() => {
    if (Platform.OS === "web") document.title = totalUnread ? `(${totalUnread}) Cortile` : "Cortile";
  }, [totalUnread]);

  return {
    connected, loaded, conversations, messages, typing, totalUnread,
    openConversation, loadOlder, send, discard, sendTyping, addConversation,
  };
}

export type Messenger = ReturnType<typeof useMessenger>;
