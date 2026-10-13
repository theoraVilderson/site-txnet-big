"use client";

import type { CatalogCategory } from "@/lib/catalog-api";
import type { CatalogData } from "../_hooks/useCatalogData";
import { CapabilitySheet } from "./CapabilityPicker";
import { MoveCategorySheet } from "./CategoryPickers";
import { CategorySheet, NamesSheet } from "./NameSheets";
import { ProductDetailSheet } from "./ProductDetailSheet";
import { ProductWizard } from "./ProductWizard";

type Renaming = { kind: "product" | "category" | "capability"; id: string; nameKey: string; descriptionKey: string | null; sourceLang: string };

/** The one sheet the catalog page has open: they are modal, so at most one at a time. */
export type CatalogSheet =
  | { kind: "create"; what: "product" | "category" | "capability" }
  | { kind: "rename"; item: Renaming }
  | { kind: "move"; category: CatalogCategory }
  | { kind: "open"; productId: string };

interface Props {
  sheet: CatalogSheet | null;
  data: CatalogData;
  nameOf: (item: { key: string; nameKey: string; sourceLang: string }) => string;
  /** Re-read the lists only: a capability made inside a sheet that stays open. */
  reload: () => Promise<void>;
  onClose: () => void;
  /** A create, rename or move saved: the sheet closes and the page says so. */
  onSaved: () => Promise<void>;
  /** The open product changed: the page re-reads and the sheet stays. */
  onChanged: () => Promise<void>;
  onProductCreated: (productId: string, variantFailed: boolean) => Promise<void>;
}

/** The catalog page's sheets (F-026-f): the wizard and the create sheets, a product's detail, rename and move. */
export function CatalogSheets({ sheet, data, nameOf, reload, onClose, onSaved, onChanged, onProductCreated }: Props) {
  const { categories, capabilities } = data;
  if (!sheet) return null;
  switch (sheet.kind) {
    case "create":
      if (sheet.what === "category") {
        return <CategorySheet takenKeys={categories.map((c) => c.key)} categories={categories} label={nameOf} onClose={onClose} onSaved={onSaved} />;
      }
      if (sheet.what === "capability") {
        return <CapabilitySheet takenKeys={capabilities.map((c) => c.key)} onClose={onClose} onSaved={onSaved} />;
      }
      return (
        <ProductWizard
          categories={categories}
          categoryLabel={nameOf}
          takenProductKeys={[...data.products, ...data.archived].map((p) => p.key)}
          takenCategoryKeys={categories.map((c) => c.key)}
          capabilities={capabilities}
          capabilityLabel={nameOf}
          onCapabilityCreated={reload}
          onClose={onClose}
          onCreated={onProductCreated}
        />
      );
    case "open": {
      const product = data.products.find((p) => p.id === sheet.productId);
      if (!product) return null;
      return (
        <ProductDetailSheet
          product={product}
          name={nameOf(product)}
          capabilities={capabilities}
          capabilityLabel={nameOf}
          onCapabilityCreated={reload}
          categories={categories}
          categoryLabel={nameOf}
          onClose={onClose}
          onChanged={onChanged}
        />
      );
    }
    case "move":
      return <MoveCategorySheet category={sheet.category} categories={categories} label={nameOf} onClose={onClose} onSaved={onSaved} />;
    case "rename":
      return (
        <NamesSheet
          kind={sheet.item.kind}
          id={sheet.item.id}
          nameKey={sheet.item.nameKey}
          descriptionKey={sheet.item.descriptionKey}
          texts={data.texts}
          initialSource={sheet.item.sourceLang}
          onClose={onClose}
          onSaved={onSaved}
        />
      );
  }
}
