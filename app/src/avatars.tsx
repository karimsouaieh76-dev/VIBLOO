import { createContext, useContext } from "react";

// Builds the URL of a person's profile photo; `version` is when it last changed,
// so a new photo gets a new URL and the old one can be cached forever.
export type AvatarUrl = (userId: number, version: number) => string;

export const AvatarContext = createContext<AvatarUrl | null>(null);
export const useAvatarUrl = () => useContext(AvatarContext);
