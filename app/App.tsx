import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError, Conversation, createApi, DEFAULT_SERVER_URL, SAME_ORIGIN, User } from "./src/api";
import { getItem, removeItem, setItem } from "./src/storage";
import { disablePush, registerServiceWorker, syncPush } from "./src/push";
import { useTheme } from "./src/theme";
import { useMessenger } from "./src/useMessenger";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ChatsScreen } from "./src/screens/ChatsScreen";
import { NewChatScreen } from "./src/screens/NewChatScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { CallScreen } from "./src/screens/CallScreen";
import { callsSupported, useCalls } from "./src/useCalls";
import { otherMembers } from "./src/format";

type Session = { serverUrl: string; token: string; user: User };

export default function App() {
  const t = useTheme();
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    registerServiceWorker();
    (async () => {
      const url = SAME_ORIGIN ? DEFAULT_SERVER_URL : (await getItem("serverUrl")) ?? DEFAULT_SERVER_URL;
      setServerUrl(url);
      const token = await getItem("token");
      if (token) {
        try {
          const { user } = await createApi(url, token).me();
          setSession({ serverUrl: url, token, user });
        } catch (e) {
          // Keep the token when the server is just unreachable; drop it if rejected.
          if (e instanceof ApiError && e.status === 401) await removeItem("token");
        }
      }
      setBooting(false);
    })();
  }, []);

  async function login(s: Session) {
    await setItem("serverUrl", s.serverUrl);
    await setItem("token", s.token);
    setServerUrl(s.serverUrl);
    setSession(s);
  }

  async function logout() {
    if (session) await disablePush(createApi(session.serverUrl, session.token)).catch(() => {});
    await removeItem("token");
    setSession(null);
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {booting ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.bg }}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : session ? (
        <SignedIn session={session} onLogout={logout} />
      ) : (
        <LoginScreen initialServerUrl={serverUrl} onLoggedIn={login} />
      )}
    </SafeAreaProvider>
  );
}

function initialChatFromUrl(): number | null {
  if (Platform.OS !== "web") return null;
  const id = Number(new URLSearchParams(window.location.search).get("chat"));
  if (id) window.history.replaceState(null, "", "/");
  return id || null;
}

type Screen = { name: "chats" } | { name: "new" } | { name: "chat"; conversation: Conversation };

function SignedIn({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const api = useMemo(() => createApi(session.serverUrl, session.token), [session]);
  const messenger = useMessenger(session.serverUrl, session.token, session.user, api);
  const calls = useCalls(messenger.socket, api);
  const [screen, setScreen] = useState<Screen>({ name: "chats" });
  const home = useCallback(() => setScreen({ name: "chats" }), []);
  const [wanted, setWanted] = useState<number | null>(initialChatFromUrl);

  // Keep this device's push subscription known to the server.
  useEffect(() => { syncPush(api).catch(() => {}); }, [api]);

  // A tapped notification asks for a chat, via the URL or the service worker.
  useEffect(() => {
    if (Platform.OS !== "web" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-chat" && e.data.conversationId) setWanted(Number(e.data.conversationId));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (wanted == null || !messenger.loaded) return;
    const conversation = messenger.conversations.find((c) => c.id === wanted);
    if (conversation) setScreen({ name: "chat", conversation });
    setWanted(null);
  }, [wanted, messenger.loaded, messenger.conversations]);

  let content: React.ReactNode;
  if (screen.name === "chat") {
    const conversation = screen.conversation;
    const onCall = callsSupported()
      ? (media: "audio" | "video") => {
          const peer = otherMembers(conversation, session.user)[0];
          if (peer) calls.startCall(conversation.id, { id: peer.id, username: peer.username }, media);
        }
      : undefined;
    content = <ChatScreen me={session.user} api={api} messenger={messenger} conversation={conversation} onBack={home} onCall={onCall} />;
  } else if (screen.name === "new") {
    content = (
      <NewChatScreen
        api={api} onBack={home}
        onOpened={(conversation) => { messenger.addConversation(conversation); setScreen({ name: "chat", conversation }); }}
      />
    );
  } else {
    content = (
      <ChatsScreen
        me={session.user} api={api} messenger={messenger} onLogout={onLogout}
        onOpen={(conversation) => setScreen({ name: "chat", conversation })}
        onNewChat={() => setScreen({ name: "new" })}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {content}
      {calls.error ? (
        <Pressable onPress={calls.clearError} style={callErrorStyle} accessibilityRole="alert">
          <Text style={{ color: "#fff", fontSize: 14 }}>{calls.error}  ✕</Text>
        </Pressable>
      ) : null}
      <CallScreen calls={calls} />
    </View>
  );
}

const callErrorStyle = {
  position: "absolute" as const, left: 16, right: 16, bottom: 90, padding: 14, borderRadius: 12, backgroundColor: "#a33a2a",
};
