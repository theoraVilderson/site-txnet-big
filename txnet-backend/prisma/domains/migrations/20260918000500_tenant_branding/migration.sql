-- F-018-h: a reseller's branding holds object-storage keys, never URLs (D-42 (3),
-- catalog 13.8). Nothing wrote this table before, so the renames move no data.

ALTER TABLE "tenant"."tenant_branding" RENAME COLUMN "logoUrl" TO "logoLightKey";
ALTER TABLE "tenant"."tenant_branding" RENAME COLUMN "faviconUrl" TO "faviconKey";
ALTER TABLE "tenant"."tenant_branding"
    ADD COLUMN "logoDarkKey" TEXT,
    ADD COLUMN "ogImageKey" TEXT,
    ADD COLUMN "supportUrl" TEXT,
    ADD COLUMN "socials" JSONB NOT NULL DEFAULT '{}';

-- Each image is its own tenant's file at its own slot: a row cannot point at
-- another reseller's logo, whatever the code above it does.
ALTER TABLE "tenant"."tenant_branding"
    ADD CONSTRAINT "tenant_branding_logo_light_key" CHECK ("logoLightKey" IS NULL OR "logoLightKey" = 'tenants/' || "tenantId" || '/branding/logo-light'),
    ADD CONSTRAINT "tenant_branding_logo_dark_key" CHECK ("logoDarkKey" IS NULL OR "logoDarkKey" = 'tenants/' || "tenantId" || '/branding/logo-dark'),
    ADD CONSTRAINT "tenant_branding_favicon_key" CHECK ("faviconKey" IS NULL OR "faviconKey" = 'tenants/' || "tenantId" || '/branding/favicon'),
    ADD CONSTRAINT "tenant_branding_og_image_key" CHECK ("ogImageKey" IS NULL OR "ogImageKey" = 'tenants/' || "tenantId" || '/branding/og-image'),
    -- Rendered into a style attribute: six hex digits and nothing a CSS parser could read as more.
    ADD CONSTRAINT "tenant_branding_primary_color" CHECK ("primaryColorHex" IS NULL OR "primaryColorHex" ~ '^#[0-9a-f]{6}$'),
    ADD CONSTRAINT "tenant_branding_secondary_color" CHECK ("secondaryColorHex" IS NULL OR "secondaryColorHex" ~ '^#[0-9a-f]{6}$'),
    ADD CONSTRAINT "tenant_branding_brand_name" CHECK (char_length("brandName") BETWEEN 1 AND 64),
    ADD CONSTRAINT "tenant_branding_socials_object" CHECK (jsonb_typeof("socials") = 'object');
