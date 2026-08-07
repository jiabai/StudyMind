import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IpcProtocolError,
  readIpcDataObject,
} from "./tauriIpcProtocol";
import type { UpdateDownloadEvent } from "./updateState";

export const DEFAULT_RELEASES_URL = "https://github.com/jiabai/StudyMind/releases/latest";

export type UpdateDelivery = {
  inAppUpdates: boolean;
  releasesUrl: string;
};
export type UpdateDeliveryRunner = () => Promise<unknown>;
export type OpenReleasesRunner = (url: string) => Promise<void>;

export type AppUpdateHandle = {
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall: (onEvent?: (event: UpdateDownloadEvent) => void) => Promise<void>;
};

export type AppUpdateInfo = {
  version: string;
  date?: string;
  notes: string;
  handle: AppUpdateHandle;
};

export type UpdateCheckRunner = () => Promise<AppUpdateHandle | null>;
export type RelaunchRunner = () => Promise<void>;
export type UpdatePreferences = {
  lastCheckedAt: string | null;
  postponedUntil: number | null;
  skippedVersion: string | null;
};
export type UpdatePreferencesCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const defaultUpdateCheckRunner: UpdateCheckRunner = async () =>
  (await check()) as AppUpdateHandle | null;
const defaultPreferencesRunner: UpdatePreferencesCommandRunner = (command, args) =>
  invoke(command, args);
const defaultDeliveryRunner: UpdateDeliveryRunner = async () =>
  invoke("get_update_delivery");
const defaultOpenReleasesRunner: OpenReleasesRunner = (url) => openUrl(url);
const UPDATE_IPC_RESPONSE_INVALID = "UPDATE_IPC_RESPONSE_INVALID" as const;

export async function getUpdateDelivery(
  runner: UpdateDeliveryRunner = defaultDeliveryRunner,
): Promise<UpdateDelivery> {
  return mapUpdateDelivery(await runner());
}

export async function openReleasesPage(
  url: string,
  runner: OpenReleasesRunner = defaultOpenReleasesRunner,
): Promise<void> {
  await runner(url && url.length > 0 ? url : DEFAULT_RELEASES_URL);
}

function mapUpdateDelivery(value: unknown): UpdateDelivery {
  const response = readIpcDataObject(
    value,
    ["inAppUpdates", "releasesUrl"],
    [],
    UPDATE_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.inAppUpdates !== "boolean" ||
    typeof response.releasesUrl !== "string"
  ) {
    throwInvalidUpdateResponse();
  }
  return {
    inAppUpdates: response.inAppUpdates,
    releasesUrl: response.releasesUrl,
  };
}

export async function checkForAppUpdate(
  runner: UpdateCheckRunner = defaultUpdateCheckRunner,
): Promise<AppUpdateInfo | null> {
  const update = await runner();
  if (!update) {
    return null;
  }

  return {
    version: update.version,
    date: update.date,
    notes: update.body ?? "",
    handle: update,
  };
}

export async function installAppUpdate(
  update: AppUpdateInfo,
  onEvent?: (event: UpdateDownloadEvent) => void,
): Promise<void> {
  await update.handle.downloadAndInstall((event) => {
    const normalized = normalizeDownloadEvent(event);
    if (normalized) {
      onEvent?.(normalized);
    }
  });
}

export async function relaunchApp(runner: RelaunchRunner = relaunch): Promise<void> {
  await runner();
}

export async function getUpdatePreferences(
  runner: UpdatePreferencesCommandRunner = defaultPreferencesRunner,
): Promise<UpdatePreferences> {
  return mapUpdatePreferences(
    await runner("get_update_preferences", {}),
  );
}

export async function saveUpdatePreferences(
  preferences: UpdatePreferences,
  runner: UpdatePreferencesCommandRunner = defaultPreferencesRunner,
): Promise<UpdatePreferences> {
  return mapUpdatePreferences(
    await runner("save_update_preferences", { preferences }),
  );
}

export function createDefaultUpdatePreferences(): UpdatePreferences {
  return {
    lastCheckedAt: null,
    postponedUntil: null,
    skippedVersion: null,
  };
}

function normalizeDownloadEvent(event: unknown): UpdateDownloadEvent | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const value = event as {
    event?: unknown;
    data?: {
      contentLength?: unknown;
      chunkLength?: unknown;
    };
  };

  if (value.event === "Started") {
    return {
      event: "Started",
      data: {
        contentLength:
          typeof value.data?.contentLength === "number" ? value.data.contentLength : undefined,
      },
    };
  }

  if (value.event === "Progress") {
    return {
      event: "Progress",
      data: {
        chunkLength:
          typeof value.data?.chunkLength === "number" ? value.data.chunkLength : undefined,
      },
    };
  }

  if (value.event === "Finished") {
    return { event: "Finished" };
  }

  return null;
}

function mapUpdatePreferences(value: unknown): UpdatePreferences {
  const response = readIpcDataObject(
    value,
    ["lastCheckedAt", "postponedUntil", "skippedVersion"],
    [],
    UPDATE_IPC_RESPONSE_INVALID,
  );
  if (
    !isNullableString(response.lastCheckedAt) ||
    !isNullableSafeUnsignedInteger(response.postponedUntil) ||
    !isNullableString(response.skippedVersion)
  ) {
    throwInvalidUpdateResponse();
  }
  return {
    lastCheckedAt: response.lastCheckedAt,
    postponedUntil: response.postponedUntil,
    skippedVersion: response.skippedVersion,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableSafeUnsignedInteger(
  value: unknown,
): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0)
  );
}

function throwInvalidUpdateResponse(): never {
  throw new IpcProtocolError(UPDATE_IPC_RESPONSE_INVALID);
}
