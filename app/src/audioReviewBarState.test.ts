import { describe, expect, test } from "vitest";
import {
  audioProgressPercent,
  clampAudioTime,
  formatAudioClock,
} from "./audioReviewBarState";

describe("audio review bar state", () => {
  test("formats audio clocks for compact transcript review", () => {
    expect(formatAudioClock(0)).toBe("00:00");
    expect(formatAudioClock(7.8)).toBe("00:07");
    expect(formatAudioClock(2905)).toBe("48:25");
    expect(formatAudioClock(3723)).toBe("1:02:03");
    expect(formatAudioClock(Number.NaN)).toBe("00:00");
  });

  test("clamps seeks to the available audio range", () => {
    expect(clampAudioTime(-4, 48)).toBe(0);
    expect(clampAudioTime(12, 48)).toBe(12);
    expect(clampAudioTime(64, 48)).toBe(48);
    expect(clampAudioTime(64, 0)).toBe(64);
  });

  test("calculates scrubber progress safely", () => {
    expect(audioProgressPercent(0, 0)).toBe(0);
    expect(audioProgressPercent(24, 48)).toBe(50);
    expect(audioProgressPercent(96, 48)).toBe(100);
  });
});
