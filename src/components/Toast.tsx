import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "./Icons";

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
      let clearTimer: number | undefined;
      const timer = window.setTimeout(() => {
        setVisible(false);
        // Leave the exit transition (160ms) time to finish before unmounting.
        clearTimer = window.setTimeout(() => setText(""), 160);
      }, 3800);
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
        if (clearTimer !== undefined) window.clearTimeout(clearTimer);
      };
    }
    setVisible(false);
    const timer = window.setTimeout(() => setText(""), 160);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!text) return null;
  return (
    <div className={`toast${visible ? " is-visible" : ""}`} role="status">
      <CheckIcon size={14} />
      <span>{text}</span>
    </div>
  );
}
