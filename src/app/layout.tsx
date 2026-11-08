import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Autopost — พื้นที่จัดการคอนเทนต์ส่วนตัว",
  description: "อัปโหลดและจัดเก็บโปรเจกต์ส่วนตัวบน cloud storage",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body>{children}</body></html>;
}
