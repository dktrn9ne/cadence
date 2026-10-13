import { expect, test } from "@playwright/test";
import { _electron } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("built desktop shell can safely own its payment session without importing a wallet", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "cadence-desktop-"));
  let app;
  try {
    app = await _electron.launch({
      executablePath: join(process.cwd(), "node_modules/electron/dist/electron"),
      args: ["electron/main.cjs", "--no-sandbox"],
      env: { ...process.env, XDG_CONFIG_HOME: dataDirectory },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("button", { name: "Import wallet", exact: false })).toBeVisible();
    await expect(page.getByText("Payments are paused")).toHaveCount(0);
    expect(await page.evaluate(() => Boolean(navigator.locks))).toBe(true);
    expect(await page.title()).toBe("Cadence on XRPL");
    expect(errors).toEqual([]);
    // No secret entry, no wallet creation, no ledger connection, no signing.
  } finally {
    await app?.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
