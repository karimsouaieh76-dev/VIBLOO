import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError, Conversation, createApi, DEFAULT_SERVER_URL, SAME_ORIGIN, User } from "./src/api";
import { getItem, removeItem, setItem } from "./src/storage";
import { useTheme } from "./src/theme";
import { useMessenger } from "./src/useMessenger";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ChatsScreen } from "./src/screens/ChatsScreen";
import { NewChatScreen } from "./src/screens/NewChatScreen";
import { ChatScreen } from "./src/screens/ChatScreen";

type Session = { serverUrl: string; token: string; user: User };

export default function App() {
  const t = useTheme();
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
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

type Screen = { name: "chats" } | { name: "new" } | { name: "chat"; conversation: Conversation };

function SignedIn({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const api = useMemo(() => createApi(session.serverUrl, session.token), [session]);
  const messenger = useMessenger(session.serverUrl, session.token, session.user, api);
  const [screen, setScreen] = useState<Screen>({ name: "chats" });
  const home = useCallback(() => setScreen({ name: "chats" }), []);

  if (screen.name === "chat") {
    return <ChatScreen me={session.user} messenger={messenger} conversation={screen.conversation} onBack={home} />;
  }
  if (screen.name === "new") {
    return (
      <NewChatScreen
        api={api} onBack={home}
        onOpened={(conversation) => { messenger.addConversation(conversation); setScreen({ name: "chat", conversation }); }}
      />
    );
  }
  return (
    <ChatsScreen
      me={session.user} messenger={messenger} onLogout={onLogout}
      onOpen={(conversation) => setScreen({ name: "chat", conversation })}
      onNewChat={() => setScreen({ name: "new" })}
    />
  );
}
