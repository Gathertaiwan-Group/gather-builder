import type { z } from "zod";
import { currentMember } from "@/lib/site-request";
import { siteHref, type SectionComponent } from "../render-types";
import type { accountLinkProps } from "./manifest";

export const AccountCta: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof accountLinkProps>;
  const member = ctx.site.mode === "published" ? await currentMember(ctx.site.tenant) : null;
  return (
    <section className="gb-section">
      <div className="gb-container">
        <div className="gb-card flex flex-col items-start gap-3 p-6 md:p-8">
          <h2 className="gb-h2 m-0">{p.heading ?? "會員專區"}</h2>
          {p.intro && <p className="gb-muted m-0">{p.intro}</p>}
          <div className="flex flex-wrap gap-3">
            {member ? (
              <a className="gb-btn" href={siteHref(ctx, "/account")}>
                前往會員中心
              </a>
            ) : (
              <>
                <a className="gb-btn" href={siteHref(ctx, "/account/login")}>
                  {p.loginLabel ?? "登入"}
                </a>
                <a className="gb-btn" style={{ background: "transparent", color: "var(--gb-primary)", border: "1px solid var(--gb-primary)" }} href={siteHref(ctx, "/account/register")}>
                  {p.registerLabel ?? "註冊"}
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
