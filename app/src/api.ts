export type User = { id: number; username: string };
export type Channel = { id: number; name: string; createdAt: number };
export type Message = {
  id: number;
  channelId: number;
  text: string;
  createdAt: number;
  userId: number;
  username: string;
};

export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:3000";

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
      throw new ApiError(`Server non raggiungibile su ${root}. Controlla l'indirizzo e che il server sia acceso.`, 0);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error ?? `Errore del server (${res.status}).`, res.status);
    return body as T;
  }

  return {
    register: (username: string, password: string) =>
      request<{ token: string; user: User }>("/api/register", { method: "POST", body: JSON.stringify({ username, password }) }),
    login: (username: string, password: string) =>
      request<{ token: string; user: User }>("/api/login", { method: "POST", body: JSON.stringify({ username, password }) }),
    me: () => request<{ user: User }>("/api/me"),
    channels: () => request<{ channels: Channel[] }>("/api/channels"),
    createChannel: (name: string) =>
      request<{ channel: Channel }>("/api/channels", { method: "POST", body: JSON.stringify({ name }) }),
    messages: (channelId: number, before?: number) =>
      request<{ messages: Message[] }>(`/api/channels/${channelId}/messages${before ? `?before=${before}` : ""}`),
  };
}

export type Api = ReturnType<typeof createApi>;
