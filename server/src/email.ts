import nodemailer from "nodemailer";

type SmtpConfig = { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
type Config = { environment: "development" | "test" | "production"; smtp: SmtpConfig | null; allowConsoleOtp: boolean };
type Transport = { sendMail(message: LoginCodeMessage): Promise<unknown> };
type Output = { warn?(message: string): void; write?(email: string, code: string): void; error?(message: string): void };
type LoginCodeMessage = { from: string; to: string; subject: string; text: string; html: string };

export function createOtpSender(
  config: Config,
  createTransport: (options: object) => Transport = (options) => nodemailer.createTransport(options),
  output: Output = console,
) {
  if (config.smtp) {
    const smtp = config.smtp;
    const transport = createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.pass } });
    return async (email: string, code: string) => {
      try { await transport.sendMail(buildLoginCodeMessage({ from: smtp.from, to: email, code })); }
      catch (error) { output.error?.(`[StudyMind] OTP delivery failed for ${email}.`); throw error; }
    };
  }
  if (config.environment === "production") throw new Error("SMTP configuration is required in production; console OTP is forbidden.");
  if (!config.allowConsoleOtp) throw new Error("STUDYMIND_ALLOW_CONSOLE_OTP=1 is required when SMTP is absent.");
  output.warn?.("[StudyMind] DEVELOPMENT ONLY: console OTP delivery is enabled.");
  return async (email: string, code: string) => { output.write?.(email, code); };
}

export function buildLoginCodeMessage(input: { from: string; to: string; code: string }): LoginCodeMessage {
  return { from: input.from, to: input.to, subject: "StudyMind login code",
    text: `Your StudyMind login code is: ${input.code}\n\nThis code expires in 10 minutes.`,
    html: `<h2>StudyMind login code</h2><p>Your verification code is:</p><strong>${input.code}</strong><p>This code expires in 10 minutes.</p>` };
}
