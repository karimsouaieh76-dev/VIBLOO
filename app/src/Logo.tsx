import { Image } from "react-native";
import { useTheme } from "./theme";

const RATIO = 649 / 171;

// The Vibloo wordmark, drawn in the theme's text colour (dark on light, light on dark).
export function Logo({ height = 32 }: { height?: number }) {
  const t = useTheme();
  return (
    <Image
      source={require("../assets/logo.png")}
      accessibilityRole="header"
      accessibilityLabel="Vibloo"
      resizeMode="contain"
      style={{ height, width: height * RATIO, tintColor: t.fg }}
    />
  );
}
