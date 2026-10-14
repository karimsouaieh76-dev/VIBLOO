import { useColorScheme } from "react-native";

const light = {
  bg: "#edf1f0",
  panel: "#f8faf9",
  line: "#d2dbd8",
  fg: "#142120",
  muted: "#5b6b68",
  accent: "#1d6b60",
  accentFg: "#ffffff",
  accentSoft: "#d5e8e3",
  bubble: "#ffffff",
  mine: "#1d6b60",
  mineFg: "#f2fbf8",
  danger: "#a33a2a",
  online: "#2fae6c",
};

const dark: typeof light = {
  bg: "#0f1716",
  panel: "#141e1d",
  line: "#24302e",
  fg: "#e3ecea",
  muted: "#8d9d9a",
  accent: "#5cc2b0",
  accentFg: "#062320",
  accentSoft: "#1b3531",
  bubble: "#1c2827",
  mine: "#2b7d70",
  mineFg: "#eefaf7",
  danger: "#f08a7a",
  online: "#3ccf82",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

const AVATAR_COLORS = ["#1d6b60", "#7a4fa3", "#b2552e", "#2f6fae", "#8a7a1f", "#a8406b", "#3f7f3a"];
export function avatarColor(userId: number) {
  return AVATAR_COLORS[userId % AVATAR_COLORS.length];
}
