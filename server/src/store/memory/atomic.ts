import { timingSafeEqual } from "node:crypto";
import { StoreConflictError, type StoreUniqueConstraint } from "../contracts.js";
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
  private committed: MemoryState;

  constructor(private readonly state: MemoryState) {
    this.committed = structuredClone(state);
  }

  snapshot(): MemoryState {
    return structuredClone(this.committed);
  }

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone(this.state);
    try {
      const result = await operation();
      this.committed = structuredClone(this.state);
      return result;
    } catch (error: unknown) {
      Object.assign(this.state, snapshot);
      throw error;
    } finally {
      release();
    }
  }
}

export function assertUnique<RecordValue>(
  records: readonly RecordValue[],
  conflicts: (record: RecordValue) => boolean,
  constraint: StoreUniqueConstraint,
): void {
  if (records.some(conflicts)) throw new StoreConflictError(constraint);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
