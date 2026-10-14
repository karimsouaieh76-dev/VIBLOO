import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { LocalFile } from "./api";

const MAX_SIDE = 1600;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Picks a photo and shrinks it to at most 1600 px on the long side, as JPEG,
// so it uploads quickly and fits the free database.
export async function pickPhoto(): Promise<LocalFile | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  const landscape = a.width >= a.height;
  const tooBig = Math.max(a.width, a.height) > MAX_SIDE;
  const ctx = ImageManipulator.manipulate(a.uri);
  if (tooBig) ctx.resize(landscape ? { width: MAX_SIDE } : { height: MAX_SIDE });
  const img = await (await ctx.renderAsync()).saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  const base = (a.fileName ?? "foto").replace(/\.[^.]+$/, "");
  return { uri: img.uri, mime: "image/jpeg", name: `${base}.jpg`, width: img.width, height: img.height };
}

export async function pickFile(): Promise<LocalFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  if (a.size && a.size > MAX_UPLOAD_BYTES) throw new Error("Il file supera i 15 MB.");
  // Images sent as files keep their original quality, like WhatsApp's "documento".
  return { uri: a.uri, mime: a.mimeType || "application/octet-stream", name: a.name };
}

// Voice notes: MP4/AAC where the browser can record it (Safari, recent
// Chrome), so every phone can play it back; WebM/Opus otherwise.
export function webRecordingMime() {
  if (Platform.OS !== "web" || typeof MediaRecorder === "undefined") return undefined;
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
}

// Profile photo: the centre square of the picture, 512 × 512 JPEG.
export async function pickAvatar(): Promise<LocalFile | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  const side = Math.min(a.width, a.height);
  const ctx = ImageManipulator.manipulate(a.uri);
  if (a.width && a.height && a.width !== a.height) {
    ctx.crop({ originX: Math.round((a.width - side) / 2), originY: Math.round((a.height - side) / 2), width: side, height: side });
  }
  ctx.resize({ width: 512, height: 512 });
  const img = await (await ctx.renderAsync()).saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
  return { uri: img.uri, mime: "image/jpeg", name: "profilo.jpg", width: img.width, height: img.height };
}
