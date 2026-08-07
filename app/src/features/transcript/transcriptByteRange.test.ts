import { describe, expect, test } from "vitest";

import { utf8ByteRangeToTextRange } from "./transcriptByteRange";

describe("UTF-8 transcript byte ranges", () => {
  test("converts CJK and emoji byte offsets without splitting code points", () => {
    const text = "甲🙂乙";
    expect(utf8ByteRangeToTextRange(text, 3, 7)).toEqual({ start: 1, end: 3 });
  });

  test("rejects offsets inside a code point or outside the transcript", () => {
    expect(utf8ByteRangeToTextRange("🙂", 1, 4)).toBeNull();
    expect(utf8ByteRangeToTextRange("abc", 0, 4)).toBeNull();
  });
});
