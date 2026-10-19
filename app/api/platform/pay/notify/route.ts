import { handlePlatformNotifyRoute } from "@/lib/platform/routes";

// 平台 PChomePay notify（公開、無簽章）：只取 order_id，一律權威回查（lib/services/platform-billing.ts）
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = (req: Request) => handlePlatformNotifyRoute(req);
