import { Platform } from "react-native";

export type User = { id: number; username: string; avatarAt?: number | null };
export type Person = User & { online: boolean; lastSeen: number | null; avatarAt: number | null };
export type MemberStatus = "accepted" | "pending";
export type Member = Person & { lastReadId: number; lastDeliveredId: number; status: MemberStatus; deleted?: boolean };
export type Attachment = {
  id: number;
  mime: string;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null; // milliseconds, voice notes only
};
export type MessageKind = "text" | "image" | "audio" | "file" | "call" | "system";
export type Message = {
  id: number;
  conversationId: number;
  userId: number;
  username: string;
  kind: MessageKind;
  text: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  attachment: Attachment | null;
  replyTo?: ReplyRef | null; // the message this one answers
  reactions?: Reaction[];
};
export type ReplyRef = { id: number; userId: number; username: string; kind: MessageKind; text: string; deleted: boolean };
export type Reaction = { userId: number; username: string; emoji: string };
export type Invite = {
  code: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "used" | "expired";
  usedBy: string | null;
};

// A file picked or recorded on this device, before upload.
export type LocalFile = {
  uri: string;
  mime: string;
  name: string;
  width?: number;
  height?: number;
  duration?: number;
};
export type Conversation = {
  id: number;
  isGroup: boolean;
  name: string | null;
  members: Member[];
  lastMessage: Message | null;
  unread: number;
  updatedAt: number;
  myStatus: MemberStatus; // "pending": a message request I have not answered
  blockedByMe: boolean;
  createdBy?: number | null; // group admin
  mutedUntil?: number | null; // notifications silenced until then
};

// On the web the app is served by the chat server itself, so it talks to the
// same address it was opened from.
export const SAME_ORIGIN = Platform.OS === "web" && !process.env.EXPO_PUBLIC_SERVER_URL;
export const DEFAULT_SERVER_URL = SAME_ORIGIN
  ? globalThis.location.origin
  : process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function createApi(baseUrl: string, token?: string) {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(root + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ApiError(`Server non raggiungibile su ${root}. Controlla la connessione.`, 0);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error ?? `Errore del server (${res.status}).`, res.status);
    return body as T;
  }

  const post = <T>(path: string, data: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(data) });

  return {
    register: (username: string, password: string, invite?: string) =>
      post<{ token: string; user: User }>("/api/register", { username, password, invite }),
    checkInvite: (code: string) =>
      request<{ valid: boolean; inviter: string | null }>(`/api/invites/${encodeURIComponent(code)}`),
    invites: () => request<{ invites: Invite[]; inviteOnly: boolean }>("/api/invites"),
    createInvite: () => post<{ invite: Invite }>("/api/invites", {}),
    deleteInvite: (code: string) => request<{ ok: true }>(`/api/invites/${code}`, { method: "DELETE" }),
    login: (username: string, password: string) =>
      post<{ token: string; user: User }>("/api/login", { username, password }),
    me: () => request<{ user: User }>("/api/me"),
    changePassword: (current: string, password: string) =>
      request<{ token: string }>("/api/me/password", { method: "PUT", body: JSON.stringify({ current, password }) }),
    createPasswordReset: (username: string) =>
      post<{ code: string; username: string; expiresAt: number }>("/api/password-resets", { username }),
    resetPassword: (username: string, code: string, password: string) =>
      post<{ token: string; user: User }>("/api/password/reset", { username, code, password }),
    searchUsers: (q: string) => request<{ users: Person[] }>(`/api/users?q=${encodeURIComponent(q)}`),
    conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
    contacts: () => request<{ users: Person[] }>("/api/contacts"),
    acceptRequest: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/accept`, {}),
    declineRequest: (id: number) => post<{ ok: true }>(`/api/conversations/${id}/decline`, {}),
    blocks: () => request<{ users: User[] }>("/api/blocks"),
    block: (userId: number) => post<{ ok: true }>("/api/blocks", { userId }),
    unblock: (userId: number) => request<{ ok: true }>(`/api/blocks/${userId}`, { method: "DELETE" }),
    openDirect: (userId: number) => post<{ conversation: Conversation }>("/api/conversations", { userId }),
    createGroup: (name: string, userIds: number[]) =>
      post<{ conversation: Conversation }>("/api/conversations", { name, userIds }),
    renameGroup: (id: number, name: string) =>
      request<{ conversation: Conversation }>(`/api/conversations/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
    addMembers: (id: number, userIds: number[]) => post<{ conversation: Conversation }>(`/api/conversations/${id}/members`, { userIds }),
    removeMember: (id: number, userId: number) =>
      request<{ ok: true }>(`/api/conversations/${id}/members/${userId}`, { method: "DELETE" }),
    mute: (id: number, until: number | null) =>
      request<{ conversation: Conversation }>(`/api/conversations/${id}/mute`, { method: "PUT", body: JSON.stringify({ until }) }),
    search: (q: string) => request<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(q)}`),
    deleteAccount: (password: string) => request<{ ok: true }>("/api/me", { method: "DELETE", body: JSON.stringify({ password }) }),
    messages: (conversationId: number, before?: number) =>
      request<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages${before ? `?before=${before}` : ""}`),

    async upload(conversationId: number, file: LocalFile) {
      const data = await (await fetch(file.uri)).blob();
      // A recorder may pick a different container than asked; trust the recording.
      const type = file.mime.startsWith("audio/") && data.type ? data.type : file.mime;
      const headers: Record<string, string> = { "content-type": type, "x-file-name": encodeURIComponent(file.name) };
      if (file.width) headers["x-width"] = String(file.width);
      if (file.height) headers["x-height"] = String(file.height);
      if (file.duration) headers["x-duration"] = String(Math.round(file.duration));
      return request<{ attachment: Attachment }>(`/api/conversations/${conversationId}/attachments`, {
        method: "POST", body: data, headers,
      });
    },
    // <img> and <audio> cannot send headers, so the token rides in the URL.
    attachmentUrl: (id: number, download = false) =>
      `${root}/api/attachments/${id}?token=${encodeURIComponent(token ?? "")}${download ? "&download=1" : ""}`,

    callConfig: () => request<{ iceServers: RTCIceServer[]; hasTurn: boolean }>("/api/call-config"),
    async setAvatar(file: LocalFile) {
      const data = await (await fetch(file.uri)).blob();
      return request<{ avatarAt: number }>("/api/me/avatar", { method: "PUT", body: data, headers: { "content-type": file.mime } });
    },
    removeAvatar: () => request<{ avatarAt: null }>("/api/me/avatar", { method: "DELETE" }),
    avatarUrl: (userId: number, version: number) =>
      `${root}/api/users/${userId}/avatar?v=${version}&token=${encodeURIComponent(token ?? "")}`,
    pushKey: () => request<{ publicKey: string }>("/api/push/key"),
    pushSubscribe: (subscription: unknown) => post<{ ok: true }>("/api/push/subscribe", { subscription }),
    pushTest: () => post<{ devices: number }>("/api/push/test", {}),
    pushUnsubscribe: (endpoint: string) => post<{ ok: true }>("/api/push/unsubscribe", { endpoint }),
  };
}

export type Api = ReturnType<typeof createApi>;
