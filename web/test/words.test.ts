import { describe, expect, it } from "vitest";
import { countTranscriptWords, countWords } from "../worker/lib/words";

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

  it("counts every Han character as a word (CJK undercount fix)", () => {
    expect(countWords("你好世界")).toBe(4);
    expect(countWords("你好，世界")).toBe(4);
    expect(countWords("今天 天气 很好")).toBe(6);
  });

  it("counts Hiragana, Katakana and Hangul characters", () => {
    expect(countWords("こんにちは世界")).toBe(7);
    expect(countWords("カタカナ")).toBe(4);
    expect(countWords("안녕하세요")).toBe(5);
  });

  it("combines CJK characters with adjacent non-CJK words", () => {
    expect(countWords("hello 世界")).toBe(3);
    expect(countWords("Hello世界")).toBe(3);
    expect(countWords("2026年11月")).toBe(4);
  });
});

describe("countTranscriptWords", () => {
  it("prefers the AssemblyAI words array when present", () => {
    expect(
      countTranscriptWords({
        text: "one two three",
        words: [{}, {}],
      }),
    ).toBe(2);
    expect(countTranscriptWords({ text: "ignored", words: [] })).toBe(0);
  });

  it("falls back to counting text without a words array", () => {
    expect(countTranscriptWords({ text: "one two three" })).toBe(3);
    expect(countTranscriptWords({ text: "你好 世界" })).toBe(4);
    expect(countTranscriptWords({ words: "not-an-array" as unknown, text: "a b" })).toBe(
      2,
    );
  });

  it("returns 0 for malformed payloads", () => {
    expect(countTranscriptWords(null)).toBe(0);
    expect(countTranscriptWords({})).toBe(0);
    expect(countTranscriptWords({ text: 42 })).toBe(0);
  });
});
