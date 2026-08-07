import type { LanguagePreference } from "./locale";

export type LanguagePreferencePersistence = {
  save(preference: LanguagePreference): Promise<LanguagePreference>;
  read(): Promise<LanguagePreference>;
};

export type LanguagePreferenceQueueOptions = LanguagePreferencePersistence & {
  persistedAnchor: LanguagePreference | null;
  apply(preference: LanguagePreference): void;
  onLatestSaveFailure(rollbackPreference: LanguagePreference): void;
};

export class LanguagePreferenceQueue {
  readonly apply: (preference: LanguagePreference) => void;

  private readonly save: LanguagePreferencePersistence["save"];
  private readonly read: LanguagePreferencePersistence["read"];
  private readonly onLatestSaveFailure: (
    rollbackPreference: LanguagePreference,
  ) => void;
  private anchor: LanguagePreference | null;
  private latestSequence = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: LanguagePreferenceQueueOptions) {
    this.anchor = options.persistedAnchor;
    this.save = options.save;
    this.read = options.read;
    this.apply = options.apply;
    this.onLatestSaveFailure = options.onLatestSaveFailure;
  }

  get operationSequence(): number {
    return this.latestSequence;
  }

  get persistedAnchor(): LanguagePreference | null {
    return this.anchor;
  }

  select(preference: LanguagePreference): Promise<void> {
    const sequence = ++this.latestSequence;
    this.apply(preference);

    const operation = this.tail.then(() => this.persist(sequence, preference));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }

  private async persist(
    sequence: number,
    preference: LanguagePreference,
  ): Promise<void> {
    try {
      this.anchor = await this.save(preference);
      return;
    } catch {
      if (sequence !== this.latestSequence) {
        return;
      }
    }

    let rollbackPreference = this.anchor;
    if (rollbackPreference === null) {
      try {
        rollbackPreference = await this.read();
        this.anchor = rollbackPreference;
      } catch {
        rollbackPreference = "system";
      }
    }

    if (sequence !== this.latestSequence) {
      return;
    }

    this.apply(rollbackPreference);
    this.onLatestSaveFailure(rollbackPreference);
  }
}
