import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// SecureStore has no web implementation; fall back to localStorage there.
export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") return void globalThis.localStorage?.setItem(key, value);
  return SecureStore.setItemAsync(key, value);
}

export async function removeItem(key: string): Promise<void> {
  if (Platform.OS === "web") return void globalThis.localStorage?.removeItem(key);
  return SecureStore.deleteItemAsync(key);
}
