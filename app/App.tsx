import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError, Channel, createApi, DEFAULT_SERVER_URL, SAME_ORIGIN, User } from "./src/api";
import { getItem, removeItem, setItem } from "./src/storage";
import { useTheme } from "./src/theme";
import { useChat } from "./src/useChat";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ChannelsScreen } from "./src/screens/ChannelsScreen";
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

function SignedIn({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const api = useMemo(() => createApi(session.serverUrl, session.token), [session]);
  const chat = useChat(session.serverUrl, session.token, api);
  const [open, setOpen] = useState<Channel | null>(null);

  if (open) return <ChatScreen me={session.user} chat={chat} channel={open} onBack={() => setOpen(null)} />;
  return <ChannelsScreen me={session.user} chat={chat} onOpen={setOpen} onLogout={onLogout} />;
}
