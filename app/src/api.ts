import { Platform } from "react-native";

export type User = { id: number; username: string };
export type Person = User & { online: boolean; lastSeen: number | null };
export type Member = Person & { lastReadId: number; lastDeliveredId: number };
export type Message = {
  id: number;
  conversationId: number;
  userId: number;
  username: string;
  text: string;
  createdAt: number;
};
export type Conversation = {
  id: number;
  isGroup: boolean;
  name: string | null;
  members: Member[];
  lastMessage: Message | null;
  unread: number;
  updatedAt: number;
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
    register: (username: string, password: string) =>
      post<{ token: string; user: User }>("/api/register", { username, password }),
    login: (username: string, password: string) =>
      post<{ token: string; user: User }>("/api/login", { username, password }),
    me: () => request<{ user: User }>("/api/me"),
    searchUsers: (q: string) => request<{ users: Person[] }>(`/api/users?q=${encodeURIComponent(q)}`),
    conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
    openDirect: (userId: number) => post<{ conversation: Conversation }>("/api/conversations", { userId }),
    createGroup: (name: string, userIds: number[]) =>
      post<{ conversation: Conversation }>("/api/conversations", { name, userIds }),
    messages: (conversationId: number, before?: number) =>
      request<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages${before ? `?before=${before}` : ""}`),
  };
}

export type Api = ReturnType<typeof createApi>;
