import { expect, test } from "@playwright/test";

test("production app keeps exactly one payment tab and restores ownership after close", async ({ context, page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Opening-screen verification only: no wallet connection, secrets, or ledger calls.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Connect XRPL wallet/i })).toBeVisible();
  await expect(page.getByText("Payments are paused")).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(navigator.locks))).toBe(true);
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  await second.goto("/");
  await expect(second.getByRole("heading", { name: "Payments are paused" })).toBeVisible();
  await expect(second.getByRole("button", { name: /Connect XRPL wallet/i })).toHaveCount(0);
  await page.close();
  await second.reload();
  await expect(second.getByRole("button", { name: /Connect XRPL wallet/i })).toBeVisible();
  await expect(second.getByText("Payments are paused")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("opening screen fills a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Connect XRPL wallet/i })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
