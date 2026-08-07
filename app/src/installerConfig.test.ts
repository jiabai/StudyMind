import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

type TauriConfig = {
  bundle?: {
    windows?: {
      nsis?: {
        installerIcon?: string;
        uninstallerIcon?: string;
      };
    };
  };
};

const tauriConfigUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const tauriRootUrl = new URL("../src-tauri/", import.meta.url);

function loadTauriConfig(): TauriConfig {
  return JSON.parse(readFileSync(tauriConfigUrl, "utf8")) as TauriConfig;
}

describe("installer config", () => {
  test("pins the Windows NSIS installer icon to the StudyMind ICO asset", () => {
    const config = loadTauriConfig();
    const nsisConfig = config.bundle?.windows?.nsis;

    expect(nsisConfig?.installerIcon).toBe("icons/icon.ico");
    expect(nsisConfig?.uninstallerIcon).toBe("icons/icon.ico");
    expect(existsSync(new URL(nsisConfig?.installerIcon ?? "", tauriRootUrl))).toBe(true);
  });
});
