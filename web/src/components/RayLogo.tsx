import type { CSSProperties } from "react";

const PITCH = 3.3;
const RADIUS = 1.42;
const HEIGHTS = [1, 3, 5, 7, 5, 3, 1];

interface LogoDot {
  cx: number;
  cy: number;
  on: boolean;
  delay: number;
  opacity?: string;
}

const dots: LogoDot[] = [];

function push(
  column: number,
  row: number,
  on: boolean,
  delay: number,
  opacity?: string,
) {
  dots.push({
    cx: Number((PITCH / 2 + PITCH * column).toFixed(2)),
    cy: Number((PITCH / 2 + PITCH * row).toFixed(2)),
    on,
    delay,
    opacity,
  });
}

// Seven columns of a lit pulse: the plate behind the wordmark.
for (let column = 0; column < 7; column++) {
  const top = 3 - (HEIGHTS[column] >> 1);
  for (let row = 0; row < 7; row++) {
    const on = row >= top && row < top + HEIGHTS[column];
    push(
      column,
      row,
      on,
      Math.round((Math.abs(column - 3) + Math.abs(row - 3) * 0.6) * 28),
      on ? (1 - 0.09 * Math.abs(column - 3)).toFixed(2) : undefined,
    );
  }
}

// Dot-matrix glyphs for R, a, y.
const GLYPHS = {
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  a: ["", "", ".XXX.", "....X", ".XXXX", "X...X", ".XXXX"],
  y: [
    "",
    "",
    "X...X",
    "X...X",
    "X...X",
    "X...X",
    ".XXXX",
    "....X",
    ".XXX.",
  ],
};
const STARTS = { R: 10, a: 16, y: 22 };

for (const [letter, rows] of Object.entries(GLYPHS)) {
  const start = STARTS[letter as keyof typeof STARTS];
  rows.forEach((row, rowIndex) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== "X") continue;
      const column = start + i;
      push(
        column,
        rowIndex,
        true,
        Math.abs(column - 3) * 14 + Math.abs(rowIndex - 3) * 8,
      );
    }
  });
}

/** The dot-matrix Ray wordmark, generated exactly like the app's. */
export function RayLogo({
  className,
  width = 89.1,
  height = 29.7,
}: {
  className?: string;
  width?: number;
  height?: number;
}) {
  return (
    <svg
      className={className ? `logo ${className}` : "logo"}
      width={width}
      height={height}
      viewBox="0 0 89.1 29.7"
      role="img"
      aria-label="Ray"
    >
      {dots.map((dot, index) => (
        <circle
          key={index}
          className={dot.on ? "on" : "off"}
          cx={dot.cx}
          cy={dot.cy}
          r={RADIUS}
          style={
            {
              "--d": `${dot.delay}ms`,
              ...(dot.opacity !== undefined ? { "--o": dot.opacity } : {}),
            } as CSSProperties
          }
        />
      ))}
    </svg>
  );
}
