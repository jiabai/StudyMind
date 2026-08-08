import type {
  ActivationCodeRecord, AdminEntitlementAdjustmentRecord, AdminSessionRecord,
  AuthRateLimitRecord, DesktopLoginTicketRecord, EmailOtpRecord, EntitlementRecord,
  LlmConfigRecord, LlmUsageEventRecord, OrderRecord, SessionRecord, UserRecord,
  UserSessionRecord, WebhookEventRecord,
} from "../contracts.js";

export type MemoryState = {
  users: UserRecord[]; emailOtps: EmailOtpRecord[]; desktopLoginTickets: DesktopLoginTicketRecord[];
  sessions: SessionRecord[]; orders: OrderRecord[]; entitlements: EntitlementRecord[];
  llmConfig: LlmConfigRecord | null; llmUsageEvents: LlmUsageEventRecord[];
  activationCodes: ActivationCodeRecord[]; adminSessions: AdminSessionRecord[];
  adminEntitlementAdjustments: AdminEntitlementAdjustmentRecord[]; webhookEvents: WebhookEventRecord[];
  authRateLimits: AuthRateLimitRecord[]; userSessions: UserSessionRecord[];
};

export class MemoryAtomicCoordinator {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly state: MemoryState) {}

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone(this.state);
    try {
      return await operation();
    } catch (error: unknown) {
      Object.assign(this.state, snapshot);
      throw error;
    } finally {
      release();
    }
  }
}
