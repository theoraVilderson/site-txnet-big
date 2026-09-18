"use client";

import { useBrand } from "@/context/BrandContext";

/**
 * The domain's logo and name (F-066-v): the logo when the tenant uploaded one,
 * else its initial on the accent colour. The name is text React escapes — a
 * brand name is data (tenant `contract.branding.md` rule 3).
 */
export function BrandMark({ nameClassName }: { nameClassName: string }) {
  const { name, logoUrl } = useBrand();
  return (
    <>
      {logoUrl ? (
        // A plain <img>: the file is served on the tenant's own domain, which
        // next/image would need listed per reseller in `remotePatterns`.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl object-contain" />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-xl font-bold text-white shadow-lg shadow-primary-glow">
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <span className={nameClassName}>{name}</span>
    </>
  );
}
