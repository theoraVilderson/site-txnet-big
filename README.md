
```
site-txnet-big
├─ 3eora-mitm-proxy
│  ├─ code
│  │  ├─ Dockerfile
│  │  ├─ ca.crt
│  │  ├─ cache.go
│  │  ├─ cert.go
│  │  ├─ dedup.go
│  │  ├─ go.mod
│  │  ├─ install_ca.go
│  │  ├─ main.go
│  │  ├─ pki
│  │  │  ├─ alpine-signing-key.pub
│  │  │  └─ ca.crt
│  │  ├─ proxy.go
│  │  ├─ s3.go
│  │  ├─ socks.go
│  │  ├─ tee.go
│  │  └─ tmp
│  │     └─ main
│  └─ docker-compose.yml
├─ 3eora-mitm-proxy-code
│  ├─ code
│  │  ├─ Dockerfile.dev
│  │  ├─ ca.crt
│  │  ├─ cache.go
│  │  ├─ cert.go
│  │  ├─ dedup.go
│  │  ├─ go.mod
│  │  ├─ install_ca.go
│  │  ├─ main.go
│  │  ├─ pki
│  │  │  ├─ alpine-signing-key.pub
│  │  │  └─ ca.crt
│  │  ├─ proxy.go
│  │  ├─ s3.go
│  │  ├─ socks.go
│  │  ├─ tee.go
│  │  └─ tmp
│  │     └─ main
│  └─ docker-compose.yml
├─ README.INFRA.md
├─ README.md
├─ auth-handler
│  ├─ .air.toml
│  ├─ Dockerfile
│  ├─ cmd
│  │  └─ server
│  │     └─ main.go
│  ├─ configs
│  │  └─ permissions.yaml
│  ├─ go.mod
│  ├─ go.sum
│  ├─ internal
│  │  ├─ api
│  │  │  ├─ handlers
│  │  │  │  └─ handler.go
│  │  │  └─ middlewares
│  │  │     └─ middleware.go
│  │  ├─ auth
│  │  │  ├─ engin.go
│  │  │  └─ policy.go
│  │  ├─ cache
│  │  │  └─ redis.go
│  │  ├─ config
│  │  │  └─ config.go
│  │  ├─ jwt
│  │  │  └─ validator.go
│  │  ├─ locale
│  │  │  ├─ store.go
│  │  │  └─ watcher.go
│  │  └─ response
│  │     └─ response.go
│  └─ pkg
│     └─ logger
│        └─ logger.go
├─ coinsite
│  ├─ .dockerignore
│  ├─ Dockerfile
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ public
│  │  ├─ file.svg
│  │  ├─ fonts
│  │  │  ├─ Vazir-Bold.eot
│  │  │  ├─ Vazir-Bold.ttf
│  │  │  ├─ Vazir-Bold.woff
│  │  │  ├─ Vazir-Bold.woff2
│  │  │  ├─ Vazir-Light.eot
│  │  │  ├─ Vazir-Light.ttf
│  │  │  ├─ Vazir-Light.woff
│  │  │  ├─ Vazir-Light.woff2
│  │  │  ├─ Vazir-Medium.eot
│  │  │  ├─ Vazir-Medium.ttf
│  │  │  ├─ Vazir-Medium.woff
│  │  │  ├─ Vazir-Medium.woff2
│  │  │  ├─ Vazir-Thin.eot
│  │  │  ├─ Vazir-Thin.ttf
│  │  │  ├─ Vazir-Thin.woff
│  │  │  ├─ Vazir-Thin.woff2
│  │  │  ├─ Vazir.eot
│  │  │  ├─ Vazir.ttf
│  │  │  ├─ Vazir.woff
│  │  │  └─ Vazir.woff2
│  │  ├─ globe.svg
│  │  ├─ next.svg
│  │  ├─ vercel.svg
│  │  └─ window.svg
│  ├─ src
│  │  ├─ app
│  │  │  ├─ (Auth)
│  │  │  │  ├─ layout.tsx
│  │  │  │  ├─ login
│  │  │  │  │  └─ page.tsx
│  │  │  │  └─ register
│  │  │  │     └─ register.ts
│  │  │  ├─ favicon.ico
│  │  │  ├─ fonts.css
│  │  │  ├─ globals.css
│  │  │  ├─ layout.tsx
│  │  │  └─ page.tsx
│  │  ├─ lib
│  │  │  ├─ auth.ts
│  │  │  └─ logger.ts
│  │  └─ util
│  │     └─ theme.ts
│  └─ tsconfig.json
├─ dev-docker
│  ├─ README.md
│  ├─ bug-tracker
│  │  └─ docker-compose.bug-tracker.yml
│  ├─ dev-setup.sh
│  ├─ docker-compose.main.yml
│  ├─ monitoring
│  │  ├─ config-dev
│  │  │  ├─ alertmanager.yml
│  │  │  ├─ prometheus.yml
│  │  │  └─ promtail.yaml
│  │  └─ docker-compose.sys-monitor.yml
│  └─ registry
│     └─ docker-compose.registry.yml
├─ dev_letsencrypt
│  ├─ acme.json
│  └─ acme.json.bak
├─ image maker
│  ├─ Dockerfile copy.node-22
│  ├─ Dockerfile.alpine-3.24.1
│  ├─ Dockerfile.dev
│  ├─ Dockerfile.golang-1.22-alpine
│  ├─ Dockerfile.node-20-alpine
│  ├─ Dockerfile.node-22-alpine
│  ├─ ca.crt
│  └─ pki
│     ├─ alpine-signing-key.pub
│     └─ ca.crt
├─ locales
│  ├─ backend
│  │  └─ langs
│  │     ├─ en
│  │     │  ├─ errors.json
│  │     │  ├─ metadata.json
│  │     │  └─ notifications.json
│  │     └─ fa
│  │        ├─ errors.json
│  │        ├─ metadata.json
│  │        └─ notifications.json
│  ├─ frontend
│  │  └─ langs
│  │     ├─ en
│  │     │  ├─ auth.json
│  │     │  ├─ common.json
│  │     │  ├─ metadata.json
│  │     │  └─ validations.json
│  │     └─ fa
│  │        ├─ auth.json
│  │        ├─ common.json
│  │        ├─ metadata.json
│  │        └─ validations.json
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ scripts
│  │  └─ validate.ts
│  └─ shareds
│     ├─ en
│     └─ fa
├─ package-lock.json
├─ package.json
├─ pki
│  ├─ alpine-signing-key.pub
│  └─ ca.crt
├─ scripts
│  └─ dev.compose.sh
├─ site-pwa
│  ├─ .dockerignore
│  ├─ Dockerfile
│  ├─ README.md
│  ├─ locales
│  │  └─ langs
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ public
│  │  ├─ file.svg
│  │  ├─ fonts
│  │  │  ├─ Vazir-Bold.eot
│  │  │  ├─ Vazir-Bold.ttf
│  │  │  ├─ Vazir-Bold.woff
│  │  │  ├─ Vazir-Bold.woff2
│  │  │  ├─ Vazir-Light.eot
│  │  │  ├─ Vazir-Light.ttf
│  │  │  ├─ Vazir-Light.woff
│  │  │  ├─ Vazir-Light.woff2
│  │  │  ├─ Vazir-Medium.eot
│  │  │  ├─ Vazir-Medium.ttf
│  │  │  ├─ Vazir-Medium.woff
│  │  │  ├─ Vazir-Medium.woff2
│  │  │  ├─ Vazir-Thin.eot
│  │  │  ├─ Vazir-Thin.ttf
│  │  │  ├─ Vazir-Thin.woff
│  │  │  ├─ Vazir-Thin.woff2
│  │  │  ├─ Vazir.eot
│  │  │  ├─ Vazir.ttf
│  │  │  ├─ Vazir.woff
│  │  │  └─ Vazir.woff2
│  │  ├─ globe.svg
│  │  ├─ next.svg
│  │  ├─ vercel.svg
│  │  └─ window.svg
│  ├─ repomix-output.xml
│  ├─ src
│  │  ├─ app
│  │  │  ├─ (auth)
│  │  │  │  └─ auth
│  │  │  │     ├─ _components
│  │  │  │     │  ├─ AuthCardShell.tsx
│  │  │  │     │  ├─ AuthFooterLinks.tsx
│  │  │  │     │  ├─ AuthNav.tsx
│  │  │  │     │  ├─ LangDropdown.tsx
│  │  │  │     │  ├─ NatureCaptchaUI.tsx
│  │  │  │     │  ├─ OTPInput.tsx
│  │  │  │     │  ├─ OrganicField.tsx
│  │  │  │     │  ├─ OtpStep.tsx
│  │  │  │     │  ├─ PasswordField.tsx
│  │  │  │     │  ├─ SubmitButton.tsx
│  │  │  │     │  └─ ThemeDropdown.tsx
│  │  │  │     ├─ _context
│  │  │  │     │  └─ AuthUIContext.tsx
│  │  │  │     ├─ _hooks
│  │  │  │     │  └─ useOtpTimer.tsx
│  │  │  │     ├─ _lib
│  │  │  │     │  └─ translations.ts
│  │  │  │     ├─ forgot-password
│  │  │  │     │  └─ page.tsx
│  │  │  │     ├─ layout.tsx
│  │  │  │     ├─ login
│  │  │  │     │  └─ page.tsx
│  │  │  │     ├─ page.tsx
│  │  │  │     └─ signup
│  │  │  │        └─ page.tsx
│  │  │  ├─ api
│  │  │  │  ├─ auth
│  │  │  │  │  ├─ [...path]
│  │  │  │  │  │  └─ route.ts
│  │  │  │  │  └─ register
│  │  │  │  │     └─ route.ts
│  │  │  │  └─ i18n
│  │  │  │     ├─ [lang]
│  │  │  │     │  └─ [ns]
│  │  │  │     │     └─ route.ts
│  │  │  │     ├─ meta
│  │  │  │     │  └─ route.ts
│  │  │  │     └─ version
│  │  │  │        └─ route.ts
│  │  │  ├─ fonts.css
│  │  │  ├─ globals.css
│  │  │  ├─ layout.tsx
│  │  │  └─ page.tsx
│  │  ├─ components
│  │  │  └─ NamespaceInjector.tsx
│  │  ├─ context
│  │  │  ├─ LocaleContext.tsx
│  │  │  ├─ LocaleShell.tsx
│  │  │  ├─ ThemeContext.tsx
│  │  │  └─ ThemeShell.tsx
│  │  ├─ env.ts
│  │  ├─ global.d.ts
│  │  ├─ hooks
│  │  │  └─ useLocaleVersion.ts
│  │  ├─ i18n.ts
│  │  ├─ lib
│  │  │  ├─ auth-api.ts
│  │  │  ├─ locale-store.ts
│  │  │  ├─ locale-watcher.ts
│  │  │  └─ theme-script.ts
│  │  ├─ proxy.ts
│  │  ├─ repomix-output.xml
│  │  ├─ services
│  │  │  ├─ locale.ts
│  │  │  ├─ theme.ts
│  │  │  └─ user-locale-mock.ts
│  │  ├─ shared.ts
│  │  ├─ stores
│  │  │  ├─ locale-store.ts
│  │  │  └─ theme-store.ts
│  │  ├─ types
│  │  │  └─ i18n.ts
│  │  └─ util
│  │     └─ helper.ts
│  └─ tsconfig.json
├─ swarm
│  └─ docker-stack.yml
└─ txnet-backend
   ├─ .agents
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .claude
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .cursor
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .devin
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .editorconfig
   ├─ .nx
   │  ├─ cache
   │  │  ├─ 10172265793861767605
   │  │  ├─ 13953838817824439545
   │  │  ├─ 3664724434504734413
   │  │  ├─ run.json
   │  │  └─ terminalOutputs
   │  │     ├─ 10172265793861767605
   │  │     ├─ 13953838817824439545
   │  │     ├─ 16202246150803187830
   │  │     ├─ 3664724434504734413
   │  │     └─ 9433822816395616992
   │  └─ workspace-data
   │     ├─ 0d3ad5913462409b8a5c84dd1fd256be-v3.db
   │     ├─ 0d3ad5913462409b8a5c84dd1fd256be-v3.lock
   │     ├─ d
   │     ├─ file-map.json
   │     ├─ jest-7930610538513362720.hash
   │     ├─ lockfile-dependencies.hash
   │     ├─ lockfile-nodes.hash
   │     ├─ machine-v3.db
   │     ├─ machine-v3.lock
   │     ├─ nx_files.nxt
   │     ├─ parsed-lock-file.dependencies.json
   │     ├─ parsed-lock-file.nodes.json
   │     ├─ project-graph.json
   │     ├─ project-graph.lock
   │     ├─ source-maps.json
   │     └─ webpack-7566275343909617285.hash
   ├─ .prettierignore
   ├─ .prettierrc
   ├─ Dockerfile
   ├─ README.md
   ├─ auth-service
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ app
   │  │  │  ├─ app.controller.spec.ts
   │  │  │  ├─ app.controller.ts
   │  │  │  ├─ app.module.ts
   │  │  │  ├─ app.service.spec.ts
   │  │  │  ├─ app.service.ts
   │  │  │  ├─ auth
   │  │  │  │  ├─ auth.controller.ts
   │  │  │  │  ├─ auth.guard.ts
   │  │  │  │  ├─ auth.module.ts
   │  │  │  │  ├─ auth.schema.ts
   │  │  │  │  ├─ auth.service.ts
   │  │  │  │  ├─ decorators
   │  │  │  │  │  └─ rate-limit.decorator.ts
   │  │  │  │  ├─ guards
   │  │  │  │  │  ├─ permissions.guard.ts
   │  │  │  │  │  └─ sensitive-action.guard.ts
   │  │  │  │  ├─ otp
   │  │  │  │  │  ├─ otp.interface.ts
   │  │  │  │  │  ├─ otp.placeholder.service.ts
   │  │  │  │  │  ├─ otp.service.ts
   │  │  │  │  │  └─ senders
   │  │  │  │  │     ├─ bale.sender.ts
   │  │  │  │  │     ├─ otp-message.util.ts
   │  │  │  │  │     ├─ otp-sender.interface.ts
   │  │  │  │  │     ├─ sms-provider
   │  │  │  │  │     │  ├─ helper.ts
   │  │  │  │  │     │  └─ sms-provider.service.ts
   │  │  │  │  │     ├─ sms.sender.ts
   │  │  │  │  │     ├─ telegram-like-bot.client.ts
   │  │  │  │  │     └─ telegram.sender.ts
   │  │  │  │  ├─ register
   │  │  │  │  │  ├─ register.controller.ts
   │  │  │  │  │  ├─ register.schema.ts
   │  │  │  │  │  └─ register.service.ts
   │  │  │  │  ├─ session
   │  │  │  │  │  └─ session.service.ts
   │  │  │  │  └─ token.service.ts
   │  │  │  ├─ common
   │  │  │  │  ├─ filters
   │  │  │  │  │  └─ i18n-exception.filter.ts
   │  │  │  │  ├─ guards
   │  │  │  │  │  └─ rate-limit.guard.ts
   │  │  │  │  ├─ interceptors
   │  │  │  │  │  └─ response.interceptor.ts
   │  │  │  │  ├─ middlewares
   │  │  │  │  │  └─ language.middleware.ts
   │  │  │  │  ├─ pipes
   │  │  │  │  │  └─ zod-validation.pipe.ts
   │  │  │  │  ├─ response
   │  │  │  │  │  └─ response.util.ts
   │  │  │  │  └─ validation
   │  │  │  │     ├─ phone.schema.ts
   │  │  │  │     └─ strong-password.schema.ts
   │  │  │  ├─ config
   │  │  │  │  └─ env.validation.ts
   │  │  │  ├─ i18n
   │  │  │  │  └─ i18n.controller.ts
   │  │  │  ├─ impersonation
   │  │  │  │  ├─ guards
   │  │  │  │  │  ├─ permissions.guard.ts
   │  │  │  │  │  └─ sensetive-action.guard.ts
   │  │  │  │  ├─ impersonation.controller.ts
   │  │  │  │  ├─ impersonation.module.ts
   │  │  │  │  └─ impersonation.service.ts
   │  │  │  ├─ locale
   │  │  │  │  ├─ locale.module.ts
   │  │  │  │  ├─ locale.service.ts
   │  │  │  │  └─ locale.watcher.ts
   │  │  │  ├─ prisma
   │  │  │  │  ├─ prisma.module.ts
   │  │  │  │  └─ prisma.service.ts
   │  │  │  └─ redis
   │  │  │     ├─ redis.module.ts
   │  │  │     └─ redis.service.ts
   │  │  ├─ assets
   │  │  ├─ main.ts
   │  │  ├─ repomix-output.xml
   │  │  └─ types
   │  │     └─ express.d.ts
   │  ├─ tsconfig.app.json
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ auth-service-e2e
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ auth-service
   │  │  │  └─ auth-service.spec.ts
   │  │  └─ support
   │  │     ├─ global-setup.ts
   │  │     ├─ global-teardown.ts
   │  │     └─ test-setup.ts
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ billing-service
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ app
   │  │  │  ├─ app.controller.spec.ts
   │  │  │  ├─ app.controller.ts
   │  │  │  ├─ app.module.ts
   │  │  │  ├─ app.service.spec.ts
   │  │  │  └─ app.service.ts
   │  │  ├─ assets
   │  │  └─ main.ts
   │  ├─ tsconfig.app.json
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ billing-service-e2e
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ billing-service
   │  │  │  └─ billing-service.spec.ts
   │  │  └─ support
   │  │     ├─ global-setup.ts
   │  │     ├─ global-teardown.ts
   │  │     └─ test-setup.ts
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ jest.preset.js
   ├─ nest-cli.json
   ├─ nx.json
   ├─ package-lock.json
   ├─ package.json
   ├─ prisma
   │  └─ domains
   │     ├─ ai.prisma
   │     ├─ audit.prisma
   │     ├─ automation.prisma
   │     ├─ billing.prisma
   │     ├─ catalog.prisma
   │     ├─ core.prisma
   │     ├─ currency.prisma
   │     ├─ engagement.prisma
   │     ├─ fraud.prisma
   │     ├─ governance.prisma
   │     ├─ identity.prisma
   │     ├─ network.prisma
   │     ├─ notification.prisma
   │     ├─ support.prisma
   │     └─ tenant.prisma
   ├─ shared-core
   │  ├─ README.md
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ index.ts
   │  │  └─ lib
   │  │     └─ shared-core.module.ts
   │  ├─ tsconfig.json
   │  ├─ tsconfig.lib.json
   │  └─ tsconfig.spec.json
   └─ tsconfig.base.json

```
```
site-txnet-big
├─ 3eora-mitm-proxy
│  ├─ code
│  │  ├─ Dockerfile
│  │  ├─ ca.crt
│  │  ├─ cache.go
│  │  ├─ cert.go
│  │  ├─ dedup.go
│  │  ├─ go.mod
│  │  ├─ install_ca.go
│  │  ├─ main.go
│  │  ├─ pki
│  │  │  ├─ alpine-signing-key.pub
│  │  │  └─ ca.crt
│  │  ├─ proxy.go
│  │  ├─ s3.go
│  │  ├─ socks.go
│  │  ├─ tee.go
│  │  └─ tmp
│  │     └─ main
│  └─ docker-compose.yml
├─ 3eora-mitm-proxy-code
│  ├─ code
│  │  ├─ Dockerfile.dev
│  │  ├─ ca.crt
│  │  ├─ cache.go
│  │  ├─ cert.go
│  │  ├─ dedup.go
│  │  ├─ go.mod
│  │  ├─ install_ca.go
│  │  ├─ main.go
│  │  ├─ pki
│  │  │  ├─ alpine-signing-key.pub
│  │  │  └─ ca.crt
│  │  ├─ proxy.go
│  │  ├─ s3.go
│  │  ├─ socks.go
│  │  ├─ tee.go
│  │  └─ tmp
│  │     └─ main
│  └─ docker-compose.yml
├─ README.INFRA.md
├─ README.md
├─ auth-handler
│  ├─ .air.toml
│  ├─ Dockerfile
│  ├─ cmd
│  │  └─ server
│  │     └─ main.go
│  ├─ configs
│  │  └─ permissions.yaml
│  ├─ go.mod
│  ├─ go.sum
│  ├─ internal
│  │  ├─ api
│  │  │  ├─ handlers
│  │  │  │  └─ handler.go
│  │  │  └─ middlewares
│  │  │     └─ middleware.go
│  │  ├─ auth
│  │  │  ├─ engin.go
│  │  │  └─ policy.go
│  │  ├─ cache
│  │  │  └─ redis.go
│  │  ├─ config
│  │  │  └─ config.go
│  │  ├─ jwt
│  │  │  └─ validator.go
│  │  ├─ locale
│  │  │  ├─ store.go
│  │  │  └─ watcher.go
│  │  └─ response
│  │     └─ response.go
│  └─ pkg
│     └─ logger
│        └─ logger.go
├─ coinsite
│  ├─ .dockerignore
│  ├─ Dockerfile
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ public
│  │  ├─ file.svg
│  │  ├─ fonts
│  │  │  ├─ Vazir-Bold.eot
│  │  │  ├─ Vazir-Bold.ttf
│  │  │  ├─ Vazir-Bold.woff
│  │  │  ├─ Vazir-Bold.woff2
│  │  │  ├─ Vazir-Light.eot
│  │  │  ├─ Vazir-Light.ttf
│  │  │  ├─ Vazir-Light.woff
│  │  │  ├─ Vazir-Light.woff2
│  │  │  ├─ Vazir-Medium.eot
│  │  │  ├─ Vazir-Medium.ttf
│  │  │  ├─ Vazir-Medium.woff
│  │  │  ├─ Vazir-Medium.woff2
│  │  │  ├─ Vazir-Thin.eot
│  │  │  ├─ Vazir-Thin.ttf
│  │  │  ├─ Vazir-Thin.woff
│  │  │  ├─ Vazir-Thin.woff2
│  │  │  ├─ Vazir.eot
│  │  │  ├─ Vazir.ttf
│  │  │  ├─ Vazir.woff
│  │  │  └─ Vazir.woff2
│  │  ├─ globe.svg
│  │  ├─ next.svg
│  │  ├─ vercel.svg
│  │  └─ window.svg
│  ├─ src
│  │  ├─ app
│  │  │  ├─ (Auth)
│  │  │  │  ├─ layout.tsx
│  │  │  │  ├─ login
│  │  │  │  │  └─ page.tsx
│  │  │  │  └─ register
│  │  │  │     └─ register.ts
│  │  │  ├─ favicon.ico
│  │  │  ├─ fonts.css
│  │  │  ├─ globals.css
│  │  │  ├─ layout.tsx
│  │  │  └─ page.tsx
│  │  ├─ lib
│  │  │  ├─ auth.ts
│  │  │  └─ logger.ts
│  │  └─ util
│  │     └─ theme.ts
│  └─ tsconfig.json
├─ dev-docker
│  ├─ README.md
│  ├─ bug-tracker
│  │  └─ docker-compose.bug-tracker.yml
│  ├─ dev-setup.sh
│  ├─ docker-compose.main.yml
│  ├─ monitoring
│  │  ├─ config-dev
│  │  │  ├─ alertmanager.yml
│  │  │  ├─ prometheus.yml
│  │  │  └─ promtail.yaml
│  │  └─ docker-compose.sys-monitor.yml
│  └─ registry
│     └─ docker-compose.registry.yml
├─ dev_letsencrypt
│  ├─ acme.json
│  └─ acme.json.bak
├─ image maker
│  ├─ Dockerfile copy.node-22
│  ├─ Dockerfile.alpine-3.24.1
│  ├─ Dockerfile.dev
│  ├─ Dockerfile.golang-1.22-alpine
│  ├─ Dockerfile.node-20-alpine
│  ├─ Dockerfile.node-22-alpine
│  ├─ ca.crt
│  └─ pki
│     ├─ alpine-signing-key.pub
│     └─ ca.crt
├─ locales
│  ├─ backend
│  │  └─ langs
│  │     ├─ en
│  │     │  ├─ errors.json
│  │     │  ├─ metadata.json
│  │     │  └─ notifications.json
│  │     └─ fa
│  │        ├─ errors.json
│  │        ├─ metadata.json
│  │        └─ notifications.json
│  ├─ frontend
│  │  └─ langs
│  │     ├─ en
│  │     │  ├─ auth.json
│  │     │  ├─ common.json
│  │     │  ├─ metadata.json
│  │     │  └─ validations.json
│  │     └─ fa
│  │        ├─ auth.json
│  │        ├─ common.json
│  │        ├─ metadata.json
│  │        └─ validations.json
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ scripts
│  │  └─ validate.ts
│  └─ shareds
│     ├─ en
│     └─ fa
├─ package-lock.json
├─ package.json
├─ pki
│  ├─ alpine-signing-key.pub
│  └─ ca.crt
├─ scripts
│  └─ dev.compose.sh
├─ site-pwa
│  ├─ .dockerignore
│  ├─ Dockerfile
│  ├─ README.md
│  ├─ locales
│  │  └─ langs
│  ├─ package-lock.json
│  ├─ package.json
│  ├─ public
│  │  ├─ file.svg
│  │  ├─ fonts
│  │  │  ├─ Vazir-Bold.eot
│  │  │  ├─ Vazir-Bold.ttf
│  │  │  ├─ Vazir-Bold.woff
│  │  │  ├─ Vazir-Bold.woff2
│  │  │  ├─ Vazir-Light.eot
│  │  │  ├─ Vazir-Light.ttf
│  │  │  ├─ Vazir-Light.woff
│  │  │  ├─ Vazir-Light.woff2
│  │  │  ├─ Vazir-Medium.eot
│  │  │  ├─ Vazir-Medium.ttf
│  │  │  ├─ Vazir-Medium.woff
│  │  │  ├─ Vazir-Medium.woff2
│  │  │  ├─ Vazir-Thin.eot
│  │  │  ├─ Vazir-Thin.ttf
│  │  │  ├─ Vazir-Thin.woff
│  │  │  ├─ Vazir-Thin.woff2
│  │  │  ├─ Vazir.eot
│  │  │  ├─ Vazir.ttf
│  │  │  ├─ Vazir.woff
│  │  │  └─ Vazir.woff2
│  │  ├─ globe.svg
│  │  ├─ next.svg
│  │  ├─ vercel.svg
│  │  └─ window.svg
│  ├─ repomix-output.xml
│  ├─ src
│  │  ├─ app
│  │  │  ├─ (auth)
│  │  │  │  └─ auth
│  │  │  │     ├─ _components
│  │  │  │     │  ├─ AuthCardShell.tsx
│  │  │  │     │  ├─ AuthFooterLinks.tsx
│  │  │  │     │  ├─ AuthNav.tsx
│  │  │  │     │  ├─ LangDropdown.tsx
│  │  │  │     │  ├─ NatureCaptchaUI.tsx
│  │  │  │     │  ├─ OTPInput.tsx
│  │  │  │     │  ├─ OrganicField.tsx
│  │  │  │     │  ├─ OtpStep.tsx
│  │  │  │     │  ├─ PasswordField.tsx
│  │  │  │     │  ├─ SubmitButton.tsx
│  │  │  │     │  └─ ThemeDropdown.tsx
│  │  │  │     ├─ _context
│  │  │  │     │  └─ AuthUIContext.tsx
│  │  │  │     ├─ _hooks
│  │  │  │     │  └─ useOtpTimer.tsx
│  │  │  │     ├─ _lib
│  │  │  │     │  └─ translations.ts
│  │  │  │     ├─ forgot-password
│  │  │  │     │  └─ page.tsx
│  │  │  │     ├─ layout.tsx
│  │  │  │     ├─ login
│  │  │  │     │  └─ page.tsx
│  │  │  │     ├─ page.tsx
│  │  │  │     └─ signup
│  │  │  │        └─ page.tsx
│  │  │  ├─ api
│  │  │  │  ├─ auth
│  │  │  │  │  ├─ [...path]
│  │  │  │  │  │  └─ route.ts
│  │  │  │  │  └─ register
│  │  │  │  │     └─ route.ts
│  │  │  │  └─ i18n
│  │  │  │     ├─ [lang]
│  │  │  │     │  └─ [ns]
│  │  │  │     │     └─ route.ts
│  │  │  │     ├─ meta
│  │  │  │     │  └─ route.ts
│  │  │  │     └─ version
│  │  │  │        └─ route.ts
│  │  │  ├─ fonts.css
│  │  │  ├─ globals.css
│  │  │  ├─ layout.tsx
│  │  │  └─ page.tsx
│  │  ├─ components
│  │  │  └─ NamespaceInjector.tsx
│  │  ├─ context
│  │  │  ├─ LocaleContext.tsx
│  │  │  ├─ LocaleShell.tsx
│  │  │  ├─ ThemeContext.tsx
│  │  │  └─ ThemeShell.tsx
│  │  ├─ env.ts
│  │  ├─ global.d.ts
│  │  ├─ hooks
│  │  │  └─ useLocaleVersion.ts
│  │  ├─ i18n.ts
│  │  ├─ lib
│  │  │  ├─ auth-api.ts
│  │  │  ├─ locale-store.ts
│  │  │  ├─ locale-watcher.ts
│  │  │  └─ theme-script.ts
│  │  ├─ proxy.ts
│  │  ├─ repomix-output.xml
│  │  ├─ services
│  │  │  ├─ locale.ts
│  │  │  ├─ theme.ts
│  │  │  └─ user-locale-mock.ts
│  │  ├─ shared.ts
│  │  ├─ stores
│  │  │  ├─ locale-store.ts
│  │  │  └─ theme-store.ts
│  │  ├─ types
│  │  │  └─ i18n.ts
│  │  └─ util
│  │     └─ helper.ts
│  └─ tsconfig.json
├─ swarm
│  └─ docker-stack.yml
└─ txnet-backend
   ├─ .agents
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .claude
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .cursor
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .devin
   │  └─ skills
   │     ├─ prisma-8
   │     │  ├─ SKILL.md
   │     │  ├─ references
   │     │  │  ├─ contract.md
   │     │  │  ├─ debug.md
   │     │  │  ├─ feedback.md
   │     │  │  ├─ migration-model.md
   │     │  │  ├─ migration-review.md
   │     │  │  ├─ migrations.md
   │     │  │  ├─ queries-mongo.md
   │     │  │  ├─ queries-postgres.md
   │     │  │  ├─ queries.md
   │     │  │  ├─ quickstart.md
   │     │  │  ├─ runtime.md
   │     │  │  ├─ supabase.md
   │     │  │  ├─ upgrade-app.md
   │     │  │  └─ upgrade-extension.md
   │     │  └─ upgrading
   │     │     ├─ app
   │     │     │  └─ upgrades
   │     │     │     ├─ 0.10-to-0.11
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.11-to-0.12
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ re-emit-closed-mongo-contracts.ts
   │     │     │     │  ├─ re-emit-domain-namespaced-contracts.ts
   │     │     │     │  ├─ re-emit-postgres-public-default.ts
   │     │     │     │  └─ strip-migration-labels-hints.ts
   │     │     │     ├─ 0.12-to-0.13
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ re-emit-mti-variant-link-columns.ts
   │     │     │     ├─ 0.13-to-0.14
   │     │     │     │  ├─ instructions.md
   │     │     │     │  ├─ migration-op-factories-to-methods.ts
   │     │     │     │  └─ uuid-preset-rename.ts
   │     │     │     ├─ 0.14-to-0.15
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.15-to-0.16
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.16-to-0.17
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-sha256-hash-prefixes.ts
   │     │     │     ├─ 0.17-to-8.0.0-rc.1
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.7-to-0.8
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 0.8-to-0.9
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ strip-inline-contracts.ts
   │     │     │     ├─ 0.9-to-0.10
   │     │     │     │  ├─ instructions.md
   │     │     │     │  └─ stamp-storage-types-kind.ts
   │     │     │     ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │     │     │  └─ instructions.md
   │     │     │     ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │     │     │  └─ instructions.md
   │     │     │     └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │     │        └─ instructions.md
   │     │     └─ extension
   │     │        └─ upgrades
   │     │           ├─ 0.10-to-0.11
   │     │           │  └─ instructions.md
   │     │           ├─ 0.11-to-0.12
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migrate-contract-testing-imports.ts
   │     │           │  ├─ regenerate-extension-public-baseline.ts
   │     │           │  └─ strip-migration-labels-hints.ts
   │     │           ├─ 0.12-to-0.13
   │     │           │  └─ instructions.md
   │     │           ├─ 0.13-to-0.14
   │     │           │  ├─ instructions.md
   │     │           │  ├─ migration-op-factories-to-methods.ts
   │     │           │  └─ uuid-preset-rename.ts
   │     │           ├─ 0.14-to-0.15
   │     │           │  └─ instructions.md
   │     │           ├─ 0.15-to-0.16
   │     │           │  └─ instructions.md
   │     │           ├─ 0.16-to-0.17
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-sha256-hash-prefixes.ts
   │     │           ├─ 0.17-to-8.0.0-rc.1
   │     │           │  └─ instructions.md
   │     │           ├─ 0.7-to-0.8
   │     │           │  └─ instructions.md
   │     │           ├─ 0.8-to-0.9
   │     │           │  ├─ instructions.md
   │     │           │  └─ strip-inline-contracts.ts
   │     │           ├─ 0.9-to-0.10
   │     │           │  ├─ instructions.md
   │     │           │  └─ stamp-storage-types-kind.ts
   │     │           ├─ 8.0.0-rc.1-to-8.0.0-rc.2
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.2-to-8.0.0-rc.3
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.3-to-8.0.0-rc.4
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.4-to-8.0.0-rc.5
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.5-to-8.0.0-rc.6
   │     │           │  └─ instructions.md
   │     │           ├─ 8.0.0-rc.6-to-8.0.0-rc.7
   │     │           │  └─ instructions.md
   │     │           └─ 8.0.0-rc.7-to-8.0.0-rc.8
   │     │              └─ instructions.md
   │     └─ prisma-composer
   │        └─ SKILL.md
   ├─ .editorconfig
   ├─ .nx
   │  ├─ cache
   │  │  ├─ 10172265793861767605
   │  │  ├─ 13953838817824439545
   │  │  ├─ 3664724434504734413
   │  │  ├─ run.json
   │  │  └─ terminalOutputs
   │  │     ├─ 10172265793861767605
   │  │     ├─ 13953838817824439545
   │  │     ├─ 16202246150803187830
   │  │     ├─ 3664724434504734413
   │  │     └─ 9433822816395616992
   │  └─ workspace-data
   │     ├─ 0d3ad5913462409b8a5c84dd1fd256be-v3.db
   │     ├─ 0d3ad5913462409b8a5c84dd1fd256be-v3.lock
   │     ├─ d
   │     ├─ file-map.json
   │     ├─ jest-7930610538513362720.hash
   │     ├─ lockfile-dependencies.hash
   │     ├─ lockfile-nodes.hash
   │     ├─ machine-v3.db
   │     ├─ machine-v3.lock
   │     ├─ nx_files.nxt
   │     ├─ parsed-lock-file.dependencies.json
   │     ├─ parsed-lock-file.nodes.json
   │     ├─ project-graph.json
   │     ├─ project-graph.lock
   │     ├─ source-maps.json
   │     └─ webpack-7566275343909617285.hash
   ├─ .prettierignore
   ├─ .prettierrc
   ├─ Dockerfile
   ├─ README.md
   ├─ auth-service
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ app
   │  │  │  ├─ app.controller.spec.ts
   │  │  │  ├─ app.controller.ts
   │  │  │  ├─ app.module.ts
   │  │  │  ├─ app.service.spec.ts
   │  │  │  ├─ app.service.ts
   │  │  │  ├─ auth
   │  │  │  │  ├─ auth.controller.ts
   │  │  │  │  ├─ auth.guard.ts
   │  │  │  │  ├─ auth.module.ts
   │  │  │  │  ├─ auth.schema.ts
   │  │  │  │  ├─ auth.service.ts
   │  │  │  │  ├─ decorators
   │  │  │  │  │  └─ rate-limit.decorator.ts
   │  │  │  │  ├─ guards
   │  │  │  │  │  ├─ permissions.guard.ts
   │  │  │  │  │  └─ sensitive-action.guard.ts
   │  │  │  │  ├─ otp
   │  │  │  │  │  ├─ otp.interface.ts
   │  │  │  │  │  ├─ otp.placeholder.service.ts
   │  │  │  │  │  ├─ otp.service.ts
   │  │  │  │  │  └─ senders
   │  │  │  │  │     ├─ bale.sender.ts
   │  │  │  │  │     ├─ otp-message.util.ts
   │  │  │  │  │     ├─ otp-sender.interface.ts
   │  │  │  │  │     ├─ sms-provider
   │  │  │  │  │     │  ├─ helper.ts
   │  │  │  │  │     │  └─ sms-provider.service.ts
   │  │  │  │  │     ├─ sms.sender.ts
   │  │  │  │  │     ├─ telegram-like-bot.client.ts
   │  │  │  │  │     └─ telegram.sender.ts
   │  │  │  │  ├─ register
   │  │  │  │  │  ├─ register.controller.ts
   │  │  │  │  │  ├─ register.schema.ts
   │  │  │  │  │  └─ register.service.ts
   │  │  │  │  ├─ session
   │  │  │  │  │  └─ session.service.ts
   │  │  │  │  └─ token.service.ts
   │  │  │  ├─ common
   │  │  │  │  ├─ filters
   │  │  │  │  │  └─ i18n-exception.filter.ts
   │  │  │  │  ├─ guards
   │  │  │  │  │  └─ rate-limit.guard.ts
   │  │  │  │  ├─ interceptors
   │  │  │  │  │  └─ response.interceptor.ts
   │  │  │  │  ├─ middlewares
   │  │  │  │  │  └─ language.middleware.ts
   │  │  │  │  ├─ pipes
   │  │  │  │  │  └─ zod-validation.pipe.ts
   │  │  │  │  ├─ response
   │  │  │  │  │  └─ response.util.ts
   │  │  │  │  └─ validation
   │  │  │  │     ├─ phone.schema.ts
   │  │  │  │     └─ strong-password.schema.ts
   │  │  │  ├─ config
   │  │  │  │  └─ env.validation.ts
   │  │  │  ├─ i18n
   │  │  │  │  └─ i18n.controller.ts
   │  │  │  ├─ impersonation
   │  │  │  │  ├─ guards
   │  │  │  │  │  ├─ permissions.guard.ts
   │  │  │  │  │  └─ sensetive-action.guard.ts
   │  │  │  │  ├─ impersonation.controller.ts
   │  │  │  │  ├─ impersonation.module.ts
   │  │  │  │  └─ impersonation.service.ts
   │  │  │  ├─ locale
   │  │  │  │  ├─ locale.module.ts
   │  │  │  │  ├─ locale.service.ts
   │  │  │  │  └─ locale.watcher.ts
   │  │  │  ├─ prisma
   │  │  │  │  ├─ prisma.module.ts
   │  │  │  │  └─ prisma.service.ts
   │  │  │  └─ redis
   │  │  │     ├─ redis.module.ts
   │  │  │     └─ redis.service.ts
   │  │  ├─ assets
   │  │  ├─ main.ts
   │  │  ├─ repomix-output.xml
   │  │  └─ types
   │  │     └─ express.d.ts
   │  ├─ tsconfig.app.json
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ auth-service-e2e
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ auth-service
   │  │  │  └─ auth-service.spec.ts
   │  │  └─ support
   │  │     ├─ global-setup.ts
   │  │     ├─ global-teardown.ts
   │  │     └─ test-setup.ts
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ billing-service
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ app
   │  │  │  ├─ app.controller.spec.ts
   │  │  │  ├─ app.controller.ts
   │  │  │  ├─ app.module.ts
   │  │  │  ├─ app.service.spec.ts
   │  │  │  └─ app.service.ts
   │  │  ├─ assets
   │  │  └─ main.ts
   │  ├─ tsconfig.app.json
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ billing-service-e2e
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ billing-service
   │  │  │  └─ billing-service.spec.ts
   │  │  └─ support
   │  │     ├─ global-setup.ts
   │  │     ├─ global-teardown.ts
   │  │     └─ test-setup.ts
   │  ├─ tsconfig.json
   │  └─ tsconfig.spec.json
   ├─ jest.preset.js
   ├─ nest-cli.json
   ├─ nx.json
   ├─ package-lock.json
   ├─ package.json
   ├─ prisma
   │  └─ domains
   │     ├─ ai.prisma
   │     ├─ audit.prisma
   │     ├─ automation.prisma
   │     ├─ billing.prisma
   │     ├─ catalog.prisma
   │     ├─ core.prisma
   │     ├─ currency.prisma
   │     ├─ engagement.prisma
   │     ├─ fraud.prisma
   │     ├─ governance.prisma
   │     ├─ identity.prisma
   │     ├─ network.prisma
   │     ├─ notification.prisma
   │     ├─ support.prisma
   │     └─ tenant.prisma
   ├─ shared-core
   │  ├─ README.md
   │  ├─ project.json
   │  ├─ src
   │  │  ├─ index.ts
   │  │  └─ lib
   │  │     └─ shared-core.module.ts
   │  ├─ tsconfig.json
   │  ├─ tsconfig.lib.json
   │  └─ tsconfig.spec.json
   └─ tsconfig.base.json

```