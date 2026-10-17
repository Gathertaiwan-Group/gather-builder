import { getStore } from "@/lib/store";
import { handleAdminLogin } from "@/lib/adminLogin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleAdminLogin(req, getStore());
}
