import { useEffect, useState } from "react";

const BASE_TITLE = "Ray — Fast, clean dictation for Windows";

export function usePrefersDark() {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return dark;
}

export function usePageTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} — Ray` : BASE_TITLE;
  }, [title]);
}
