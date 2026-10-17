#!/usr/bin/env node
// 端到端：用 MCP client 一句一句從零開站 → 改內容 → 預覽 → 發布 → 改版 → 還原。
// 用法：node --env-file=.env.local scripts/e2e-mcp.mjs [baseUrl] [--quick] [--keep]
//   需要 GB_PLATFORM_TOKEN（平台 token）。--quick：正式站精簡版（create→add→publish→GET）。
import { connect, check, done, getText } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3100";
const quick = args.includes("--quick");
const platformToken = process.env.GB_PLATFORM_TOKEN;
if (!platformToken) {
  console.error("缺少 GB_PLATFORM_TOKEN");
  process.exit(1);
}

const ts = Date.now().toString(36);
const slug = `e2e-${ts}`;
const H1 = `E2E 第一版標題 ${ts}`;
const H2 = `E2E 第二版標題 ${ts}`;
const POST_TITLE = `E2E 測試文章 ${ts}`;
console.log(`base=${base} slug=${slug}${quick ? " (quick)" : ""}\n`);

const platform = await connect(base, platformToken);
const mods = await platform.call("list_modules");
check(Array.isArray(mods) && mods.some((m) => m.id === "blog" && typeof m.priceMonthly === "number"), "list_modules 回傳含價格的模組目錄", `${mods.length} 個模組`);

const created = await platform.call("create_site", { slug, name: `E2E 測試站 ${ts}`, modules: ["sections-basic"], test: true });
check(created.slug === slug && created.token?.startsWith("gbt_"), "create_site 回傳 slug 與租戶 token", created.__error ?? `previewUrl=${created.previewUrl?.split("?")[0]}?preview=…`);
await platform.close();

const site = await connect(base, created.token);

if (!quick) {
  const b = await site.call("enable_module", { moduleId: "blog" });
  check(b.changed?.some((c) => c.id === "blog" && c.status === "enabled"), "enable_module blog", b.__error ?? "");
  const c = await site.call("enable_module", { moduleId: "contact-form" });
  check(c.changed?.some((x) => x.id === "contact-form"), "enable_module contact-form", c.__error ?? "");

  const types = await site.call("list_section_types");
  const names = Array.isArray(types) ? types.map((t) => t.type) : [];
  check(["hero", "contact_form", "posts_list"].every((t) => names.includes(t)) && types[0]?.propsJsonSchema?.type === "object", "list_section_types 含已啟用模組的區塊與 JSON Schema", names.join(","));
}

const hero = await site.call("add_section", { path: "/", type: "hero", position: 0, props: { heading: H1, subheading: "由 MCP 建立", ctaLabel: "聯絡我們", ctaHref: "#contact" } });
check(hero.sectionId?.startsWith("s_"), "add_section hero", hero.__error ?? hero.sectionId);

if (!quick) {
  const bad = await site.call("add_section", { path: "/", type: "hero", props: { subheading: "沒有 heading" } });
  check(!!bad.__error && /heading/.test(bad.__error), "add_section 缺必填欄位被拒且說明欄位", bad.__error);
  const cf = await site.call("add_section", { path: "/", type: "contact_form", props: { heading: "聯絡我們" } });
  check(cf.sectionId?.startsWith("s_"), "add_section contact_form", cf.__error ?? cf.sectionId);
  const pl = await site.call("add_section", { path: "/", type: "posts_list", position: 1, props: { heading: "最新消息", limit: 3 } });
  check(pl.sectionId?.startsWith("s_"), "add_section posts_list", pl.__error ?? "");

  const th = await site.call("update_theme", { preset: "minimal-modern", overrides: { primary: "#0f766e" } });
  check(th.theme?.preset === "minimal-modern" && th.theme?.overrides?.primary === "#0f766e", "update_theme", th.__error ?? "");

  const noConf = await site.call("create_post", { slug: `nc-${ts}`, title: "未確認", status: "published" });
  check(noConf.__error?.startsWith("[confirm_required]"), "create_post published 不帶 confirm 被拒", noConf.__error?.slice(0, 40));
  const post = await site.call("create_post", { slug: `hello-${ts}`, title: POST_TITLE, excerpt: "第一篇", bodyMd: "# 你好\n\n這是 **MCP** 建立的文章。", status: "published", confirm: true });
  check(post.status === "published", "create_post（published）", post.__error ?? post.slug);
}

const pv = await site.call("preview_changes");
check(Array.isArray(pv.changes) && pv.previewUrl?.includes("?preview="), "preview_changes 回傳差異摘要與預覽網址", `${pv.changes?.length} 項變更、驗證問題 ${pv.validationErrors?.length}`);
if (!quick) {
  const pre = await getText(pv.previewUrl);
  check(pre.status === 200 && pre.body.includes(H1) && pre.body.includes("預覽模式"), "預覽網址看得到草稿", `HTTP ${pre.status}`);
  const before = await getText(`${base}/s/${slug}`);
  check(before.status === 404, "發布前前台 404", `HTTP ${before.status}`);
}

const noConfirm = await site.call("publish_site", {});
check(!!noConfirm.__error && noConfirm.__error.startsWith("[confirm_required]"), "publish_site 不帶 confirm 被拒", noConfirm.__error?.slice(0, 60));
if (!quick) {
  const stale = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion - 1 });
  check(stale.__error?.startsWith("[conflict]"), "publish_site 帶過期的 expectedDraftVersion 被拒", stale.__error?.slice(0, 50));
}
const pub1 = await site.call("publish_site", { confirm: true, note: "e2e 第一版", expectedDraftVersion: pv.draftVersion });
check(pub1.revision === 1, "publish_site confirm:true → 第 1 版", pub1.__error ?? `revision=${pub1.revision}`);

const live1 = await getText(`${base}/s/${slug}`);
check(live1.status === 200 && live1.body.includes(H1), "前台 /s/<slug> 看到 hero 標題", `HTTP ${live1.status}`);
if (!quick) {
  check(live1.body.includes(POST_TITLE), "前台首頁看到文章（posts_list）");
  const art = await getText(`${base}/s/${slug}/blog/hello-${ts}`);
  check(art.status === 200 && art.body.includes(POST_TITLE), "文章頁 /blog/<slug>", `HTTP ${art.status}`);

  const page = await site.call("get_page", { path: "/" });
  const heroId = page.sections?.find((s) => s.type === "hero" && s.props.heading === H1)?.id;
  const up = await site.call("update_section", { path: "/", sectionId: heroId, props: { heading: H2 } });
  check(up.updatedKeys?.includes("heading"), "update_section 改標題（草稿）", up.__error ?? "");
  const stillOld = await getText(`${base}/s/${slug}`);
  check(stillOld.body.includes(H1) && !stillOld.body.includes(H2), "未發布前前台仍是舊標題");
  const pub2 = await site.call("publish_site", { confirm: true, note: "e2e 第二版" });
  check(pub2.revision === 2, "publish_site → 第 2 版", pub2.__error ?? `revision=${pub2.revision}`);
  const live2 = await getText(`${base}/s/${slug}`);
  check(live2.body.includes(H2) && !live2.body.includes(H1), "前台立即看到第二版標題（無快取卡住）");

  const revs = await site.call("list_revisions");
  check(revs.length === 2 && revs[0].isCurrent && revs[0].number === 2, "list_revisions", revs.map((r) => `${r.number}${r.isCurrent ? "*" : ""}`).join(","));
  const rbNo = await site.call("rollback", { number: 1 });
  check(rbNo.__error?.startsWith("[confirm_required]"), "rollback 不帶 confirm 被拒");
  const rb = await site.call("rollback", { number: 1, confirm: true });
  check(rb.publishedRevision === 1, "rollback 到第 1 版", rb.__error ?? "");
  const live3 = await getText(`${base}/s/${slug}`);
  check(live3.body.includes(H1) && !live3.body.includes(H2), "前台標題回到第一版");
  const draftAfter = await site.call("get_page", { path: "/" });
  check(draftAfter.sections?.some((s) => s.props.heading === H1), "還原後草稿同步為第 1 版");
  const revs2 = await site.call("list_revisions");
  check(revs2.find((r) => r.number === 1)?.isCurrent === true, "第 1 版標示為上線中");
}

await site.close();
console.log(`\nslug=${slug}`);
done();
