import { describe, expect, it } from "vitest";
import { countWords } from "../worker/lib/words";

describe("countWords", () => {
  it("returns 0 for empty and whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
    expect(countWords("   \n\t\r\n ")).toBe(0);
  });

  it("counts a single token", () => {
    expect(countWords("hello")).toBe(1);
    expect(countWords("  hello  ")).toBe(1);
  });

  it("counts whitespace-separated tokens", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("hello,   world\nagain")).toBe(3);
    expect(countWords("one\ttwo\r\nthree")).toBe(3);
  });

  it("treats punctuation attached to a token as part of the token", () => {
    expect(countWords("Hello, world!")).toBe(2);
    expect(countWords("foo—bar")).toBe(1);
  });

  it("handles Unicode whitespace", () => {
    expect(countWords("a b")).toBe(2);
  });
});
