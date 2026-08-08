import { describe, expect, test, vi } from "vitest";
import { createOtpSender } from "../src/email.js";

describe("StudyMind OTP email", () => {
  test("requires explicit console delivery configuration and never enables it in production", () => {
    expect(() => createOtpSender({ environment: "development", smtp: null, allowConsoleOtp: false }))
      .toThrow("STUDYMIND_ALLOW_CONSOLE_OTP");
    expect(() => createOtpSender({ environment: "production", smtp: null, allowConsoleOtp: true }))
      .toThrow("production");
  });

  test("uses only StudyMind identity and never logs the OTP on delivery failure", async () => {
    const error = vi.fn();
    const sendMail = vi.fn(async (message: { subject: string; text: string }) => {
      expect(message.subject).toContain("StudyMind");
      expect(message.text).toContain("StudyMind");
      expect(message.subject + message.text).not.toContain("FrameQ");
      throw new Error("provider failure");
    });
    const sender = createOtpSender(
      { environment: "production", smtp: { host: "smtp.example.com", port: 465, secure: true, user: "u", pass: "p", from: "StudyMind <noreply@example.com>" }, allowConsoleOtp: false },
      () => ({ sendMail }), { error },
    );
    await expect(sender("user@example.com", "123456")).rejects.toThrow("provider failure");
    expect(error.mock.calls.flat().join(" ")).not.toContain("123456");
    expect(error.mock.calls.flat().join(" ")).toContain("[StudyMind]");
  });

  test("delivers an explicitly enabled development OTP through the dedicated sink", async () => {
    const write = vi.fn();
    const sender = createOtpSender({ environment: "development", smtp: null, allowConsoleOtp: true }, undefined, { write });
    await sender("student@example.com", "654321");
    expect(write).toHaveBeenCalledWith("student@example.com", "654321");
  });
});
