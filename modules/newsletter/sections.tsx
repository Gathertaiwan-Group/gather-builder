import type { z } from "zod";
import type { SectionComponent } from "../render-types";
import type { newsletterSignupProps } from "./manifest";
import { NewsletterSignupClient } from "./NewsletterSignupClient";

export const NewsletterSignup: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof newsletterSignupProps>;
  return (
    <section className="gb-section" id="newsletter">
      <div className="gb-container max-w-2xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {p.description && <p className="gb-muted mb-4 mt-0">{p.description}</p>}
        {ctx.site.mode === "preview" ? (
          <p className="gb-card gb-muted p-4 text-sm">（預覽模式：訂閱表單在正式網站才能送出）</p>
        ) : (
          <NewsletterSignupClient endpoint={`/api/s/${ctx.site.tenant.slug}/newsletter`} buttonLabel={p.buttonLabel ?? "訂閱"} />
        )}
      </div>
    </section>
  );
};
