// D7.2/D7.4: login flow E2E — login page, admin login, logout, viewer RBAC
// (forbidden mutation returns tRPC -32003 FORBIDDEN), wrong-password error.
// Requires seeded users: admin@enertrek.local/admin1234, viewer@enertrek.local/viewer123.
import { test, expect, type Page } from "@playwright/test";

// Note: the app's <Label> is not htmlFor-associated with its <Input>, so we
// select by input type instead of getByLabel.
async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enertrek Cloud" })).toBeVisible();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("login page is shown at / when unauthenticated", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enertrek Cloud" })).toBeVisible();
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("admin logs in, sees the dashboard, and signs out", async ({ page }) => {
  await signIn(page, "admin@enertrek.local", "admin1234");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Enertrek Cloud" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("viewer reaches the dashboard but mutations are forbidden (RBAC)", async ({ page }) => {
  await signIn(page, "viewer@enertrek.local", "viewer123");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Attempt a privileged mutation from the page context. The httpOnly session
  // cookie rides along automatically (same-origin fetch).
  const result = await page.evaluate(async () => {
    const res = await fetch("/api/trpc/sites.create?batch=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "0": { json: { name: "pw-e2e" } } }),
    });
    return res.json();
  });

  const error = result?.[0]?.error?.json;
  expect(error, `expected tRPC error, got: ${JSON.stringify(result)}`).toBeTruthy();
  expect(error.code).toBe(-32003); // FORBIDDEN
  expect(error.data.code).toBe("FORBIDDEN");
  expect(error.data.httpStatus).toBe(403);
});

test("wrong password shows an error and stays on the login page", async ({ page }) => {
  await signIn(page, "admin@enertrek.local", "definitely-wrong-password");
  await expect(page.getByText("Invalid email or password").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
