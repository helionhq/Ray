import { useEffect, useRef, useState } from "react";

export interface Notice {
  id: number;
  text: string;
}

export function Toast({ notice }: { notice: Notice | null }) {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState("");
  const last = useRef<Notice | null>(null);

  useEffect(() => {
    if (notice) {
      last.current = notice;
      setText(notice.text);
      const frame = requestAnimationFrame(() => setVisible(true));
      const timer = window.setTimeout(() => setVisible(false), 3800);
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
      };
    }
    setVisible(false);
    const timer = window.setTimeout(() => setText(""), 240);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!text) return null;
  return (
    <div className={`toast${visible ? " is-visible" : ""}`} role="status">
      {text}
    </div>
  );
}
