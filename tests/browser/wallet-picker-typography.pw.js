import { expect, test } from "@playwright/test";

// Typography probe for the wallet-picker path (the gap PR #31's font
// self-hosting left: Karla was registered but the connector modal's shadow
// CSS kept rendering its own system stack). Two claims must hold together:
//
// 1. The picker rows actually compute the self-hosted Karla stack
//    (theme.fontConnector injected on the connector element as
//    --xc-font-family, forwarded by the SDK into its modal portals).
// 2. Making Karla effective actually FETCHES its woff2 binaries — from the
//    app's own origin only, with zero third-party font hosts.
test("wallet picker renders self-hosted Karla and fetches its woff2 locally", async ({ context, page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Hard gate on the no-third-party contract: anything not served by the
  // app's own origin is aborted before it leaves the machine.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Connect XRPL wallet/i }).click();

  // The picker renders into a portal div on document.body with its own open
  // shadow root; Playwright CSS pierces open shadow roots.
  const row = page.locator("[data-xrpl-overlay-portal] [data-wallet-id]").first();
  await expect(row).toBeVisible();

  const fontFamily = await row.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(fontFamily, "the picker must render Karla, not the SDK's system stack").toContain("Karla");
  expect(fontFamily).not.toContain("-apple-system");

  // Karla's woff2 binaries must actually be fetched — registration alone was
  // the original defect — and every fetched font must be same-origin.
  const fonts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => /\.woff2(\?|$)/i.test(entry.name))
      .map((entry) => new URL(entry.name))
  );
  expect(fonts.some((url) => /karla/i.test(url.pathname)), "Karla woff2 should be fetched").toBe(true);
  expect(fonts.every((url) => url.hostname === "127.0.0.1"), "every font must be same-origin").toBe(true);

  expect(errors).toEqual([]);
});
