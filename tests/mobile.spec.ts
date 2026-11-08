import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const mediaId = "550e8400-e29b-41d4-a716-446655440000";
const image = { id: mediaId, filename: "cover.png", mime_type: "image/png", size_bytes: 10, status: "ready" };
type Asset = { media_id: string; role: string; position: number; media?: typeof image };
type Project = { id: string; workspace_id: string; title: string; description: string; hashtags: string[]; price: number | null; assets: Asset[]; updated_at: string };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function mockApi(page: Page) {
  const state = {
    authenticated: true, owner: true, projects: [] as Project[], writes: [] as Record<string, any>[],
    tickets: 0, storageWrites: 0, completions: {} as Record<string, number>,
    failCompletion: false, failProject: false, logins: [] as unknown[], logouts: 0,
    dashboardGate: undefined as ReturnType<typeof deferred> | undefined,
    saveGate: undefined as ReturnType<typeof deferred> | undefined,
    previewGate: undefined as ReturnType<typeof deferred> | undefined,
    unexpected: [] as string[],
  };
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.origin === "https://storage.example.invalid") {
      state.storageWrites++;
      await route.fulfill({ json: { Key: "social-media/test.png", Id: mediaId } }); return;
    }
    if (url.origin === "https://preview.example.invalid" && path === "/cover.png") {
      await route.fulfill({ contentType: "text/plain", body: "mock preview" }); return;
    }
    if (url.origin === "http://127.0.0.1:3108" && !path.startsWith("/api/")) { await route.continue(); return; }
    if (path === "/api/dashboard") {
      await state.dashboardGate?.promise;
      await route.fulfill({ json: { configured: true, authenticated: state.authenticated, owner: state.owner, media: [image] } }); return;
    }
    if (path === "/api/projects") {
      if (request.method() === "GET") { await route.fulfill({ json: { projects: state.projects } }); return; }
      const data = request.postDataJSON(); state.writes.push(data);
      await state.saveGate?.promise;
      if (state.failProject) { state.failProject = false; await route.fulfill({ status: 500, json: { error: "mock project failure" } }); return; }
      const project = { ...data, id: data.projectId || "project-test", workspace_id: mediaId, updated_at: "2026-11-05", assets: data.assets.map((asset: Asset) => ({ ...asset, media: { ...image, id: asset.media_id } })) };
      state.projects = [...state.projects.filter(item => item.id !== project.id), project];
      await route.fulfill({ json: { id: project.id } }); return;
    }
    if (path === "/api/uploads") {
      const id = `650e8400-e29b-41d4-a716-${String(state.tickets++).padStart(12, "0")}`;
      await route.fulfill({ json: { mediaId: id, bucket: "social-media", path: `${id}.png`, token: "mock-signature", uploadAccessToken: "mock-access-token", supabaseUrl: "https://storage.example.invalid", publishableKey: "mock-public-key" } }); return;
    }
    if (/^\/api\/uploads\/[^/]+\/complete$/.test(path)) {
      const id = path.split("/").at(-2)!;
      state.completions[id] = (state.completions[id] || 0) + 1;
      if (state.failCompletion && state.tickets === 2) { state.failCompletion = false; await route.fulfill({ status: 500, json: { error: "mock completion failure" } }); return; }
      await route.fulfill({ json: { ok: true } }); return;
    }
    if (path === `/api/media/${mediaId}/url`) {
      await state.previewGate?.promise;
      await route.fulfill({ json: { url: "https://preview.example.invalid/cover.png", expiresIn: 60 } }); return;
    }
    if (path === "/api/auth/login") {
      state.logins.push(request.postDataJSON()); state.authenticated = true; state.owner = true;
      await route.fulfill({ json: { ok: true } }); return;
    }
    if (path === "/api/auth/logout") {
      state.logouts++; state.authenticated = false; state.owner = false;
      await route.fulfill({ json: { ok: true } }); return;
    }
    state.unexpected.push(`${request.method()} ${request.url()}`);
    await route.abort();
  });
  return state;
}
const save = (page: Page) => page.getByRole("button", { name: "บันทึก", exact: true });
const error = (page: Page) => page.locator(".error[role=alert]");
const file = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from(name) });
async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.getByRole("status", { name: "กำลังโหลดโปรเจกต์" })).toHaveCount(0);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}


for (const viewport of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 1280, height: 720 }]) {
  test(`light upload and projects fit ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const state = await mockApi(page);
    state.projects = [{ id: "layout", workspace_id: mediaId, title: "โปรเจกต์".repeat(30), description: "รายละเอียด".repeat(80), hashtags: ["แท็ก".repeat(30)], price: 0, assets: [], updated_at: "2026-11-05" }];
    await page.setViewportSize(viewport); await page.emulateMedia({ colorScheme: "dark" });
    await ready(page);
    await expect(page.getByRole("heading", { name: "อัปโหลด", exact: true })).toBeVisible();
    await expect(page.getByLabel("ชื่อโปรเจกต์", { exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "เมนู" });
    await expect(nav.getByRole("link")).toHaveCount(2);
    await expect(nav.getByRole("link", { name: "อัปโหลด", exact: true })).toHaveAttribute("href", "/");
    await expect(nav.getByRole("link", { name: "โปรเจกต์", exact: true })).toHaveAttribute("href", "/library");
    await expect(nav.getByRole("link", { name: "อัปโหลด", exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => ({ scheme: getComputedStyle(document.documentElement).colorScheme, background: getComputedStyle(document.body).backgroundColor }))).toEqual({ scheme: "light", background: "rgb(255, 255, 255)" });
    await noOverflow(page);
    await save(page).scrollIntoViewIfNeeded(); await expect(save(page)).toBeVisible(); await noOverflow(page);
    await nav.getByRole("link", { name: "โปรเจกต์", exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(state.projects[0].title);
    await expect(page.locator("form.library-form")).toHaveCount(0);
    await expect(nav.getByRole("link")).toHaveCount(2); await noOverflow(page);
    expect(state.unexpected).toEqual([]);
  });
}

for (const path of ["/media", "/queue", "/settings"]) {
  test(`${path} is removed (404)`, async ({ page }) => {
    const state = await mockApi(page);
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
  });
}

test("stages locally and retries completion and project failures without reuploading", async ({ page }) => {
  const state = await mockApi(page); state.failCompletion = true; state.failProject = true;
  await ready(page);
  await page.getByLabel("อัปโหลดปก", { exact: true }).setInputFiles(file("cover.png"));
  await page.getByLabel("อัปโหลดรูปภาพ", { exact: true }).setInputFiles(file("gallery.png"));
  await expect(page.getByText("gallery.png · รูปภาพ · รอบันทึก", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "นำgallery.pngออก", exact: true }).click();
  await page.getByLabel("อัปโหลดรูปภาพ", { exact: true }).setInputFiles(file("gallery.png"));
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([0, 0, 0]);
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("บันทึกพร้อมกัน");
  await save(page).click(); await expect(error(page)).toHaveText("อัปโหลดไม่สำเร็จ กรุณาลองอีกครั้ง");
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([2, 2, 0]);
  await save(page).click(); await expect(error(page)).toHaveText("บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง");
  expect(Object.values(state.completions)).toEqual([1, 2]);
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([2, 2, 1]);
  await save(page).click(); await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { name: "บันทึกพร้อมกัน", exact: true })).toBeVisible();
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([2, 2, 2]);
  expect(state.writes[1].assets).toEqual([expect.objectContaining({ role: "cover", position: 0 }), expect.objectContaining({ role: "gallery", position: 0 })]);
  expect(state.unexpected).toEqual([]);
});

test("same physical file shares one upload across cover/gallery and role removal is isolated", async ({ page }, info) => {
  const state = await mockApi(page); state.failProject = true;
  const path = info.outputPath("shared.png"); await writeFile(path, Buffer.from("shared-image"));
  await ready(page);
  const cover = page.locator("fieldset.library-attach").filter({ has: page.getByLabel("อัปโหลดปก", { exact: true }) });
  const gallery = page.locator("fieldset.library-attach").filter({ has: page.getByLabel("อัปโหลดรูปภาพ", { exact: true }) });
  await page.getByLabel("อัปโหลดปก", { exact: true }).setInputFiles(path);
  await page.getByLabel("อัปโหลดรูปภาพ", { exact: true }).setInputFiles(path);
  await page.getByLabel("อัปโหลดรูปภาพ", { exact: true }).setInputFiles(path);
  await expect(error(page)).toHaveText("มีไฟล์ซ้ำ");
  await expect(gallery.getByRole("button", { name: "นำshared.pngออก", exact: true })).toHaveCount(1);
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([0, 0, 0]);
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("ใช้ไฟล์ร่วมกัน");
  await save(page).click(); await expect(error(page)).toHaveText("บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง");
  const id = state.writes[0].assets[0].media_id;
  const expected = [{ media_id: id, role: "cover", position: 0 }, { media_id: id, role: "gallery", position: 0 }];
  expect(state.writes[0].assets).toEqual(expected);
  expect([state.tickets, state.storageWrites, Object.values(state.completions), state.writes.length]).toEqual([1, 1, [1], 1]);
  await page.getByLabel("อัปโหลดรูปภาพ", { exact: true }).setInputFiles(path);
  await expect(error(page)).toHaveText("มีไฟล์ซ้ำ");
  await cover.getByRole("button", { name: "นำshared.pngออก", exact: true }).click();
  await expect(cover.getByRole("button", { name: "นำshared.pngออก", exact: true })).toHaveCount(0);
  await expect(gallery.getByRole("button", { name: "นำshared.pngออก", exact: true })).toBeVisible();
  await expect(page.getByLabel("เลือกรูปภาพที่มีอยู่", { exact: true }).locator(`option[value="${id}"]`)).toHaveCount(0);
  await page.getByLabel("เลือกปกที่มีอยู่", { exact: true }).selectOption(id);
  await save(page).click(); await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { name: "ใช้ไฟล์ร่วมกัน", exact: true })).toBeVisible();
  expect(state.writes[1].assets).toEqual(expect.arrayContaining(expected));
  expect(state.writes[1].assets).toHaveLength(2);
  expect([state.tickets, state.storageWrites, Object.values(state.completions), state.writes.length]).toEqual([1, 1, [1], 2]);
  expect(state.unexpected).toEqual([]);
});

for (const price of ["0", "1234.50", ""]) {
  test(`tag chips and price ${price || "null"} restore through list Edit link`, async ({ page }) => {
    const state = await mockApi(page);
    await page.addInitScript(() => localStorage.setItem("autopost.default-tags", JSON.stringify(["สร้างสรรค์", "ขายของ"])));
    await ready(page);
    await expect(page.getByRole("button", { name: "ลบแท็ก สร้างสรรค์", exact: true })).toBeVisible();
    await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("สินค้าทดสอบ");
    await page.getByLabel("คำอธิบาย", { exact: true }).fill("รายละเอียดสินค้า");
    const tags = page.getByLabel("แท็ก", { exact: true });
    await tags.fill("สินค้าไทย"); await page.getByRole("button", { name: "เพิ่มแท็ก", exact: true }).click();
    await tags.fill("##สินค้าไทย #ใหม่,ใหม่"); await tags.press("Enter");
    await expect(tags).toHaveValue("");
    await expect(page.getByRole("button", { name: "ลบแท็ก สินค้าไทย", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "ลบแท็ก ใหม่", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "ลบแท็ก ขายของ", exact: true }).click();
    expect(state.writes).toHaveLength(0);
    await tags.fill("#รอบันทึก"); await page.getByLabel("ราคา (บาท)", { exact: true }).fill(price);
    await save(page).click(); await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole("heading", { name: "สินค้าทดสอบ", exact: true })).toBeVisible();
    expect(state.writes).toEqual([expect.objectContaining({ hashtags: ["สร้างสรรค์", "สินค้าไทย", "ใหม่", "รอบันทึก"], price: price === "" ? null : Number(price), description: "รายละเอียดสินค้า", assets: [] })]);
    if (price !== "") await expect(page.getByText(new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB" }).format(Number(price)), { exact: true })).toBeVisible();
    const edit = page.getByRole("link", { name: "แก้ไข", exact: true });
    await expect(edit).toHaveAttribute("href", "/?edit=project-test"); await edit.click();
    await expect(page).toHaveURL(/\/\?edit=project-test$/);
    await expect(page.getByLabel("ชื่อโปรเจกต์", { exact: true })).toHaveValue("สินค้าทดสอบ");
    await expect(page.getByRole("textbox", { name: "คำอธิบาย", exact: true })).toHaveValue("รายละเอียดสินค้า");
    await expect(page.getByLabel("ราคา (บาท)", { exact: true })).toHaveValue(price === "" ? "" : String(Number(price)));
    for (const tag of state.writes[0].hashtags) await expect(page.getByRole("button", { name: `ลบแท็ก ${tag}`, exact: true })).toBeVisible();
    await expect(tags).toHaveValue("");
    await page.getByRole("button", { name: "เริ่มใหม่", exact: true }).click();
    await expect(page.getByLabel("ราคา (บาท)", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "ลบแท็ก ขายของ", exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
  });
}

test("default tag is สร้างสรรค์ without stored preferences", async ({ page }) => {
  const state = await mockApi(page); await ready(page);
  await expect(page.getByRole("button", { name: "ลบแท็ก สร้างสรรค์", exact: true })).toBeVisible();
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("ค่าเริ่มต้น");
  await save(page).click(); await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByText("#สร้างสรรค์", { exact: true })).toBeVisible();
  expect(state.writes[0].hashtags).toEqual(["สร้างสรรค์"]);
  expect(state.unexpected).toEqual([]);
});

test("validates title, pending tags and price before any uploads or project writes", async ({ page }) => {
  const state = await mockApi(page); await ready(page);
  await page.getByLabel("อัปโหลดปก", { exact: true }).setInputFiles(file("cover.png"));
  await save(page).click(); await expect(error(page)).toHaveText("กรอกชื่อโปรเจกต์ไม่เกิน 500 ตัวอักษร");
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("ตรวจข้อมูล");
  for (const tags of ["ก".repeat(101), Array.from({ length: 31 }, (_, i) => `แท็ก${i}`).join(" ")]) {
    await page.getByLabel("แท็ก", { exact: true }).fill(tags); await save(page).click();
    await expect(error(page)).toHaveText("แท็กไม่เกิน 30 แท็ก แท็กละไม่เกิน 100 ตัวอักษร");
  }
  await page.getByLabel("แท็ก", { exact: true }).fill("");
  for (const price of ["-1", "1.001", "10000000000", "1e100"]) {
    await page.getByLabel("ราคา (บาท)", { exact: true }).fill(price); await save(page).click();
    await expect(error(page)).toHaveText("กรอกราคา 0–9,999,999,999.99 บาท ทศนิยมไม่เกิน 2 ตำแหน่ง");
  }
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([0, 0, 0]);
  expect(state.unexpected).toEqual([]);
});

test("deferred dashboard, save and signed preview expose named status spinners", async ({ page }) => {
  const state = await mockApi(page); state.dashboardGate = deferred();
  await page.goto("/");
  await expect(page.getByRole("status", { name: "กำลังโหลดโปรเจกต์", exact: true })).toBeVisible();
  state.dashboardGate.resolve();
  await expect(save(page)).toBeEnabled();
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("ทดสอบสถานะ");
  await page.getByLabel("เลือกปกที่มีอยู่", { exact: true }).selectOption(mediaId);
  state.saveGate = deferred(); await save(page).click();
  await expect(page.getByRole("status", { name: "กำลังบันทึก", exact: true })).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  state.saveGate.resolve(); await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { name: "ทดสอบสถานะ", exact: true })).toBeVisible();
  state.previewGate = deferred();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "ปก: cover.png ↗", exact: true }).click();
  const popup = await popupPromise;
  await expect(page.getByRole("status", { name: "กำลังเปิดไฟล์", exact: true })).toBeVisible();
  state.previewGate.resolve();
  await expect(popup).toHaveURL("https://preview.example.invalid/cover.png");
  await expect(page.getByRole("status", { name: "กำลังเปิดไฟล์", exact: true })).toHaveCount(0);
  await popup.close(); expect(state.unexpected).toEqual([]);
});

test("mock owner login reloads dashboard, logout clears editor and no signup is offered", async ({ page }) => {
  const state = await mockApi(page); state.authenticated = false; state.owner = false;
  await ready(page);
  await expect(page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true })).toBeVisible();
  await expect(page.getByText(/สมัคร|sign\s*up/i)).toHaveCount(0);
  await page.getByLabel("อีเมล", { exact: true }).fill("owner@example.invalid");
  await page.getByLabel("รหัสผ่าน", { exact: true }).fill("mock-password");
  await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(state.logins).toEqual([{ email: "owner@example.invalid", password: "mock-password" }]);
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill("ต้องล้าง");
  await page.getByLabel("คำอธิบาย", { exact: true }).fill("ข้อมูลค้าง");
  await page.getByLabel("ราคา (บาท)", { exact: true }).fill("99");
  await page.getByLabel("แท็ก", { exact: true }).fill("ค้าง");
  await page.getByLabel("อัปโหลดปก", { exact: true }).setInputFiles(file("private.png"));
  await page.getByRole("button", { name: "ออกจากระบบ", exact: true }).click();
  await expect(page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true })).toBeVisible();
  await expect(page.getByLabel("รหัสผ่าน", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("ชื่อโปรเจกต์", { exact: true })).toHaveCount(0);
  expect(state.logouts).toBe(1);
  await page.getByLabel("รหัสผ่าน", { exact: true }).fill("mock-password");
  await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
  await expect(page.getByLabel("ชื่อโปรเจกต์", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("คำอธิบาย", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("ราคา (บาท)", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("แท็ก", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "นำprivate.pngออก", exact: true })).toHaveCount(0);
  expect([state.tickets, state.storageWrites, state.writes.length]).toEqual([0, 0, 0]);
  expect(state.unexpected).toEqual([]);
});
