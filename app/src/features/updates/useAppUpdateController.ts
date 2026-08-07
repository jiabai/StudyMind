import { useCallback, useEffect, useRef, useState } from "react";
import { uiMessage } from "../../i18n/uiMessage";
import { extractSafeTechnicalDetails } from "../../safeTechnicalDetails";

import {
  checkForAppUpdate,
  createDefaultUpdatePreferences,
  DEFAULT_RELEASES_URL,
  getUpdateDelivery,
  getUpdatePreferences,
  installAppUpdate,
  openReleasesPage,
  relaunchApp,
  saveUpdatePreferences,
  type AppUpdateInfo,
  type UpdatePreferences,
} from "../../updateClient";
import {
  applyUpdateDownloadEvent,
  createInitialUpdateState,
  failUpdate,
  isUpdateInstallBlocked,
  markUpdateAvailable,
  markUpdateReadyToRestart,
  markUpdateUpToDate,
  postponeUpdate,
  startUpdateCheck,
  startUpdateDownload,
} from "../../updateState";

type UseAppUpdateControllerOptions = {
  processingActive: boolean;
  modelDownloadActive: boolean;
};

export function useAppUpdateController({
  processingActive,
  modelDownloadActive,
}: UseAppUpdateControllerOptions) {
  const [updateState, setUpdateState] = useState(createInitialUpdateState);
  const [inAppUpdates, setInAppUpdates] = useState(true);
  const [deliveryLoaded, setDeliveryLoaded] = useState(false);
  const updateInfoRef = useRef<AppUpdateInfo | null>(null);
  const releasesUrlRef = useRef<string>(DEFAULT_RELEASES_URL);
  const updatePreferencesRef = useRef<UpdatePreferences>(createDefaultUpdatePreferences());
  const updateCheckRequestSequenceRef = useRef(0);
  const updateInstallActiveRef = useRef(false);
  const updateBusy = isUpdateBusy(updateState.status);
  const updateInstallBlocked = isUpdateInstallBlocked({
    processingActive,
    modelDownloadActive,
  });
  const updateToolbarVisible = isUpdateActionVisible(updateState.status);
  const updateSpinnerVisible = updateState.status === "downloading" || updateState.status === "installing";

  const persistUpdatePreferences = useCallback((patch: Partial<UpdatePreferences>) => {
    const next = {
      ...updatePreferencesRef.current,
      ...patch,
    };
    updatePreferencesRef.current = next;
    void saveUpdatePreferences(next).catch((error) => {
      logSafeUpdateWarning("UPDATE_PREFERENCES_SAVE_FAILED", error);
    });
  }, []);

  const invalidateUpdateChecks = useCallback(() => {
    updateCheckRequestSequenceRef.current += 1;
  }, []);

  const checkForUpdates = useCallback(
    async (options: { silent?: boolean; isCancelled?: () => boolean } = {}) => {
      if (updateInstallActiveRef.current) {
        return;
      }

      const requestSequence = updateCheckRequestSequenceRef.current + 1;
      updateCheckRequestSequenceRef.current = requestSequence;
      const canCommit = () =>
        updateCheckRequestSequenceRef.current === requestSequence &&
        !options.isCancelled?.();

      if (!options.silent) {
        persistUpdatePreferences({ postponedUntil: null });
      }
      setUpdateState((current) => startUpdateCheck(current));
      try {
        const update = await checkForAppUpdate();
        if (!canCommit()) {
          return;
        }

        if (!update) {
          updateInfoRef.current = null;
          persistUpdatePreferences({
            lastCheckedAt: new Date().toISOString(),
            skippedVersion: null,
          });
          setUpdateState((current) =>
            options.silent ? createInitialUpdateState() : markUpdateUpToDate(current),
          );
          return;
        }

        updateInfoRef.current = update;
        persistUpdatePreferences({
          lastCheckedAt: new Date().toISOString(),
          skippedVersion: null,
        });
        setUpdateState((current) =>
          markUpdateAvailable(current, {
            version: update.version,
            notes: update.notes,
          }),
        );
      } catch (error) {
        if (!canCommit()) {
          return;
        }

        if (options.silent) {
          setUpdateState(createInitialUpdateState());
          return;
        }

        setUpdateState((current) => failUpdate(current, error));
      }
    },
    [persistUpdatePreferences],
  );

  const loadPreferencesAndCheckForUpdates = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const preferences = await getUpdatePreferences();
        if (isCancelled()) {
          return;
        }
        updatePreferencesRef.current = preferences;
        if (preferences.postponedUntil && preferences.postponedUntil > Date.now()) {
          return;
        }
      } catch (error) {
        logSafeUpdateWarning("UPDATE_PREFERENCES_LOAD_FAILED", error);
      }

      if (!isCancelled()) {
        await checkForUpdates({ silent: true, isCancelled });
      }
    },
    [checkForUpdates],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const delivery = await getUpdateDelivery();
        if (cancelled) {
          return;
        }
        releasesUrlRef.current = delivery.releasesUrl;
        setInAppUpdates(delivery.inAppUpdates);
      } catch (error) {
        logSafeUpdateWarning("UPDATE_DELIVERY_LOAD_FAILED", error);
      } finally {
        if (!cancelled) {
          setDeliveryLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Only platforms with in-app updates (Windows) run the silent startup check.
    // macOS ships DMGs and updates manually, so skip the check to avoid a false
    // "up to date" result against the Windows-only updater manifest.
    if (!deliveryLoaded || !inAppUpdates) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadPreferencesAndCheckForUpdates(() => cancelled);
    }, 2_500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deliveryLoaded, inAppUpdates, loadPreferencesAndCheckForUpdates]);

  const openReleases = useCallback(async () => {
    invalidateUpdateChecks();
    try {
      await openReleasesPage(releasesUrlRef.current);
    } catch (error) {
      setUpdateState((current) => failUpdate(current, error));
    }
  }, [invalidateUpdateChecks]);

  const restartForUpdate = useCallback(async () => {
    invalidateUpdateChecks();
    try {
      await relaunchApp();
    } catch (error) {
      setUpdateState((current) => failUpdate(current, error));
    }
  }, [invalidateUpdateChecks]);

  const installUpdate = useCallback(async () => {
    if (updateState.status === "ready_to_restart") {
      await restartForUpdate();
      return;
    }

    if (updateInstallActiveRef.current) {
      return;
    }

    if (updateInstallBlocked) {
      setUpdateState((current) => ({
        ...current,
        message: uiMessage("updates.state.installBlocked"),
      }));
      return;
    }

    invalidateUpdateChecks();
    let update = updateInfoRef.current;
    if (!update) {
      await checkForUpdates({ silent: false });
      update = updateInfoRef.current;
    }

    if (!update) {
      return;
    }

    invalidateUpdateChecks();
    updateInstallActiveRef.current = true;
    setUpdateState((current) => startUpdateDownload(current));
    try {
      await installAppUpdate(update, (event) => {
        setUpdateState((current) => applyUpdateDownloadEvent(current, event));
      });
      setUpdateState((current) => markUpdateReadyToRestart(current));
    } catch (error) {
      updateInstallActiveRef.current = false;
      setUpdateState((current) => failUpdate(current, error));
    }
  }, [checkForUpdates, invalidateUpdateChecks, restartForUpdate, updateInstallBlocked, updateState.status]);

  const postponeUpdateReminder = useCallback(() => {
    invalidateUpdateChecks();
    const next = postponeUpdate(updateState, 24 * 60 * 60 * 1000);
    setUpdateState(next);
    persistUpdatePreferences({
      postponedUntil: next.postponedUntil,
      skippedVersion: null,
    });
  }, [invalidateUpdateChecks, persistUpdatePreferences, updateState]);

  return {
    updateState,
    updateBusy,
    updateInstallBlocked,
    updateToolbarVisible,
    updateSpinnerVisible,
    inAppUpdates,
    checkForUpdates,
    installUpdate,
    postponeUpdateReminder,
    restartForUpdate,
    openReleases,
  };
}

function isUpdateBusy(status: string): boolean {
  return status === "checking" || status === "downloading" || status === "installing";
}

function isUpdateActionVisible(status: string): boolean {
  return status === "available" || status === "downloading" || status === "installing" || status === "ready_to_restart";
}

export type UpdateWarningCode =
  | "UPDATE_PREFERENCES_SAVE_FAILED"
  | "UPDATE_PREFERENCES_LOAD_FAILED"
  | "UPDATE_DELIVERY_LOAD_FAILED";

export function logSafeUpdateWarning(code: UpdateWarningCode, error: unknown): void {
  const errorRecord = isUnknownRecord(error) ? error : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : errorRecord?.message;
  const details = extractSafeTechnicalDetails({
    errorCode: errorRecord?.code,
    stageCode: errorRecord?.stageCode,
    message,
  });

  console.warn(code, details);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
