import { describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { authenticateBearer, generateToken, hashToken } from "@/lib/tokens";
import { addSection, createSite, getSite } from "@/lib/services/sites";
import { issueToken, revokeToken } from "@/lib/services/tokens";
import { disableModule, enableModule } from "@/lib/services/modules";

describe("token 雜湊與認證", () => {
  it("只存雜湊、原文可認證、錯誤 token 與撤銷 token 被拒", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    const site = await createSite(admin, { slug: "tok-a", name: "A" });
    expect(site.token).toMatch(/^gbt_/);
    const rows = await store.listTokens("all");
    expect(rows[0]!.token_hash).toBe(hashToken(site.token!));
    expect(JSON.stringify(rows)).not.toContain(site.token);

    const actor = await authenticateBearer(store, `Bearer ${site.token}`);
    expect(actor?.tenantId).toBe(site.siteId);
    expect(actor?.scopes).not.toContain("platform:sites");
    expect(await authenticateBearer(store, `Bearer ${generateToken("tenant").raw}`)).toBeNull();
    expect(await authenticateBearer(store, null)).toBeNull();
    expect(await authenticateBearer(store, "Basic abc")).toBeNull();

    await revokeToken(admin, { tokenId: rows[0]!.id });
    expect(await authenticateBearer(store, `Bearer ${site.token}`)).toBeNull();
  });

  it("scope 不足與跨租戶都被拒", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    const a = await createSite(admin, { slug: "site-a", name: "A" });
    const b = await createSite(admin, { slug: "site-b", name: "B" });

    const actorA = (await authenticateBearer(store, `Bearer ${a.token}`))!;
    const ctxA = ctxFor(store, actorA);
    expect((await getSite(ctxA)).slug).toBe("site-a");
    await expect(getSite(ctxA, "site-b")).rejects.toMatchObject({ code: "forbidden" });
    await expect(addSection(ctxA, { site: b.slug, path: "/", type: "hero", props: { heading: "x" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createSite(ctxA, { slug: "site-c", name: "C" })).rejects.toMatchObject({ code: "forbidden" });

    const ro = await issueToken(admin, { site: "site-a", name: "read only", scopes: ["site:read"] });
    const ctxRo = ctxFor(store, (await authenticateBearer(store, `Bearer ${ro.token}`))!);
    await getSite(ctxRo);
    const err = await addSection(ctxRo, { path: "/", type: "hero", props: { heading: "x" } }).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(err.message).toMatch(/content:write/);

    await expect(issueToken(admin, { site: "site-a", name: "bad", scopes: ["platform:sites"] })).rejects.toMatchObject({ code: "invalid" });
  });

  it("模組：開啟自動帶依賴、停用被依賴者被拒", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    const s = await createSite(admin, { slug: "mods", name: "M", modules: [] });
    const r = await enableModule(admin, { site: s.slug, moduleId: "portfolio" });
    expect(r.changed.map((c) => c.id)).toEqual(["sections-basic", "portfolio"]);
    await expect(disableModule(admin, { site: s.slug, moduleId: "sections-basic" })).rejects.toThrow(/portfolio/);
    await expect(disableModule(admin, { site: s.slug, moduleId: "core" })).rejects.toThrow(/必備/);
    const line = await enableModule(admin, { site: s.slug, moduleId: "line" });
    expect(line.changed[0]!.status).toBe("pending_setup");
  });
});
