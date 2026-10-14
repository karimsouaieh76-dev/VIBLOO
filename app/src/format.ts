import type { Conversation, Member, Message, User } from "./api";

const time = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("it-IT", { weekday: "long" });
const shortDate = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" });
const longDate = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long" });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (ts: number) => Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);

export const formatTime = (ts: number) => time.format(ts);

// Chat list column: "14:32", "Ieri", "lunedì", "12/10/26".
export function formatListDate(ts: number) {
  const d = daysAgo(ts);
  if (d === 0) return time.format(ts);
  if (d === 1) return "Ieri";
  if (d < 7) return weekday.format(ts);
  return shortDate.format(ts);
}

// Day separators inside a chat.
export function formatDay(ts: number) {
  const d = daysAgo(ts);
  if (d === 0) return "Oggi";
  if (d === 1) return "Ieri";
  return longDate.format(ts);
}

export function formatLastSeen(m: { online: boolean; lastSeen: number | null }) {
  if (m.online) return "online";
  if (!m.lastSeen) return "";
  const d = daysAgo(m.lastSeen);
  if (d === 0) return `ultimo accesso oggi alle ${time.format(m.lastSeen)}`;
  if (d === 1) return `ultimo accesso ieri alle ${time.format(m.lastSeen)}`;
  return `ultimo accesso il ${shortDate.format(m.lastSeen)}`;
}

export function otherMembers(c: Conversation, me: User): Member[] {
  return c.members.filter((m) => m.id !== me.id);
}

export function conversationTitle(c: Conversation, me: User) {
  if (c.isGroup) return c.name ?? "Gruppo";
  return otherMembers(c, me)[0]?.username ?? "Chat";
}

export type Status = "pending" | "sent" | "delivered" | "read" | "failed";

export function formatDuration(ms: number | null | undefined) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

// One line for the chat list and notifications.
export function messagePreview(m: Message, me: User) {
  if (m.deletedAt) return m.userId === me.id ? "🚫 Hai eliminato questo messaggio" : "🚫 Messaggio eliminato";
  const a = m.attachment;
  if (m.kind === "image") return m.text ? `📷 ${m.text}` : "📷 Foto";
  if (m.kind === "audio") return `🎤 Messaggio vocale (${formatDuration(a?.duration)})`;
  if (m.kind === "file") return `📎 ${a?.name ?? "File"}`;
  return m.text;
}

// WhatsApp-style ticks: every other member must have received / read it.
export function messageStatus(c: Conversation, me: User, m: Message): Status {
  const others = otherMembers(c, me);
  if (!others.length) return "sent";
  if (others.every((o) => o.lastReadId >= m.id)) return "read";
  if (others.every((o) => o.lastDeliveredId >= m.id)) return "delivered";
  return "sent";
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}
