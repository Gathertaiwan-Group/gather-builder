import type { z } from "zod";
import type { SectionComponent } from "../render-types";
import type { certificateLookupProps } from "./manifest";
import { CertLookup } from "./CertLookup";

export const CertificateLookup: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof certificateLookupProps>;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-2xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {p.intro && <p className="gb-muted">{p.intro}</p>}
        <CertLookup endpoint={`/api/s/${ctx.site.tenant.slug}/verify`} />
      </div>
    </section>
  );
};
