import { useEffect, useRef } from "react";
import { DotScope } from "./dotScope";
import { usePrefersDark } from "../lib/hooks";

/** Hex's synthetic voice, used by the product's browser preview too. */
function demoLevel(time: number) {
  const phrase = Math.floor(time / 2.4);
  const t = time - phrase * 2.4;
  if (t > 1.7) return 0.04;
  const shape = Math.sin((Math.PI * t) / 1.7) ** 0.4;
  const rate = 2 * Math.PI * (4.3 + 0.6 * Math.sin(phrase * 1.7));
  const syllable = 0.5 + 0.5 * Math.sin(rate * t + phrase);
  const stress = 0.75 + 0.25 * Math.sin(2 * Math.PI * 1.1 * t + 2 * phrase);
  return Math.max(
    0,
    Math.min(1, 0.08 + 0.82 * shape * syllable ** 1.6 * stress),
  );
}

/**
 * A still frame of the real floating bar, rendered with the exact DotScope
 * the desktop app uses. Static on purpose: this is a storefront, not a
 * recording, and a 60 Hz canvas in the hero is not worth the battery.
 */
export function HeroBar() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dark = usePrefersDark();

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    let frame = 0;
    const draw = () => {
      const scope = new DotScope(element);
      // Simulate into a settled speaking frame, paint once, then stop.
      scope.preview("recording", 1.55, demoLevel);
      scope.destroy();
    };

    draw();

    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [dark]);

  return (
    <div className="hero-bar" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
