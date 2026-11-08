export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function assertOrigin(request: Request, configuredOrigin: string) {
  if (!configuredOrigin || request.headers.get("origin") !== new URL(configuredOrigin).origin) {
    throw new HttpError(403, "Origin ไม่ได้รับอนุญาต ตรวจ APP_ORIGIN");
  }
}
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "API รับเฉพาะ JSON ไม่รับไฟล์สื่อ");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "ไม่มีข้อมูลคำขอ");
  const decoder = new TextDecoder();
  let text = ""; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new HttpError(413, "JSON ต้องไม่เกิน 64 KiB; อัปโหลดไฟล์ตรงสู่ storage"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new HttpError(400, "JSON ไม่ถูกต้อง"); }
  } finally { reader.releaseLock(); }
}
