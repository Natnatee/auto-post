import { z } from "zod";
import { publishProjectSchema } from "./validation";
import { HttpError } from "./http";

type Rpc = (args: { p_project_id: string; p_submission_key: string; p_scheduled_at: string | null; p_execution_mode: string; p_expected_updated_at?: string; p_platforms?: string[] }) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
export async function submitProject(projectId: string, body: unknown, liveEnabled: boolean, rpc: Rpc) {
  z.uuid().parse(projectId);
  const input = publishProjectSchema.parse(body);
  if (input.mode === "live" && (!liveEnabled || !input.confirmLive)) {
    throw new HttpError(403, "ยังไม่เปิดโพสต์จริง หรือต้องยืนยันเนื้อหาและเพจปลายทางก่อน");
  }
  if (input.mode === "live" && !input.expectedUpdatedAt) throw new HttpError(409, "กรุณาโหลดโปรเจกต์ล่าสุดและตรวจตัวอย่างก่อนโพสต์จริง");
  const result = await rpc({
    p_project_id: projectId,
    p_submission_key: input.submissionKey,
    p_scheduled_at: input.scheduledAt,
    p_execution_mode: input.mode,
    p_platforms: input.platforms,
    ...(input.expectedUpdatedAt ? { p_expected_updated_at: input.expectedUpdatedAt } : {})
  });
  if (result.error) {
    const message = result.error.message;
    if (/Project changed|Publication already active|Delivery reconciliation required/.test(message)) throw new HttpError(409, "โปรเจกต์เปลี่ยนหรือมีงานที่ต้องตรวจสอบ กรุณาโหลดข้อมูลและสถานะล่าสุดก่อน");
    if (message.includes("Submission key conflict")) throw new HttpError(409, "รหัสคำสั่งนี้ถูกใช้กับงานอื่นแล้ว");
    if (/access denied|ready and owned/i.test(message)) throw new HttpError(403, "ไม่มีสิทธิ์ใช้โปรเจกต์หรือสื่อนี้");
    if (message.includes("destination not enabled")) throw new HttpError(503, "workspace ยังไม่ได้เชื่อมเพจ Facebook");
    if (message.includes("live publishing not enabled")) throw new HttpError(403, "workspace ยังไม่อนุญาตโพสต์จริง");
    throw new HttpError(502, "สร้างคำสั่งเผยแพร่ไม่สำเร็จ");
  }
  const id = z.uuid().parse(result.data);
  return { id, mode: input.mode, published: false };
}
