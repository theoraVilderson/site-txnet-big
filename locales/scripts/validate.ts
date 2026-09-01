import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";

// مسیر پایه (پوشه locales)
const LOCALES_DIR = join(__dirname, "..");

// بخش‌های مختلف پروژه بر اساس پوشه‌بندی جدید
const SCOPES = [
  { name: "backend", path: join(LOCALES_DIR, "backend", "langs") },
  { name: "frontend", path: join(LOCALES_DIR, "frontend", "langs") },
  { name: "shareds", path: join(LOCALES_DIR, "shareds") },
];

const RESERVED_FILES = new Set(["metadata.json", "repomix-output.xml"]);

interface ValidationError {
  type: string;
  message: string;
}

// تابع مسطح کردن (Flatten) آبجکت‌های تو در تو (مثلا login.title)
function flattenObject(
  obj: Record<string, any>,
  prefix = "",
): Record<string, string> {
  return Object.keys(obj).reduce((acc: Record<string, string>, k: string) => {
    const pre = prefix.length ? prefix + "." : "";
    if (
      typeof obj[k] === "object" &&
      obj[k] !== null &&
      !Array.isArray(obj[k])
    ) {
      Object.assign(acc, flattenObject(obj[k], pre + k));
    } else if (typeof obj[k] === "string") {
      acc[pre + k] = obj[k];
    } else {
      throw new Error(`Invalid value type at key: ${pre + k}`);
    }
    return acc;
  }, {});
}

function getLanguageDirs(scopePath: string): string[] {
  if (!existsSync(scopePath)) return [];
  return readdirSync(scopePath).filter((name) => {
    const fullPath = join(scopePath, name);
    return statSync(fullPath).isDirectory() && !name.startsWith(".");
  });
}

function getNamespaceFiles(langDir: string): string[] {
  if (!existsSync(langDir)) return [];
  return readdirSync(langDir).filter(
    (f) => f.endsWith(".json") && !RESERVED_FILES.has(f),
  );
}

function extractVarsFromText(text: string): string[] {
  const matches = text.match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g) || [];
  return matches.map((m) => m.replace(/[{}]/g, "").trim()).sort();
}

function validateMetadata(
  langCode: string,
  metadataPath: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!existsSync(metadataPath)) return errors; // متادیتا در همه بخش‌ها اجباری نیست (مثل shareds)
  const requiredFields = [
    "code",
    "name",
    "shortName",
    "nativeName",
    "dir",
    "locale",
  ];
  let metadata: Record<string, unknown>;

  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  } catch {
    errors.push({
      type: "INVALID_METADATA",
      message: `[${langCode}] metadata.json is invalid JSON`,
    });
    return errors;
  }

  for (const field of requiredFields) {
    if (!(field in metadata)) {
      errors.push({
        type: "MISSING_METADATA_FIELD",
        message: `[${langCode}] Field "${field}" missing in metadata.json`,
      });
    }
  }

  if (metadata.dir && !["rtl", "ltr"].includes(metadata.dir as string)) {
    errors.push({
      type: "INVALID_DIR",
      message: `[${langCode}] dir value must be "rtl" or "ltr"`,
    });
  }

  if (metadata.code !== langCode) {
    errors.push({
      type: "CODE_MISMATCH",
      message: `[${langCode}] code field is "${metadata.code}" but folder is "${langCode}"`,
    });
  }

  return errors;
}

function main() {
  const errors: ValidationError[] = [];

  for (const scope of SCOPES) {
    if (!existsSync(scope.path)) continue;

    const languages = getLanguageDirs(scope.path);
    if (languages.length === 0) continue;

    console.log(
      `\n🔍 Checking Scope: [${scope.name}] - Languages: ${languages.join(", ")}`,
    );

    // 1) بررسی متادیتا برای این بخش
    for (const lang of languages) {
      errors.push(
        ...validateMetadata(lang, join(scope.path, lang, "metadata.json")),
      );
    }

    // 2) استخراج فایل‌های هر زبان در این بخش
    const namespacesByLang: Record<string, Set<string>> = {};
    const allNamespaces = new Set<string>();

    for (const lang of languages) {
      const files = getNamespaceFiles(join(scope.path, lang));
      namespacesByLang[lang] = new Set(files);
      for (const f of files) allNamespaces.add(f);
    }

    // 3) مقایسه محتوای فایل‌ها
    for (const ns of allNamespaces) {
      const contentByLang: Record<string, Record<string, string>> = {};

      for (const lang of languages) {
        if (!namespacesByLang[lang].has(ns)) {
          errors.push({
            type: "MISSING_NAMESPACE",
            message: `[${scope.name}/${lang}] File "${ns}" is missing`,
          });
          continue;
        }

        const filePath = join(scope.path, lang, ns);
        try {
          const rawJson = JSON.parse(readFileSync(filePath, "utf-8"));
          contentByLang[lang] = flattenObject(rawJson);
        } catch (e) {
          errors.push({
            type: "INVALID_JSON",
            message: `[${scope.name}/${lang}/${ns}] ${(e as Error).message}`,
          });
        }
      }

      const langsWithNs = Object.keys(contentByLang);
      if (langsWithNs.length < 2) continue;

      const allKeys = new Set<string>();
      for (const lang of langsWithNs) {
        for (const key of Object.keys(contentByLang[lang])) allKeys.add(key);
      }

      for (const key of allKeys) {
        const langsHavingKey = langsWithNs.filter(
          (lang) => key in contentByLang[lang],
        );
        const langsMissingKey = langsWithNs.filter(
          (lang) => !(key in contentByLang[lang]),
        );

        if (langsMissingKey.length > 0) {
          errors.push({
            type: "MISSING_KEY",
            message: `[${scope.name}/${ns}] Key "${key}" missing in ${langsMissingKey.join(", ")}`,
          });
          continue;
        }

        // استخراج و مقایسه متغیرها به صورت خودکار از متن
        const referenceLang = langsWithNs[0];
        const referenceVars = extractVarsFromText(
          contentByLang[referenceLang][key],
        );

        for (const lang of langsWithNs.slice(1)) {
          const currentVars = extractVarsFromText(contentByLang[lang][key]);

          const same =
            referenceVars.length === currentVars.length &&
            referenceVars.every((v) => currentVars.includes(v));

          if (!same) {
            errors.push({
              type: "VARS_MISMATCH",
              message: `[${scope.name}/${ns}] Key "${key}": Vars in ${referenceLang} [${referenceVars.join(",")}] don't match ${lang} [${currentVars.join(",")}]`,
            });
          }
        }
      }
    }
  }

  if (errors.length === 0) {
    console.log("\n✅ All good. No errors found.");
    process.exit(0);
  }

  console.error(`\n❌ ${errors.length} error(s) found:\n`);
  for (const err of errors) {
    console.error(`  [${err.type}] ${err.message}`);
  }
  process.exit(1);
}

main();
