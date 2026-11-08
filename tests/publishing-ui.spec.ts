import { test, expect, type Page, type Route } from "@playwright/test";

const origin = "http://127.0.0.1:3108";
const updatedAt = "2026-11-05T10:00:00.000Z";
const image = { filename: "cover.png", mime_type: "image/png", size_bytes: 100, status: "ready" };
const asset = (id: string, media = image) => ({ media_id: id, role: "gallery", position: 0, media });
type Target = { id: string; platform: string; status: string; published_url?: string; delivery_uncertain?: boolean };
type Job = { id: string; status: string; execution_mode: string; targets: Target[] };

async function setup(page: Page) {
  const state = {
    project: { id: "publishing-ui", workspace_id: "workspace-ui", title: "สินค้าไทย", description: "รายละเอียดสินค้า", hashtags: ["งานไทย", "#พร้อมส่ง"], price: 1234.5, updated_at: updatedAt, assets: [asset("image-one")] },
    publishing: { jobs: [] as Job[], destination: { page_id: "123456789", page_name: "เพจทดสอบ", enabled: true, live_enabled: true }, liveEnabled: true },
    posts: [] as Record<string, unknown>[], gets: 0, unexpected: [] as string[],
    post: async (route: Route) => { await route.fulfill({ status: 202, json: { jobId: "job-ui" } }); },
  };
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
    if (url.origin === origin && request.method() === "GET") {
      if (url.pathname === "/api/dashboard") return route.fulfill({ json: { configured: true, authenticated: true, owner: true, media: [] } });
      if (url.pathname === "/api/projects") return route.fulfill({ json: { projects: [state.project] } });
      if (url.pathname === `/api/projects/${state.project.id}/publishing`) {
        state.gets++;
        return route.fulfill({ json: state.publishing });
      }
    }
    if (url.origin === origin && request.method() === "POST" && url.pathname === `/api/projects/${state.project.id}/publish`) {
      state.posts.push(request.postDataJSON());
      return state.post(route);
    }
    state.unexpected.push(`${request.method()} ${request.url()}`);
    await route.abort();
  });
  return state;
}

async function open(page: Page) {
  await page.goto("/library");
  await page.getByRole("button", { name: "เผยแพร่ Facebook", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "เผยแพร่ไป Facebook" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("เพจทดสอบ (123456789)", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "สถานะเผยแพร่" })).toHaveAttribute("aria-busy", "false");
  return dialog;
}
const confirm = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "ยืนยันโพสต์จริง", exact: true });
async function approve(page: Page) {
  await page.getByRole("dialog").getByRole("checkbox").check();
  await expect(confirm(page)).toBeEnabled();
}

test("library preview requires explicit confirmation and never auto posts", async ({ page }) => {
  const state = await setup(page);
  state.project.assets.push(asset("video-one", { filename: "สินค้า.mp4", mime_type: "video/mp4", size_bytes: 100, status: "ready" }));
  const dialog = await open(page);
  await expect(dialog.getByRole("region", { name: "ตัวอย่าง caption" })).toContainText("สินค้าไทย\n\nรายละเอียดสินค้า\n\nราคา 1234.50 บาท\n\n#งานไทย #พร้อมส่ง");
  await expect(dialog.getByText(/แนบ MP4: สินค้า.mp4/)).toContainText("ภาพปกและ gallery จะไม่ถูกแนบและไม่ใช้เป็น thumbnail");
  await expect(confirm(page)).toBeDisabled();
  expect(state.posts).toHaveLength(0);
  await dialog.getByRole("button", { name: "ตรวจสถานะ", exact: true }).click();
  await expect.poll(() => state.gets).toBe(2);
  await approve(page);
  expect(state.posts).toHaveLength(0);
  await confirm(page).click();
  await expect(dialog.getByText(/ระบบรับคำสั่งแล้ว ไม่ใช่การยืนยันว่าโพสต์สำเร็จ/)).toBeVisible();
  expect(state.posts).toEqual([{ submissionKey: expect.stringMatching(/^[\da-f-]{36}$/i), mode: "live", confirmLive: true, expectedUpdatedAt: updatedAt }]);
  expect(state.unexpected).toEqual([]);
});

for (const gate of ["system", "workspace", "destination"] as const) {
  test(`closed ${gate} gate blocks publishing`, async ({ page }) => {
    const state = await setup(page);
    if (gate === "system") state.publishing.liveEnabled = false;
    if (gate === "workspace") state.publishing.destination.live_enabled = false;
    if (gate === "destination") state.publishing.destination.enabled = false;
    const dialog = await open(page);
    await expect(dialog.getByText(gate === "destination" ? "เพจปลายทางยังไม่เปิดใช้งาน" : "ระบบหรือ workspace ยังไม่เปิดโพสต์จริง", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toBeDisabled();
    await expect(confirm(page)).toBeDisabled();
    expect(state.posts).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
  });
}

test("multiple distinct images are unsupported", async ({ page }) => {
  const state = await setup(page);
  state.project.assets.push(asset("image-two"));
  const dialog = await open(page);
  await expect(dialog.getByText("รองรับรูปภาพเพียงหนึ่งไฟล์ (สื่อซ้ำต่างบทบาทนับครั้งเดียว)", { exact: true })).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  expect(state.posts).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});

test("double click sends only one POST", async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  state.post = async route => { await pending; await route.fulfill({ status: 202, json: {} }); };
  await open(page);
  await approve(page);
  // Dispatch both clicks in one task so React rendering cannot hide a missing request lock.
  await confirm(page).evaluate(button => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.getByRole("button", { name: "กำลังส่งคำสั่ง…", exact: true })).toBeDisabled();
  release();
  await expect(page.getByText(/ระบบรับคำสั่งแล้ว ไม่ใช่การยืนยันว่าโพสต์สำเร็จ/)).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

for (const failure of ["timeout", "5xx"] as const) {
  test(`${failure} retries the same submission key and project version`, async ({ page }) => {
    const state = await setup(page);
    await page.clock.install();
    state.post = async route => {
      if (state.posts.length > 1) return route.fulfill({ status: 202, json: {} });
      if (failure === "5xx") return route.fulfill({ status: 503, json: { error: "mock unavailable" } });
      // Leave the mocked request unanswered until the application's own abort timer fires.
      await new Promise<void>(resolve => route.request().response().then(() => resolve(), () => resolve()));
    };
    await open(page);
    await approve(page);
    await confirm(page).click();
    await expect.poll(() => state.posts.length).toBe(1);
    if (failure === "timeout") await page.clock.runFor(20_001);
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("ผลคำสั่งยังไม่แน่นอน");
    const retry = page.getByRole("button", { name: "ลองคำสั่งเดิมอีกครั้ง (ไม่สร้างโพสต์ใหม่)", exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.getByText(/ระบบรับคำสั่งแล้ว ไม่ใช่การยืนยันว่าโพสต์สำเร็จ/)).toBeVisible();
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1]).toEqual(state.posts[0]);
    expect(state.posts[0]).toMatchObject({ submissionKey: expect.any(String), expectedUpdatedAt: updatedAt });
    expect(state.unexpected).toEqual([]);
  });
}

test("uncertain delivery blocks a new submission", async ({ page }) => {
  const state = await setup(page);
  state.publishing.jobs = [{ id: "uncertain-job", status: "failed", execution_mode: "live", targets: [{ id: "target", platform: "facebook", status: "failed", delivery_uncertain: true }] }];
  const dialog = await open(page);
  await expect(dialog.getByText("การส่งก่อนหน้ามีผลไม่แน่นอน กรุณาตรวจสอบบนเพจ ห้ามเผยแพร่ซ้ำ", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await expect(confirm(page)).toBeDisabled();
  expect(state.posts).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});

test("only safe HTTPS Facebook links are rendered", async ({ page }) => {
  const state = await setup(page);
  const safe = ["https://facebook.com/123/posts/456", "https://www.facebook.com/123/posts/789"];
  const unsafe = ["javascript:alert(1)", "http://facebook.com/post", "https://facebook.com.evil.invalid/post", "https://evil.invalid/facebook.com", "https://user:password@facebook.com/post", "https://facebook.com:8443/post", "//facebook.com/post", "not a URL"];
  state.publishing.jobs = [{ id: "completed-job", status: "completed", execution_mode: "live", targets: [...safe, ...unsafe].map((published_url, index) => ({ id: `target-${index}`, platform: "facebook", status: "published", published_url })) }];
  const dialog = await open(page);
  const links = dialog.getByRole("link");
  await expect(links).toHaveCount(safe.length);
  for (let index = 0; index < safe.length; index++) {
    await expect(links.nth(index)).toHaveAttribute("href", safe[index]);
    await expect(links.nth(index)).toHaveAttribute("target", "_blank");
    await expect(links.nth(index)).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(state.posts).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});

test("pending jobs refresh automatically and manually without posting", async ({ page }) => {
  const state = await setup(page);
  await page.clock.install();
  state.publishing.jobs = [{ id: "pending-job", status: "pending", execution_mode: "live", targets: [{ id: "target", platform: "facebook", status: "pending" }] }];
  const dialog = await open(page);
  await expect(dialog.getByText("มีงานกำลังดำเนินการ ยังส่งซ้ำไม่ได้", { exact: true })).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  await page.clock.runFor(4_001);
  await expect.poll(() => state.gets).toBe(2);
  state.publishing.jobs[0].status = "completed";
  state.publishing.jobs[0].targets[0].status = "published";
  await dialog.getByRole("button", { name: "ตรวจสถานะ", exact: true }).click();
  await expect.poll(() => state.gets).toBe(3);
  await expect(dialog.getByText("มีงานกำลังดำเนินการ ยังส่งซ้ำไม่ได้", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toBeEnabled();
  await expect(confirm(page)).toBeDisabled();
  await page.clock.runFor(8_001);
  expect(state.gets).toBe(3);
  expect(state.posts).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
});
