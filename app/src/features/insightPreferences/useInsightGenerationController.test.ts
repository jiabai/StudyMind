import { readFileSync } from "node:fs";
import type { SetStateAction } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountStatus } from "../../accountState";
import type {
  GenerationPreferences,
  InspirationProfile,
  PreferenceSnapshot,
} from "../../insightPreferences";
import type { InsightPreferenceState } from "../../insightPreferencesClient";
import type { SupportedLocale } from "../../i18n/locale";
import type { UiMessage } from "../../i18n/uiMessage";
import type {
  InsightRetryTarget,
  WorkflowState,
} from "../../workflow";
import type { InsightGenerationController } from "./useInsightGenerationController";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

type OpenAccountPanel = (notice?: UiMessage) => void;

type RetryInsightGeneration = (
  target: InsightRetryTarget,
  outputLanguage: SupportedLocale,
  preferenceSnapshot: PreferenceSnapshot | null,
  account: AccountStatus,
  openAccountPanel: OpenAccountPanel,
  onRetryCompleted?: () => void | Promise<void>,
) => Promise<void>;

type ControllerCallbacks = {
  setActionNotice: (value: SetStateAction<UiMessage | null>) => void;
  closeSettings: () => void;
  closeDetail: () => void;
  openAccountPanel: OpenAccountPanel;
  refreshAccountStatus: () => Promise<void>;
  retryInsightGeneration: RetryInsightGeneration;
  aiBlockerMessage: (account: AccountStatus) => UiMessage;
};

const mocks = vi.hoisted(() => ({
  getInsightPreferences: vi.fn<() => Promise<InsightPreferenceState>>(),
  saveDefaultGenerationPreferences:
    vi.fn<(preferences: GenerationPreferences) => Promise<InsightPreferenceState>>(),
  saveInspirationProfile:
    vi.fn<(profile: InspirationProfile) => Promise<InsightPreferenceState>>(),
  skipInspirationProfile: vi.fn<() => Promise<InsightPreferenceState>>(),
}));

vi.mock("../../insightPreferencesClient", () => ({
  getInsightPreferences: mocks.getInsightPreferences,
  saveDefaultGenerationPreferences: mocks.saveDefaultGenerationPreferences,
  saveInspirationProfile: mocks.saveInspirationProfile,
  skipInspirationProfile: mocks.skipInspirationProfile,
}));

const PROFILE: InspirationProfile = {
  role: "marketing_sales",
  domain: "marketing_sales",
  stage: "manager",
  cityContext: "new_tier1_city",
  genderPerspective: "unspecified",
  platforms: ["douyin"],
};

const GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "content_creation",
  scenario: "short_video",
  angles: ["topic_angle"],
  audience: "beginners",
  styles: ["direct_sharp"],
  avoid: [],
};

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useState: <T,>(initialValue: T | (() => T)) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setState = (next: StateUpdater<T>) => {
        states[stateIndex] =
          typeof next === "function"
            ? (next as (current: T) => T)(states[stateIndex] as T)
            : next;
      };
      return [states[stateIndex] as T, setState];
    },
  };
}

function createWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  const { dissection, dissectionStale, ...rest } = overrides;
  return {
    stage: "partial_completed",
    cancellingFromStage: null,
    activeAiTarget: null,
    aiErrorTarget: null,
    aiTargetErrors: {},
    composerSource: { kind: "none" },
    taskSource: {
      kind: "url",
      url: "https://example.test/video",
    },
    statusMessage: null,
    progressMessage: null,
    progressPercent: 100,
    text: "transcript body",
    summary: "",
    insights: [],
    taskId: "task-1",
    taskDir: "D:/StudyMind/tasks/task-1",
    artifacts: {
      transcript_txt: "transcript/transcript.txt",
    },
    transcript: null,
    dissection: dissection ?? null,
    dissectionStale: dissectionStale ?? false,
    error: null,
    ...rest,
  };
}

function createAccount(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    authenticated: true,
    email: "user@example.test",
    entitlementStatus: "active",
    entitlementExpiresAt: "2026-07-22T08:00:00.000Z",
    llmQuotaLimit: 20,
    llmQuotaUsed: 1,
    llmQuotaRemaining: 19,
    llmQuotaResetsAt: "2026-07-22T08:00:00.000Z",
    llmConfigured: true,
    lastVerifiedAt: "2026-07-09T08:00:00.000Z",
    canProcess: true,
    canGenerateAi: true,
    serverError: null,
    ...overrides,
  };
}

function createInsightPreferences(
  overrides: Partial<InsightPreferenceState> = {},
): InsightPreferenceState {
  return {
    profile: PROFILE,
    profileSkipped: false,
    profileStatus: "valid",
    profileError: null,
    defaultGenerationPreferences: null,
    legacyGenerationPreferenceSeed: null,
    preferencesPath: "D:/StudyMind/app-data/insight-preferences.json",
    ...overrides,
  };
}

function createCallbacks(): ControllerCallbacks {
  return {
    setActionNotice: vi.fn(),
    closeSettings: vi.fn(),
    closeDetail: vi.fn(),
    openAccountPanel: vi.fn(),
    refreshAccountStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    retryInsightGeneration: vi.fn<RetryInsightGeneration>().mockResolvedValue(undefined),
    aiBlockerMessage: vi.fn(() => ({
      messageCode: "account.notice.aiUnavailable",
    })),
  };
}

async function createController(options: {
  workflow?: WorkflowState;
  account?: AccountStatus;
  callbacks?: Partial<ControllerCallbacks>;
  outputLanguage?: SupportedLocale;
} = {}): Promise<{
  render: () => InsightGenerationController;
  setOutputLanguage: (locale: SupportedLocale) => void;
  callbacks: ControllerCallbacks;
  account: AccountStatus;
}> {
  const harness = createHookHarness();
  const callbacks = { ...createCallbacks(), ...options.callbacks };
  const workflow = options.workflow ?? createWorkflow();
  const account = options.account ?? createAccount();
  let outputLanguage = options.outputLanguage ?? "en-US";

  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useState: harness.useState,
  }));
  const { useInsightGenerationController } = await import("./useInsightGenerationController");

  return {
    render: () => {
      harness.resetRender();
      return useInsightGenerationController({
        workflow,
        account,
        setActionNotice: callbacks.setActionNotice,
        closeSettings: callbacks.closeSettings,
        closeDetail: callbacks.closeDetail,
        openAccountPanel: callbacks.openAccountPanel,
        refreshAccountStatus: callbacks.refreshAccountStatus,
        outputLanguage,
        retryInsightGeneration: callbacks.retryInsightGeneration,
        aiBlockerMessage: callbacks.aiBlockerMessage,
      });
    },
    setOutputLanguage: (locale) => {
      outputLanguage = locale;
    },
    callbacks,
    account,
  };
}

describe("useInsightGenerationController", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  test("does not open summary confirmation without a task and transcript", async () => {
    const { render, callbacks } = await createController({
      workflow: createWorkflow({ taskId: null, artifacts: {} }),
    });

    let controller = render();
    controller.openSummaryConfirmation();
    controller = render();

    expect(controller.summaryConfirmOpen).toBe(false);
    expect(callbacks.setActionNotice).toHaveBeenCalledWith({
      messageCode: "preferences.notice.transcriptRequiredSummary",
    });
  });

  test("opens summary confirmation when task and transcript are available", async () => {
    const { render, callbacks } = await createController();

    let controller = render();
    controller.openSummaryConfirmation();
    controller = render();

    expect(controller.summaryConfirmOpen).toBe(true);
    expect(callbacks.setActionNotice).toHaveBeenCalledWith(null);
  });

  test("opens the account panel when summary generation is blocked by account state", async () => {
    const blockedAccount = createAccount({ canGenerateAi: false });
    const { render, callbacks } = await createController({ account: blockedAccount });

    const controller = render();
    await controller.confirmSummaryGeneration();

    expect(callbacks.aiBlockerMessage).toHaveBeenCalledWith(blockedAccount);
    expect(callbacks.openAccountPanel).toHaveBeenCalledWith({
      messageCode: "account.notice.aiUnavailable",
    });
    expect(callbacks.retryInsightGeneration).not.toHaveBeenCalled();
  });

  test("confirms summary generation for an eligible account", async () => {
    const { render, callbacks, account } = await createController();

    let controller = render();
    controller.openSummaryConfirmation();
    controller = render();
    expect(controller.summaryConfirmOpen).toBe(true);

    await controller.confirmSummaryGeneration();
    controller = render();

    expect(controller.summaryConfirmOpen).toBe(false);
    expect(callbacks.retryInsightGeneration).toHaveBeenCalledWith(
      "summary",
      "en-US",
      null,
      account,
      callbacks.openAccountPanel,
      callbacks.refreshAccountStatus,
    );
    expect(callbacks.openAccountPanel).not.toHaveBeenCalled();
  });

  test("sends a non-default actual locale for summary generation", async () => {
    const { render, callbacks } = await createController({ outputLanguage: "zh-TW" });

    const controller = render();
    await controller.confirmSummaryGeneration();

    expect(callbacks.retryInsightGeneration).toHaveBeenCalledWith(
      "summary",
      "zh-TW",
      null,
      expect.any(Object),
      callbacks.openAccountPanel,
      callbacks.refreshAccountStatus,
    );
  });

  test("does not open insight preference flow without a task and transcript", async () => {
    const { render, callbacks } = await createController({
      workflow: createWorkflow({ taskId: null, artifacts: {} }),
    });

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();

    expect(controller.insightPreferenceFlow).toBeNull();
    expect(mocks.getInsightPreferences).not.toHaveBeenCalled();
    expect(callbacks.setActionNotice).toHaveBeenCalledWith({
      messageCode: "preferences.notice.transcriptRequiredInsights",
    });
  });

  test("creates insight preference flow after loading saved preferences", async () => {
    const preferences = createInsightPreferences({
      profile: null,
      profileSkipped: true,
      profileStatus: "skipped",
    });
    mocks.getInsightPreferences.mockResolvedValueOnce(preferences);
    const { render, callbacks } = await createController();

    let controller = render();
    const openFlow = controller.openInsightPreferenceFlow();
    controller = render();
    expect(controller.insightPreferenceBusy).toBe(true);

    await openFlow;
    controller = render();

    expect(mocks.getInsightPreferences).toHaveBeenCalledTimes(1);
    expect(callbacks.setActionNotice).toHaveBeenCalledWith(null);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toEqual(
      expect.objectContaining({
        screen: "generation_step",
        profile: null,
        profileSkipped: true,
      }),
    );
  });

  test("surfaces insight preference load errors when opening the flow", async () => {
    mocks.getInsightPreferences.mockRejectedValueOnce(new Error("preferences unavailable"));
    const { render, callbacks } = await createController();

    let controller = render();
    const openFlow = controller.openInsightPreferenceFlow();
    controller = render();
    expect(controller.insightPreferenceBusy).toBe(true);

    await openFlow;
    controller = render();

    expect(mocks.getInsightPreferences).toHaveBeenCalledTimes(1);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toBeNull();
    expect(callbacks.setActionNotice).toHaveBeenCalledWith(null);
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.preferencesReadFailed",
    });
  });

  test("opens generation preference editing from detail", async () => {
    mocks.getInsightPreferences.mockResolvedValueOnce(
      createInsightPreferences({ defaultGenerationPreferences: GENERATION_PREFERENCES }),
    );
    const { render, callbacks } = await createController();

    let controller = render();
    await controller.openDirectionEditorFromDetail();
    controller = render();

    expect(callbacks.closeDetail).toHaveBeenCalledTimes(1);
    expect(mocks.getInsightPreferences).toHaveBeenCalledTimes(1);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toEqual(
      expect.objectContaining({
        screen: "generation_step",
        currentStep: "goal",
        generationPreferences: GENERATION_PREFERENCES,
      }),
    );
  });

  test("closes detail and surfaces preference load errors when editing from detail", async () => {
    mocks.getInsightPreferences.mockRejectedValueOnce(new Error("preferences locked"));
    const { render, callbacks } = await createController();

    let controller = render();
    const openEditor = controller.openDirectionEditorFromDetail();
    controller = render();
    expect(controller.insightPreferenceBusy).toBe(true);

    await openEditor;
    controller = render();

    expect(callbacks.closeDetail).toHaveBeenCalledTimes(1);
    expect(mocks.getInsightPreferences).toHaveBeenCalledTimes(1);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toBeNull();
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.preferencesReadFailed",
    });
  });

  test("surfaces summary retry failures after closing the confirmation", async () => {
    const retryInsightGeneration = vi
      .fn<RetryInsightGeneration>()
      .mockRejectedValueOnce(new Error("worker failed"));
    const { render, callbacks } = await createController({
      callbacks: { retryInsightGeneration },
    });

    let controller = render();
    controller.openSummaryConfirmation();
    controller = render();
    expect(controller.summaryConfirmOpen).toBe(true);

    await controller.confirmSummaryGeneration();
    controller = render();

    expect(controller.summaryConfirmOpen).toBe(false);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(callbacks.retryInsightGeneration).toHaveBeenCalledTimes(1);
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.summaryStartFailed",
    });
  });

  test("saves generation preferences and retries insight generation", async () => {
    const savedPreferences = createInsightPreferences({
      defaultGenerationPreferences: GENERATION_PREFERENCES,
    });
    mocks.getInsightPreferences.mockResolvedValueOnce(createInsightPreferences());
    mocks.saveDefaultGenerationPreferences.mockResolvedValueOnce(savedPreferences);
    const { render, callbacks, account } = await createController();

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();
    expect(controller.insightPreferenceFlow).not.toBeNull();

    await controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    controller = render();

    expect(mocks.saveDefaultGenerationPreferences).toHaveBeenCalledWith(
      GENERATION_PREFERENCES,
    );
    expect(controller.insightPreferenceFlow).toBeNull();
    expect(callbacks.retryInsightGeneration).toHaveBeenCalledWith(
      "insights",
      "en-US",
      expect.objectContaining({
        profile: PROFILE,
        profileSkipped: false,
        generationPreferences: GENERATION_PREFERENCES,
      }),
      account,
      callbacks.openAccountPanel,
      callbacks.refreshAccountStatus,
    );
  });

  test("freezes insight output language before deferred preference save and uses the new locale next time", async () => {
    let resolveFirstSave: ((value: InsightPreferenceState) => void) | undefined;
    mocks.getInsightPreferences.mockResolvedValue(createInsightPreferences());
    mocks.saveDefaultGenerationPreferences
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce(
        createInsightPreferences({ defaultGenerationPreferences: GENERATION_PREFERENCES }),
      );
    const { render, setOutputLanguage, callbacks } = await createController({
      outputLanguage: "en-US",
    });

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();
    const firstConfirmation = controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    controller = render();
    expect(controller.confirmedOutputLanguage).toBe("en-US");

    setOutputLanguage("zh-TW");
    controller = render();
    expect(controller.confirmedOutputLanguage).toBe("en-US");
    resolveFirstSave?.(
      createInsightPreferences({ defaultGenerationPreferences: GENERATION_PREFERENCES }),
    );
    await firstConfirmation;
    controller = render();
    expect(controller.confirmedOutputLanguage).toBeNull();

    expect(callbacks.retryInsightGeneration).toHaveBeenNthCalledWith(
      1,
      "insights",
      "en-US",
      expect.any(Object),
      expect.any(Object),
      callbacks.openAccountPanel,
      callbacks.refreshAccountStatus,
    );

    await controller.openInsightPreferenceFlow();
    controller = render();
    await controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    expect(callbacks.retryInsightGeneration).toHaveBeenNthCalledWith(
      2,
      "insights",
      "zh-TW",
      expect.any(Object),
      expect.any(Object),
      callbacks.openAccountPanel,
      callbacks.refreshAccountStatus,
    );
  });

  test("freezes both final confirmation locales on the first handler line", () => {
    const source = readFileSync(
      new URL("./useInsightGenerationController.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /const confirmSummaryGeneration = useCallback\(async \(\) => \{\s*const confirmedOutputLanguage = outputLanguage;/,
    );
    expect(source).toMatch(
      /async \(preferences: GenerationPreferences\) => \{\s*const confirmedOutputLanguage = outputLanguage;/,
    );
  });

  test("surfaces default preference save failures and keeps the flow open", async () => {
    mocks.getInsightPreferences.mockResolvedValueOnce(createInsightPreferences());
    mocks.saveDefaultGenerationPreferences.mockRejectedValueOnce(new Error("save failed"));
    const { render, callbacks } = await createController();

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();
    expect(controller.insightPreferenceFlow).not.toBeNull();

    await controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    controller = render();

    expect(mocks.saveDefaultGenerationPreferences).toHaveBeenCalledWith(
      GENERATION_PREFERENCES,
    );
    expect(callbacks.retryInsightGeneration).not.toHaveBeenCalled();
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).not.toBeNull();
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.insightsStartFailed",
    });
  });

  test("restores the current locale after a deferred save failure and uses it on the next confirmation", async () => {
    let rejectFirstSave: ((reason: Error) => void) | undefined;
    mocks.getInsightPreferences.mockResolvedValue(createInsightPreferences());
    mocks.saveDefaultGenerationPreferences
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstSave = reject;
          }),
      )
      .mockResolvedValueOnce(
        createInsightPreferences({ defaultGenerationPreferences: GENERATION_PREFERENCES }),
      );
    const { render, setOutputLanguage, callbacks } = await createController({
      outputLanguage: "en-US",
    });

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();
    const firstConfirmation = controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    controller = render();
    expect(controller.confirmedOutputLanguage).toBe("en-US");

    setOutputLanguage("zh-TW");
    controller = render();
    expect(controller.confirmedOutputLanguage).toBe("en-US");
    rejectFirstSave?.(new Error("save failed"));
    await firstConfirmation;
    controller = render();

    expect(controller.confirmedOutputLanguage).toBeNull();
    expect(controller.insightPreferenceFlow).not.toBeNull();
    expect(callbacks.retryInsightGeneration).not.toHaveBeenCalled();

    await controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    expect(callbacks.retryInsightGeneration).toHaveBeenCalledWith(
      "insights",
      "zh-TW",
      expect.any(Object),
      expect.any(Object),
      callbacks.openAccountPanel,
      callbacks.refreshAccountStatus,
    );
  });

  test("surfaces insight retry failures after saving preferences", async () => {
    const retryInsightGeneration = vi
      .fn<RetryInsightGeneration>()
      .mockRejectedValueOnce(new Error("retry failed"));
    const savedPreferences = createInsightPreferences({
      defaultGenerationPreferences: GENERATION_PREFERENCES,
    });
    mocks.getInsightPreferences.mockResolvedValueOnce(createInsightPreferences());
    mocks.saveDefaultGenerationPreferences.mockResolvedValueOnce(savedPreferences);
    const { render, callbacks } = await createController({
      callbacks: { retryInsightGeneration },
    });

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();

    await controller.confirmInsightPreferences(GENERATION_PREFERENCES);
    controller = render();

    expect(mocks.saveDefaultGenerationPreferences).toHaveBeenCalledWith(
      GENERATION_PREFERENCES,
    );
    expect(callbacks.retryInsightGeneration).toHaveBeenCalledTimes(1);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toBeNull();
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.insightsStartFailed",
    });
  });

  test("surfaces profile skip failures and keeps the current flow", async () => {
    mocks.getInsightPreferences.mockResolvedValueOnce(createInsightPreferences());
    mocks.skipInspirationProfile.mockRejectedValueOnce(new Error("skip failed"));
    const { render, callbacks } = await createController();

    let controller = render();
    await controller.openInsightPreferenceFlow();
    controller = render();
    const currentFlow = controller.insightPreferenceFlow;
    expect(currentFlow).not.toBeNull();

    await controller.skipCurrentProfileSetup();
    controller = render();

    expect(mocks.skipInspirationProfile).toHaveBeenCalledTimes(1);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toEqual(currentFlow);
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.skipSaveFailed",
    });
  });

  test("surfaces profile save failures and resets busy state", async () => {
    mocks.saveInspirationProfile.mockRejectedValueOnce(new Error("profile save failed"));
    const { render, callbacks } = await createController();

    let controller = render();
    const saveProfile = controller.saveCurrentProfile(PROFILE);
    controller = render();
    expect(controller.insightPreferenceBusy).toBe(true);

    await saveProfile;
    controller = render();

    expect(mocks.saveInspirationProfile).toHaveBeenCalledWith(PROFILE);
    expect(controller.insightPreferenceBusy).toBe(false);
    expect(controller.insightPreferenceFlow).toBeNull();
    expect(callbacks.setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "preferences.notice.profileSaveFailed",
    });
  });
});
