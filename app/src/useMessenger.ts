import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Vibration } from "react-native";
import { io, Socket } from "socket.io-client";
import type { Api, Conversation, LocalFile, Message, MessageKind, User } from "./api";

// Messages not yet saved by the server carry their state and, for media, the
// local file (shown as a preview and kept for "Riprova").
export type ChatMessage = Message & { local?: "pending" | "failed"; localFile?: LocalFile };
export type Outgoing = { text: string; file?: LocalFile };

const kindOf = (mime: string): MessageKind =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file";
type Typing = Record<number, Record<number, string>>; // conversationId -> userId -> username
type Receipt = { conversationId: number; userId: number; lastReadId: number; lastDeliveredId: number };
type Presence = { userId: number; online: boolean; lastSeen: number | null };

const byActivity = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;
let tempIds = -1;

// One socket per session, keeping the chat list, messages, receipts,
// presence and typing indicators in sync with the server.
export function useMessenger(serverUrl: string, token: string, me: User, api: Api) {
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [myAvatarAt, setMyAvatarAt] = useState<number | null>(me.avatarAt ?? null);
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

  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    const socket = io(serverUrl, { auth: { token }, transports: ["websocket"] });
    socketRef.current = socket;
    setSocket(socket);

    socket.on("connect", async () => {
      setConnected(true);
      socket.emit("visibility", { visible: appVisible() });
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
    socket.on("disconnect", (reason) => {
      setConnected(false);
      // The server closed it: maybe the password changed on another device.
      if (reason === "io server disconnect") {
        api.me().then(() => socket.connect(), (e) => { if (e?.status === 401) setExpired(true); });
      }
    });
    socket.on("connect_error", (err) => { if (err.message === "unauthorized") setExpired(true); });

    // How a chat looks to me changed (request accepted, someone blocked, …).
    socket.on("conversation:update", (c: Conversation) =>
      setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort(byActivity)));
    socket.on("conversation:removed", ({ id }: { id: number }) =>
      setConversations((list) => list.filter((x) => x.id !== id)));

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

    // Edited or deleted messages.
    socket.on("message:update", (m: Message) => {
      setMessages((prev) => {
        const list = prev[m.conversationId];
        return list ? { ...prev, [m.conversationId]: list.map((x) => (x.id === m.id ? m : x)) } : prev;
      });
      setConversations((list) => list.map((c) =>
        c.id === m.conversationId && c.lastMessage?.id === m.id ? { ...c, lastMessage: m } : c));
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

    // Someone changed their profile photo.
    socket.on("profile", ({ userId, avatarAt }: { userId: number; avatarAt: number | null }) => {
      setConversations((list) => list.map((c) => c.members.some((m) => m.id === userId)
        ? { ...c, members: c.members.map((m) => (m.id === userId ? { ...m, avatarAt } : m)) }
        : c));
      if (userId === me.id) setMyAvatarAt(avatarAt);
    });

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
      setSocket(null);
      Object.values(typingTimers.current).forEach(clearTimeout);
    };
  }, [serverUrl, token, api, me.id, refreshConversations, markRead]);

  // Tell the server the app is on screen, again every 20 s: a phone that
  // closes the app often cannot say so, and the server stops trusting an old
  // ping after 30 s, so notifications start again.
  useEffect(() => {
    const ping = () => { if (appVisible()) emit("visibility", { visible: true }); };
    const timer = setInterval(ping, 20000);
    const hide = () => emit("visibility", { visible: false });
    if (Platform.OS === "web") window.addEventListener("pagehide", hide);
    return () => {
      clearInterval(timer);
      if (Platform.OS === "web") window.removeEventListener("pagehide", hide);
    };
  }, []);

  // Opening a chat (or coming back to the app) reads its messages.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      emit("visibility", { visible: state === "active" });
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

  const replaceMessage = (conversationId: number, id: number, next: ChatMessage | null) =>
    setMessages((prev) => {
      const list = prev[conversationId] ?? [];
      if (!next) return { ...prev, [conversationId]: list.filter((m) => m.id !== id) };
      const rest = list.filter((m) => m.id !== id && m.id !== next.id);
      // Saved messages go before the ones still sending, in server order.
      return { ...prev, [conversationId]: [...rest.filter((m) => !m.local), next, ...rest.filter((m) => m.local)] };
    });

  // Shows the message straight away with a clock, uploads any file, then
  // swaps in the saved message. On failure the bubble offers "Riprova".
  const send = useCallback(async (conversationId: number, out: Outgoing, retryId?: number) => {
    const tempId = retryId ?? tempIds--;
    const file = out.file;
    const draft: ChatMessage = {
      id: tempId, conversationId, userId: me.id, username: me.username, text: out.text, createdAt: Date.now(),
      kind: file ? kindOf(file.mime) : "text", editedAt: null, deletedAt: null, local: "pending", localFile: file,
      attachment: file ? {
        id: 0, mime: file.mime, name: file.name, size: 0,
        width: file.width ?? null, height: file.height ?? null, duration: file.duration ?? null,
      } : null,
    };
    replaceMessage(conversationId, tempId, draft);
    const fail = () => replaceMessage(conversationId, tempId, { ...draft, local: "failed" });

    const socket = socketRef.current;
    if (!socket?.connected) return fail();
    try {
      const attachmentId = file ? (await api.upload(conversationId, file)).attachment.id : undefined;
      const res = await socket.timeout(15000).emitWithAck("message:send", { conversationId, text: out.text, attachmentId });
      if (res.error) return fail();
      const saved: Message = res.message;
      replaceMessage(conversationId, tempId, saved);
      patchConversation(conversationId, (c) => ({ ...c, lastMessage: saved, updatedAt: saved.createdAt }));
    } catch {
      fail();
    }
  }, [me, api]);

  const discard = useCallback((conversationId: number, tempId: number) => replaceMessage(conversationId, tempId, null), []);

  // Edit / delete for everyone. Resolves to an error message, or null.
  const change = useCallback(async (event: "message:edit" | "message:delete", payload: object) => {
    const socket = socketRef.current;
    if (!socket?.connected) return "Sei offline: riprova quando torna la connessione.";
    try {
      const res = await socket.timeout(10000).emitWithAck(event, payload);
      if (res.error) return res.error as string;
      const m: Message = res.message;
      replaceMessage(m.conversationId, m.id, m);
      setConversations((list) => list.map((c) =>
        c.id === m.conversationId && c.lastMessage?.id === m.id ? { ...c, lastMessage: m } : c));
      return null;
    } catch {
      return "Il server non risponde. Riprova.";
    }
  }, []);
  const editMessage = useCallback((messageId: number, text: string) => change("message:edit", { messageId, text }), [change]);
  const deleteMessage = useCallback((messageId: number) => change("message:delete", { messageId }), [change]);

  const sendTyping = useCallback((conversationId: number, on: boolean) => emit("typing", { conversationId, typing: on }), []);

  const addConversation = useCallback((c: Conversation) =>
    setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort(byActivity)), []);

  const replaceConversation = useCallback((c: Conversation) =>
    setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort(byActivity)), []);
  const acceptRequest = useCallback(async (id: number) => replaceConversation((await api.acceptRequest(id)).conversation), [api]);
  const declineRequest = useCallback(async (id: number) => {
    await api.declineRequest(id);
    setConversations((list) => list.filter((x) => x.id !== id));
  }, [api]);
  const setBlocked = useCallback(async (userId: number, blocked: boolean) => {
    await (blocked ? api.block(userId) : api.unblock(userId));
    // The server also sends the updated chat; mark it right away meanwhile.
    setConversations((list) => list.map((c) => !c.isGroup && c.members.some((m) => m.id === userId) ? { ...c, blockedByMe: blocked } : c));
  }, [api]);

  const totalUnread = conversations.reduce((n, c) => n + (c.myStatus === "pending" ? 0 : c.unread), 0);
  useEffect(() => {
    if (Platform.OS === "web") document.title = totalUnread ? `(${totalUnread}) Vibloo` : "Vibloo";
  }, [totalUnread]);

  return {
    expired, socket, myAvatarAt, setMyAvatarAt, connected, loaded, conversations, messages, typing, totalUnread,
    acceptRequest, declineRequest, setBlocked,
    openConversation, loadOlder, send, discard, editMessage, deleteMessage, sendTyping, addConversation,
  };
}

export type Messenger = ReturnType<typeof useMessenger>;
