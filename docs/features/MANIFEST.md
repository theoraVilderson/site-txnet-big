---
id: features-manifest
status: generated
---

# Feature catalog manifest — GENERATED, do not hand-edit

Rebuild: `python3 tools/features-scan.py`

- catalog files: 1
- addressable blocks: 163
- features: 170

**Never read the catalog directly.** `python3 tools/spec.py <F-id>` prints exactly the block you need.

## Blocks

| block | lines | features | D/C/INV | entities |
|---|---|---|---|---|
| `App-Features.md:19-32` Foundational Decisions | 14 |  | D-01 D-02 D-03 D-04 D-05 |  |
| `App-Features.md:33-60` Section 0.1 — Resolved Conflicts | 28 |  | C-01 C-02 C-03 C-04 C-05 C-06 C-07 C-08 C-09 C-10 C-11 C-12 C-13 C-14 C-15 C-16 C-17 C-18 C-19 D-01 D-03 D-04 D-05 |  |
| `App-Features.md:61-92` Table of Contents | 32 |  |  |  |
| `App-Features.md:93-94` Multilingual and Localization | 2 |  |  |  |
| `App-Features.md:95-100` · 1.1 Language as Data, Not Code | 6 |  |  |  |
| `App-Features.md:101-108` · 1.2 Dedicated Translation Service (locale-service) | 8 |  |  |  |
| `App-Features.md:109-114` · 1.3 Translation Namespacing and Scoping | 6 |  |  |  |
| `App-Features.md:115-121` · 1.4 Type-Safe i18n | 7 |  |  |  |
| `App-Features.md:122-125` · 1.5 RTL/LTR and Numeral Localization | 4 |  |  |  |
| `App-Features.md:126-131` · 1.6 Language Detection Chain | 6 |  |  |  |
| `App-Features.md:132-137` · 1.7 Ambient Brand Variables | 6 |  |  |  |
| `App-Features.md:138-147` · 1.8 Full Text Override by Tenant | 10 | F-1533 F-1545 F-317 |  |  |
| `App-Features.md:148-149` Identity, Login and Account Security | 2 |  |  |  |
| `App-Features.md:150-160` · 2.1 Registration and Login | 11 |  | C-15 |  |
| `App-Features.md:161-167` · 2.2 Password Policy | 7 |  |  |  |
| `App-Features.md:168-181` · 2.3 OTP System | 14 |  | C-05 |  |
| `App-Features.md:182-190` · 2.4 Sessions and Tokens | 9 |  |  |  |
| `App-Features.md:191-194` · 2.5 Attack Protection | 4 |  |  |  |
| `App-Features.md:195-217` · 2.6 Rate Limiting | 23 |  | C-05 |  |
| `App-Features.md:218-227` · 2.7 Bot / Human Verification (CAPTCHA) | 10 | F-0201 |  |  |
| `App-Features.md:228-229` Access Control (RBAC) and Time-Bounded Access | 2 |  |  |  |
| `App-Features.md:230-233` · 3.1 Roles as Data | 4 |  |  |  |
| `App-Features.md:234-239` · 3.2 Permission Key Structure | 6 |  |  |  |
| `App-Features.md:240-245` · 3.3 Separation of Platform Permissions from Tenant Permissions | 6 |  |  |  |
| `App-Features.md:246-249` · 3.4 Single Source of Truth for Permissions | 4 |  |  |  |
| `App-Features.md:250-260` · 3.5 Edge Authorization | 11 |  |  |  |
| `App-Features.md:261-271` · 3.6 Impersonation | 11 |  |  |  |
| `App-Features.md:272-283` · 3.7 Time-Bound Consent for Support | 12 |  |  |  |
| `App-Features.md:284-292` · 3.8 Temporal Access Grant (Elevated) | 9 |  |  |  |
| `App-Features.md:293-301` · 3.9 User-Level Restrictions (UserRestriction) | 9 |  |  |  |
| `App-Features.md:302-314` · 3.10 Strict Separation of the Four Access Mechanisms | 13 |  | C-02 D-01 |  |
| `App-Features.md:315-325` · 3.11 Ban on Plan-Name-Based Checks | 11 |  |  |  |
| `App-Features.md:326-337` · 3.12 RBAC Down to the Reseller Level | 12 | F-1201 F-904 F-906 |  |  |
| `App-Features.md:338-339` Product Model, Catalog and Sales Engine | 2 |  |  |  |
| `App-Features.md:340-352` · 4.1 A Product-Agnostic Platform | 13 |  |  |  |
| `App-Features.md:353-366` · 4.2 Catalog Structure | 14 |  |  |  |
| `App-Features.md:367-370` · 4.3 Product Names as Translation Keys | 4 |  |  |  |
| `App-Features.md:371-390` · 4.4 Grant — The Single Concept of Entitlement | 20 |  | C-09 C-15 |  |
| `App-Features.md:391-403` · 4.5 Quota Types | 13 |  |  |  |
| `App-Features.md:404-412` · 4.6 One Package, Five Configs, One Shared Quota | 9 |  |  |  |
| `App-Features.md:413-426` · 4.7 Discount Coupons | 14 |  |  |  |
| `App-Features.md:427-448` · 4.8 Pricing and Campaign Engine | 22 | F-408 F-501 F-502 F-503 F-504 F-505 F-506 F-507 F-508 F-509 F-510 F-511 F-512 |  |  |
| `App-Features.md:449-450` Wallet, Ledger and Payment | 2 |  |  |  |
| `App-Features.md:451-475` · 5.1 Double-Entry Ledger | 25 |  | C-13 | LedgerAccount LedgerTransaction |
| `App-Features.md:476-483` · 5.2 Two Separate Account Trees | 8 |  |  |  |
| `App-Features.md:484-489` · 5.3 Representing Money | 6 |  |  |  |
| `App-Features.md:490-495` · 5.4 One Wallet, No Complexity | 6 |  |  |  |
| `App-Features.md:496-509` · 5.5 Payment Gateways | 14 |  | C-19 D-03 |  |
| `App-Features.md:510-529` · 5.6 Card-to-Card with Automatic Matching | 20 | F-803 F-804 F-805 F-806 F-807 | C-14 |  |
| `App-Features.md:530-538` · 5.7 Payment Path Protections | 9 |  |  |  |
| `App-Features.md:539-566` · 5.8 Purchase Settlement Flow | 28 |  |  |  |
| `App-Features.md:567-570` · 5.9 Insufficient Balance | 4 |  |  |  |
| `App-Features.md:571-579` · 5.10 Refunds | 9 |  |  |  |
| `App-Features.md:580-583` · 5.11 Manual Balance Adjustment | 4 |  |  |  |
| `App-Features.md:584-603` · 5.12 Treasury and FX Risk | 20 |  |  | TreasuryConversion TreasurySnapshot |
| `App-Features.md:604-605` Dollar Pricing and FX Rate Engine | 2 |  |  |  |
| `App-Features.md:606-613` · 6.1 Why Dollars | 8 |  |  |  |
| `App-Features.md:614-627` · 6.2 The FX Worker | 14 |  |  |  |
| `App-Features.md:628-638` · 6.3 Rate Staleness Ladder | 11 |  |  |  |
| `App-Features.md:639-642` · 6.4 Manual Rate | 4 |  |  |  |
| `App-Features.md:643-663` · 6.5 Gateway Pricing Engine | 21 |  |  |  |
| `App-Features.md:664-671` · 6.6 One Calculator for Display and Charging | 8 |  |  |  |
| `App-Features.md:672-673` Network Service: Supply, Stability and Connection Intelligence | 2 |  |  |  |
| `App-Features.md:674-701` · 7.1 Panel Abstraction and Drivers | 28 |  |  |  |
| `App-Features.md:702-717` · 7.2 Bring Your Own Node (Customer's Own Panel) | 16 |  | C-18 |  |
| `App-Features.md:718-738` · 7.3 Panel Group and Mirroring — Zero Downtime | 21 |  |  | PanelGroup PanelGroupMember |
| `App-Features.md:739-749` · 7.4 Health Checks | 11 |  |  |  |
| `App-Features.md:750-774` · 7.5 Subscription Link | 25 |  | C-07 C-08 C-16 C-17 |  |
| `App-Features.md:775-785` · 7.6 Domain Rotation in the Subscription Response | 11 | F-105 F-106 |  |  |
| `App-Features.md:786-797` · 7.7 Connection Intelligence and ISP-Based Routing | 12 | F-1521 F-402 F-403 F-404 F-405 | C-06 |  |
| `App-Features.md:798-807` · 7.8 Connection Experience | 10 | F-307 F-409 F-410 F-411 F-414 |  |  |
| `App-Features.md:808-811` · 7.9 Concurrent Device Limits | 4 |  |  |  |
| `App-Features.md:812-829` · 7.10 Enforcement | 18 |  |  |  |
| `App-Features.md:830-833` Usage Measurement and Usage Billing | 4 |  |  |  |
| `App-Features.md:834-839` · 8.1 The Fundamental Problem | 6 |  |  |  |
| `App-Features.md:840-852` · 8.2 The Fix: Deltas with Explicit Reset Detection | 13 |  |  |  |
| `App-Features.md:853-856` · 8.3 Quarantining Implausible Deltas | 4 |  |  |  |
| `App-Features.md:857-875` · 8.4 Collection Pipeline | 19 |  |  |  |
| `App-Features.md:876-892` · 8.5 Pay-As-You-Go Billing | 17 |  |  |  |
| `App-Features.md:893-898` · 8.6 Usage Baseline on Migration | 6 |  |  |  |
| `App-Features.md:899-900` Multichannel Notifications and Campaigns | 2 |  |  |  |
| `App-Features.md:901-913` · 9.1 Structure | 13 |  |  | Campaign DeliveryLog Preference Template |
| `App-Features.md:914-917` · 9.2 Notifications as Domain Events | 4 |  |  |  |
| `App-Features.md:918-921` · 9.3 Event Keys | 4 |  |  |  |
| `App-Features.md:922-927` · 9.4 Preferences and Quiet Hours | 6 |  |  |  |
| `App-Features.md:928-936` · 9.5 Retention Notifications | 9 | F-1515 F-601 F-602 F-603 |  |  |
| `App-Features.md:937-945` · 9.6 Campaigns | 9 |  |  |  |
| `App-Features.md:946-953` · 9.7 No-Fallback Rule | 8 |  | D-03 |  |
| `App-Features.md:954-959` · 9.8 A Queue Resilient to Bot Bans | 6 |  |  |  |
| `App-Features.md:960-963` Bot as a Full Panel | 4 |  | D-02 |  |
| `App-Features.md:964-978` · 10.1 Multiple Bots per Tenant | 15 |  | C-05 |  |
| `App-Features.md:979-988` · 10.2 Webhook Architecture | 10 |  |  |  |
| `App-Features.md:989-997` · 10.3 Telegram/Bale Abstraction Layer | 9 | F-301 F-302 |  |  |
| `App-Features.md:998-1020` · 10.4 Full Bot Capabilities | 23 | F-1531 F-303 F-304 F-305 F-306 F-308 F-309 F-310 F-311 F-312 F-313 F-314 F-318 F-319 |  |  |
| `App-Features.md:1021-1028` · 10.5 Account Linking | 8 |  | C-05 |  |
| `App-Features.md:1029-1034` · 10.6 Bot Token Security | 6 |  |  |  |
| `App-Features.md:1035-1036` Unified Support | 2 |  |  |  |
| `App-Features.md:1037-1051` · 11.1 One Door, No Choice | 15 |  |  | Conversation Message |
| `App-Features.md:1052-1061` · 11.2 Behavior | 10 |  |  |  |
| `App-Features.md:1062-1070` · 11.3 Agent Side | 9 |  |  |  |
| `App-Features.md:1071-1074` · 11.4 File Attachments | 4 |  |  |  |
| `App-Features.md:1075-1078` · 11.5 Queue Priority | 4 |  |  |  |
| `App-Features.md:1079-1084` · 11.6 Tenant and Reseller Isolation | 6 |  |  |  |
| `App-Features.md:1085-1100` Realtime | 16 |  |  |  |
| `App-Features.md:1101-1104` White-Label, Domain and Resilience Against Filtering | 4 |  |  |  |
| `App-Features.md:1105-1125` · 13.1 Domain Model | 21 | F-101 F-102 F-113 F-114 F-115 | C-01 C-07 C-16 D-01 | TenantDomain |
| `App-Features.md:1126-1140` · 13.2 Domain Verification Lifecycle | 15 |  | C-01 C-03 |  |
| `App-Features.md:1141-1151` · 13.3 Resilience Against Filtering | 11 | F-103 F-104 F-110 F-112 |  |  |
| `App-Features.md:1152-1163` · 13.4 Anti-Fingerprinting | 12 | F-107 F-108 F-109 | C-04 |  |
| `App-Features.md:1164-1180` · 13.5 Public Pages | 17 |  |  | TenantPage |
| `App-Features.md:1181-1191` · 13.6 Trust Badges (eNamad and similar) | 11 |  |  | TrustBadge |
| `App-Features.md:1192-1204` · 13.7 Theme System | 13 |  |  | TenantTheme |
| `App-Features.md:1205-1218` · 13.8 Branding and SEO | 14 |  | C-04 | TenantBranding |
| `App-Features.md:1219-1228` · 13.9 Reseller-Specific (BYO) Integrations | 10 |  | C-19 D-03 |  |
| `App-Features.md:1229-1236` · 13.10 Browser-Level Isolation | 8 |  | C-16 |  |
| `App-Features.md:1237-1238` Panel Business: Plans, Subscriptions and Traffic Wallet | 2 |  |  |  |
| `App-Features.md:1239-1251` · 14.1 Two Products, Sold Separately | 13 |  | D-05 |  |
| `App-Features.md:1252-1302` · 14.2 Plans as Data | 51 |  | C-01 C-03 C-19 D-01 D-03 | Plan PlanFeature |
| `App-Features.md:1303-1308` · 14.3 Per-Customer Exceptions | 6 |  |  |  |
| `App-Features.md:1309-1316` · 14.4 Safe Downgrade | 8 |  |  |  |
| `App-Features.md:1317-1332` · 14.5 Traffic Wallet | 16 |  |  | TrafficLedgerEntry TrafficWallet |
| `App-Features.md:1333-1352` · 14.6 Subscription Lifecycle State Machine | 20 |  |  |  |
| `App-Features.md:1353-1356` · 14.7 Protecting Reseller End Users | 4 |  |  |  |
| `App-Features.md:1357-1371` · 14.8 Data Export and Deletion | 15 |  |  |  |
| `App-Features.md:1372-1398` Multi-Tier Reseller | 27 | F-901 F-902 F-903 F-905 F-907 | C-15 C-18 D-01 D-03 D-05 |  |
| `App-Features.md:1399-1429` Migration, Import and Onboarding | 31 | F-1532 F-201 F-202 F-203 F-204 F-205 F-206 F-207 F-208 F-209 F-210 F-211 F-212 F-213 F-214 | C-17 D-01 D-03 |  |
| `App-Features.md:1430-1431` Retention, Anti-Churn and Growth | 2 |  |  |  |
| `App-Features.md:1432-1447` · 17.1 Retention | 16 | F-1519 F-604 F-605 F-606 F-607 F-608 F-609 F-610 F-611 | C-09 |  |
| `App-Features.md:1448-1466` · 17.2 Growth and Acquisition | 19 | F-701 F-702 F-703 F-704 F-705 F-706 F-708 F-709 | C-10 C-11 D-05 |  |
| `App-Features.md:1467-1486` Reseller Profitability Tools | 20 | F-1001 F-1002 F-1003 F-1004 F-1005 F-1006 F-1007 |  |  |
| `App-Features.md:1487-1488` Security, Fraud and Abuse | 2 |  |  |  |
| `App-Features.md:1489-1498` · 19.1 Three Unrecoverable Risks | 10 |  |  |  |
| `App-Features.md:1499-1506` · 19.2 Input Handling | 8 |  | C-04 |  |
| `App-Features.md:1507-1514` · 19.3 Transport and Edge | 8 |  |  |  |
| `App-Features.md:1515-1550` · 19.4 Fraud and Abuse Detection | 36 | F-1101 F-1102 F-1103 F-1104 F-1105 F-1106 F-1107 F-1108 F-1524 |  |  |
| `App-Features.md:1551-1556` · 19.5 Reseller Risk | 6 |  |  |  |
| `App-Features.md:1557-1558` Governance, Isolation, Treasury and Audit | 2 |  |  |  |
| `App-Features.md:1559-1572` · 20.1 Audit Log | 14 |  |  | AdminAuditLog |
| `App-Features.md:1573-1581` · 20.2 Multi-Tenant Isolation — Six Layers | 9 |  |  |  |
| `App-Features.md:1582-1594` · 20.3 Tenant Detection | 13 |  | C-01 |  |
| `App-Features.md:1595-1615` · 20.4 Credential Vault | 21 |  |  | TenantCredential TenantDek |
| `App-Features.md:1616-1621` · 20.5 The 360° User View | 6 |  |  |  |
| `App-Features.md:1622-1631` · 20.6 User Settings | 10 |  |  |  |
| `App-Features.md:1632-1654` Platform Management Console | 23 |  | D-01 |  |
| `App-Features.md:1655-1675` Public API and Integration | 21 | F-1301 F-1302 F-1303 F-1304 F-1305 | D-01 |  |
| `App-Features.md:1676-1677` Monitoring, Reconciliation and Operations | 2 |  |  |  |
| `App-Features.md:1678-1693` · 23.1 Nightly Reconciliation (03:00 UTC) | 16 |  |  |  |
| `App-Features.md:1694-1697` · 23.2 End-to-End Money-Leak Test | 4 |  |  |  |
| `App-Features.md:1698-1713` · 23.3 Business Metrics Alongside System Metrics | 16 |  |  |  |
| `App-Features.md:1714-1723` · 23.4 Alert Severity Levels | 10 |  |  |  |
| `App-Features.md:1724-1731` · 23.5 Backup and Recovery | 8 |  |  |  |
| `App-Features.md:1732-1737` The AI Layer | 6 |  | D-04 |  |
| `App-Features.md:1738-1751` · 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) | 14 | F-1501 F-1502 F-1503 F-1504 F-1505 F-1506 F-1507 F-1508 F-1509 | C-13 |  |
| `App-Features.md:1752-1766` · 24.2 AI for the End User | 15 | F-1510 F-1511 F-1512 F-1513 F-1514 F-1516 F-1517 F-1518 |  |  |
| `App-Features.md:1767-1779` · 24.3 Invisible AI (No User-Facing Text — the Highest-Value Tier) | 13 | F-1520 F-1522 F-1523 F-1525 |  |  |
| `App-Features.md:1780-1791` · 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member) | 12 | F-1526 F-1527 F-1528 F-1529 F-1530 |  |  |
| `App-Features.md:1792-1795` · 24.5 Where AI Has No Access | 4 |  |  |  |
| `App-Features.md:1796-1810` · 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) | 15 | F-1534 F-1535 F-1536 F-1537 F-1538 F-1539 F-1540 F-1541 | D-03 D-04 |  |
| `App-Features.md:1811-1831` · 24.7 BYO-AI — Safety, Limits and Operations | 21 | F-1542 F-1543 F-1544 F-1546 F-1547 F-1548 F-1549 F-1550 | D-03 |  |
| `App-Features.md:1832-1849` Next-Phase Features | 18 | F-707 | C-11 C-12 |  |
| `App-Features.md:1850-1868` Appendix A — Permanent Decisions (Out of Scope) | 19 |  | C-04 C-10 D-01 D-03 D-05 |  |
| `App-Features.md:1869-1889` Appendix B — Mapping of v2 IDs to Sections of This Document | 21 |  |  |  |
| `App-Features.md:1890-1907` Appendix C — Checklist for Applying Changes in Other Documents | 18 |  | C-01 C-03 C-04 C-05 C-07 C-09 C-10 C-12 C-13 C-15 C-16 C-17 C-19 |  |

## Feature index

| id | feature | status | block |
|---|---|---|---|
| F-101 | A custom domain is mandatory for every plan; registered and owned by the tenant | changed | 13.1 Domain Model |
| F-102 | Multiple domains with primary / standby / retired roles | new | 13.1 Domain Model |
| F-103 | Domain health probing from inside Iran (multiple ISPs: Hamrah-e Avval, Irancell, Shatel, M | new | 13.3 Resilience Against Filtering |
| F-104 | Block-type detection: DNS poisoning, SNI block, IP block, RST injection | new | 13.3 Resilience Against Filtering |
| F-105 | Automatic subscription-link domain rotation — the /sub response includes a list of alterna | new | 7.6 Domain Rotation in the Subscription Response |
| F-106 | Emergency broadcast — when a domain goes unhealthy, the new link is immediately pushed to  | new | 7.6 Domain Rotation in the Subscription Response |
| F-107 | HTML structure, class names, asset hashes, and paths differ per tenant | new | 13.4 Anti-Fingerprinting |
| F-108 | Complete removal of platform traces: no "powered by," no shared domain in the JS bundle, s | new | 13.4 Anti-Fingerprinting |
| F-109 | Independent TLS certificate per domain; never a SAN shared across tenants | new | 13.4 Anti-Fingerprinting |
| F-110 | An IP pool with per-tenant allocation and rotation; controllable IP neighborhood | new | 13.3 Resilience Against Filtering |
| F-112 | Email, webhooks, and outbound links sent from the tenant's own domain | new | 13.3 Resilience Against Filtering |
| F-113 | A domain separate from the panel domain for /sub | new | 13.1 Domain Model |
| F-114 | Domain and certificate expiry alerts to the tenant | new | 13.1 Domain Model |
| F-115 | An always-warm standby domain — certificate pre-issued and pre-tested, switchover under a  | new | 13.1 Domain Model |
| F-201 | Import from Marzban, Marzneshin, legacy x-ui, 3x-ui, S-UI, Hiddify | new | Migration, Import and Onboarding |
| F-202 | Import: user, quota, consumed usage, expiry, active/inactive status, protocol | new | Migration, Import and Onboarding |
| F-203 | Legacy Link Adoption | new | Migration, Import and Onboarding |
| F-204 | Domain takeover mode — the old panel domain points to TXNet and the old /sub path keeps re | new | Migration, Import and Onboarding |
| F-205 | Gradual migration — TXNet configs sit alongside legacy configs in the same link, with the  | new | Migration, Import and Onboarding |
| F-206 | Dry run with a diff report before commit | new | Migration, Import and Onboarding |
| F-207 | Incremental, idempotent import based on remote identity | new | Migration, Import and Onboarding |
| F-208 | Usage baseline carry-over — billedBytes set from prior usage | new | Migration, Import and Onboarding |
| F-209 | CSV import of wallets and user balances | new | Migration, Import and Onboarding |
| F-210 | Legacy bot-user mapping | new | Migration, Import and Onboarding |
| F-211 | An N-day rollback window with the source state preserved | new | Migration, Import and Onboarding |
| F-212 | Full data export at any moment | new | Migration, Import and Onboarding |
| F-213 | Onboarding wizard: connect panel → import → pricing → domain → gateway → bot → first sale | changed | Migration, Import and Onboarding |
| F-214 | Sandbox environment with a fake driver and sample data | core | Migration, Import and Onboarding |
| F-301 | Shared abstraction layer with capability flags (file size, keyboard type, WebApp, payments | new | 10.3 Telegram/Bale Abstraction Layer |
| F-302 | Automatic degradation policy — if a capability is missing, fall back without failing | new | 10.3 Telegram/Bale Abstraction Layer |
| F-303 | Full registration and login inside the bot (OTP, language choice, profile) | new | 10.4 Full Bot Capabilities |
| F-304 | Catalog, variant selection, invoicing, and payment inside the bot | new | 10.4 Full Bot Capabilities |
| F-305 | One-click renewal and top-up on the same Grant | new | 10.4 Full Bot Capabilities |
| F-306 | Wallet: top-up, balance, transaction history, invoices | new | 10.4 Full Bot Capabilities |
| F-307 | Link, QR, per-app deep link, token rotation, reset — all in bot and panel | new | 7.8 Connection Experience |
| F-308 | Usage chart as a rendered image in the bot | new | 10.4 Full Bot Capabilities |
| F-309 | Two-way support ticket with attachments inside the bot | new | 10.4 Full Bot Capabilities |
| F-310 | Mini App / WebApp — the same PWA inside Telegram, sharing a session | new | 10.4 Full Bot Capabilities |
| F-311 | Reseller management panel inside the bot: create user, renew, block, revenue report | new | 10.4 Full Bot Capabilities |
| F-312 | Sub-reseller panel inside the bot | new | 10.4 Full Bot Capabilities |
| F-313 | Bulk sending with segmentation + a rate-limited queue | new | 10.4 Full Bot Capabilities |
| F-314 | Login deep links: ?start=buy_<sku> / ?start=ref_<code> / ?start=trial | new | 10.4 Full Bot Capabilities |
| F-317 | Bot text, menus, emoji and buttons fully overridable by the tenant (override within its ow | core | 1.8 Full Text Override by Tenant |
| F-318 | Channel-membership gate for claiming a free trial | new | 10.4 Full Bot Capabilities |
| F-319 | Per-user notification settings inside the bot | new | 10.4 Full Bot Capabilities |
| F-402 | Routing based on the user's ISP — tracking success rate per (ISP × inbound × hour) and ser | new | 7.7 Connection Intelligence and ISP-Based Routing |
| F-403 | Automatic detection of an inbound getting blocked, from a drop in success rate | new | 7.7 Connection Intelligence and ISP-Based Routing |
| F-404 | Automatic inbound rotation: create new, mirror, retire old, no admin involvement | new | 7.7 Connection Intelligence and ISP-Based Routing |
| F-405 | A "my connection isn't working" button in the bot that signals the routing engine | new | 7.7 Connection Intelligence and ISP-Based Routing |
| F-408 | Node quality tiers: standard / premium with a different price multiplier | new | 4.8 Pricing and Campaign Engine |
| F-409 | Speed-test and ping page per region before purchase | new | 7.8 Connection Experience |
| F-410 | User-selected region with a shared quota | partial | 7.8 Connection Experience |
| F-411 | Public status page per tenant (on its own domain) | new | 7.8 Connection Experience |
| F-414 | Per-OS app installation guide, localized, in-bot and in-panel | new | 7.8 Connection Experience |
| F-501 | Product/variant/USD price catalog, three-state visibility | core | 4.8 Pricing and Campaign Engine |
| F-502 | Full coupon engine (§4.7) | core | 4.8 Pricing and Campaign Engine |
| F-503 | Time-boxed campaign with countdown in bot and panel | new | 4.8 Pricing and Campaign Engine |
| F-504 | Tiered volume discounts | new | 4.8 Pricing and Campaign Engine |
| F-505 | Scheduled seasonal pricing (Nowruz, Yalda, Thursday-night) | new | 4.8 Pricing and Campaign Engine |
| F-506 | Per-user custom plan (manual price and quota) | new | 4.8 Pricing and Campaign Engine |
| F-507 | Bulk purchase and group user creation via CSV | new | 4.8 Pricing and Campaign Engine |
| F-508 | Pure volume sale with no plan (top-up gigs) | partial | 4.8 Pricing and Campaign Engine |
| F-509 | Presale / capacity reservation with discount | new | 4.8 Pricing and Campaign Engine |
| F-510 | Auto-renewal from the wallet with explicit consent | new | 4.8 Pricing and Campaign Engine |
| F-511 | Invoice/receipt PDF with tenant branding | new | 4.8 Pricing and Campaign Engine |
| F-512 | Toman price display with live rate + rate lock at invoice time | core | 4.8 Pricing and Campaign Engine |
| F-601 | Multi-threshold usage notifications (50% / 80% / 95%) and time (7 / 3 / 1 days) | partial | 9.5 Retention Notifications |
| F-602 | Exhaustion prediction: "at this rate, your volume runs out in 4 days" | new | 9.5 Retention Notifications |
| F-603 | 24-hour post-expiry grace period with a notice, instead of an abrupt cutoff | changed | 9.5 Retention Notifications |
| F-604 | Unused-volume rollover | new | 17.1 Retention |
| F-605 | Automatic win-back campaign: expired + N days of silence → dedicated coupon in the bot | new | 17.1 Retention |
| F-606 | Loyalty tiers (cumulative volume → bonus volume or an upgrade) | new | 17.1 Retention |
| F-607 | Gifting/transferring volume between users of the same tenant | new | 17.1 Retention |
| F-608 | Family sub-accounts with a shared quota | partial | 17.1 Retention |
| F-609 | Native display of remaining quota in the client app | core | 17.1 Retention |
| F-610 | A one-question survey on non-renewal | new | 17.1 Retention |
| F-611 | Customer health score for the reseller (churn probability) | new | 17.1 Retention |
| F-701 | Referral system — reward as volume, not cash | changed | 17.2 Growth and Acquisition |
| F-702 | Two-sided reward (referrer and referee) | new | 17.2 Growth and Acquisition |
| F-703 | Referral link and code, live stats, referral tree in the bot | new | 17.2 Growth and Acquisition |
| F-704 | Referral anti-fraud: device fingerprint, number, usage pattern | new | 17.2 Growth and Acquisition |
| F-705 | Free trial funded from the reseller's own share | changed | 17.2 Growth and Acquisition |
| F-706 | One trial per (tenant × fingerprint × number) | new | 17.2 Growth and Acquisition |
| F-707 | Lucky wheel and interactive mechanics | new | Next-Phase Features |
| F-708 | Social sharing link with the tenant's brand preview | new | 17.2 Growth and Acquisition |
| F-709 | UTM and campaign attribution down to purchase | new | 17.2 Growth and Acquisition |
| F-803 | Card-to-card as a first-class gateway | new | 5.6 Card-to-Card with Automatic Matching |
| F-804 | Unique amount per invoice (adding a few random rials to the amount) | new | 5.6 Card-to-Card with Automatic Matching |
| F-805 | Receipt upload in bot + confirmation queue + one-click admin confirmation from the bot | new | 5.6 Card-to-Card with Automatic Matching |
| F-806 | Bank SMS parsing as a confirmation source (optional, tenant-side) | new | 5.6 Card-to-Card with Automatic Matching |
| F-807 | Multiple destination accounts with rotation | new | 5.6 Card-to-Card with Automatic Matching |
| F-901 | Reseller hierarchy (at least 2 levels, tree model from day one) | new | Multi-Tier Reseller |
| F-902 | Reseller credit balance, separate from the user wallet | new | Multi-Tier Reseller |
| F-903 | Reseller pricing: multiplier or dedicated price list | new | Multi-Tier Reseller |
| F-904 | Reseller caps: user count, volume, max allowed discount | new | 3.12 RBAC Down to the Reseller Level |
| F-905 | Reseller profit report and internal settlement (no withdrawal) | new | Multi-Tier Reseller |
| F-906 | RLS and audit down to the reseller-node level (ltree path prefix) | new | 3.12 RBAC Down to the Reseller Level |
| F-907 | Separate brand and bot for a reseller | new | Multi-Tier Reseller |
| F-0201 | Server-verified slide challenge gates register and login: auth-service issues a short-live | new | 2.7 Bot / Human Verification (CAPTCHA) |
| F-1001 | Revenue, cost, and margin dashboard per user / panel / product / reseller | new | Reseller Profitability Tools |
| F-1002 | Bandwidth cost attribution to the panel owner | core | Reseller Profitability Tools |
| F-1003 | "This user costs more than they pay" alert | new | Reseller Profitability Tools |
| F-1004 | Cohort and LTV by acquisition channel | new | Reseller Profitability Tools |
| F-1005 | Usage forecast and capacity planning | new | Reseller Profitability Tools |
| F-1006 | Scheduled report to bot or email | new | Reseller Profitability Tools |
| F-1007 | CSV/Excel export of every report | new | Reseller Profitability Tools |
| F-1101 | Concurrent-device cap from distinct IPs | core | 19.4 Fraud and Abuse Detection |
| F-1102 | Link-sharing detection — multiple ISPs or cities simultaneously | new | 19.4 Fraud and Abuse Detection |
| F-1103 | Graduated response: warn → restrict → suspend (never an abrupt cutoff) | new | 19.4 Fraud and Abuse Detection |
| F-1104 | Abnormal usage pattern detection and delta quarantine | core | 19.4 Fraud and Abuse Detection |
| F-1105 | Node abuse policy (port scanning, spam) with automatic suspension | new | 19.4 Fraud and Abuse Detection |
| F-1106 | User risk score and fraud freeze | core | 19.4 Fraud and Abuse Detection |
| F-1107 | Rate limiting on account creation, free trials, and OTP | core | 19.4 Fraud and Abuse Detection |
| F-1108 | Per-tenant device-fingerprint blocklist | new | 19.4 Fraud and Abuse Detection |
| F-1201 | Staff seats and time-bound access | core | 3.12 RBAC Down to the Reseller Level |
| F-1301 | Public API with a per-tenant key (plan feature api.public) | core | Public API and Integration |
| F-1302 | Outbound webhooks for events (purchase, expiry, volume exhaustion, domain change) | new | Public API and Integration |
| F-1303 | Embeddable sales widget/iframe for a reseller's site | new | Public API and Integration |
| F-1304 | Lightweight JS and PHP SDKs | new | Public API and Integration |
| F-1305 | Per-tenant docs page on its own domain | new | Public API and Integration |
| F-1501 | A per-user attention budget — every proactive AI message has a cost and a periodic cap | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1502 | Answering a user's own question costs no budget; only AI-initiated messages cost anything | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1503 | A confidence threshold — below it, the AI stays silent | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1504 | Cooldown per (user × suggestion type) | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1505 | "Don't show me this again" with one tap, permanent, per type | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1506 | Quiet-down rules: open ticket, after a failed payment, connection-quality drop, during an  | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1507 | At most one CTA per message; no artificial urgency, no false scarcity, no guilt-tripping | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1508 | A permanent control group (holdout) that receives no AI messages at all | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1509 | Every AI message is labeled and auditable; a reseller can fully disable any type | new | 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature) |
| F-1510 | A tool-using support agent — reads real state before speaking: quota, panel health, ISP, d | new | 24.2 AI for the End User |
| F-1511 | Diagnosing the root cause of "I can't connect" and giving exactly that fix | new | 24.2 AI for the End User |
| F-1512 | Interactive install guide tailored to the user's OS and app | new | 24.2 AI for the End User |
| F-1513 | Smart escalation to a human, with a full diagnostic summary | new | 24.2 AI for the End User |
| F-1514 | Suggesting a smaller plan when a user has over-bought | new | 24.2 AI for the End User |
| F-1515 | An AI version of this same prediction, with one well-timed message | new | 9.5 Retention Notifications |
| F-1516 | Explaining abnormal usage ("yesterday it tripled; if that wasn't you, your link may be in  | new | 24.2 AI for the End User |
| F-1517 | Suggesting a better region/server based on actual ISP and usage-time patterns | new | 24.2 AI for the End User |
| F-1518 | Natural-language queries over the user's own account | new | 24.2 AI for the End User |
| F-1519 | Reason-driven churn path: if the risk is connection quality, quality gets fixed, not a dis | new | 17.1 Retention |
| F-1520 | Learning success rate (ISP × inbound × hour) and automatically selecting the best config | new | 24.3 Invisible AI (No User-Facing Text — the Highest-Value Tier) |
| F-1521 | Predicting an inbound getting blocked from the drop trend and rotating before full outage | new | 7.7 Connection Intelligence and ISP-Based Routing |
| F-1522 | Link-sharing-detection model | new | 24.3 Invisible AI (No User-Facing Text — the Highest-Value Tier) |
| F-1523 | Usage-anomaly detection assisting the delta-quarantine decision | new | 24.3 Invisible AI (No User-Facing Text — the Highest-Value Tier) |
| F-1524 | AI-based fraud risk scoring at signup, trial, and referral | new | 19.4 Fraud and Abuse Detection |
| F-1525 | Forecasting a tenant's total usage for capacity planning and traffic-wallet top-ups | new | 24.3 Invisible AI (No User-Facing Text — the Highest-Value Tier) |
| F-1526 | Natural-language questions over their own data ("how many people didn't renew last month,  | new | 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member) |
| F-1527 | Plan-layout suggestions based on actual consumption distribution across their users ⭐ | new | 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member) |
| F-1528 | Margin analysis and loss-making-plan alerts | new | 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member) |
| F-1529 | Campaign segmentation suggestions + writing copy in their own brand voice | new | 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member) |
| F-1530 | Ticket triage and reply drafting grounded in that same tenant's knowledge base | new | 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member) |
| F-1531 | Daily/weekly business summary for the reseller in the bot | new | 10.4 Full Bot Capabilities |
| F-1532 | AI onboarding and migration co-pilot | new | Migration, Import and Onboarding |
| F-1533 | Automatic translation of locale content for new languages, with mandatory human review | new | 1.8 Full Text Override by Tenant |
| F-1534 | AIProvider with ownershipType: tenant \| platform — from the first migration, like Panel.o | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1535 | A generic openai_compatible driver + capability discovery (tool-calling, JSON mode, contex | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1536 | API key in the vault with envelope encryption; never logged, never returned by any API, on | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1537 | A per-tenant outbound proxy (SOCKS5/HTTP) to reach the provider | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1538 | Tenant-side relay — a small worker on the tenant's own server that reads from a job queue  | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1539 | Model selection per task | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1540 | Always falls back to a template — error, timeout, invalid key, quota exhausted → the templ | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1541 | A hard time budget (default 3 seconds); after that, the template wins | new | 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI) |
| F-1542 | Output validation before sending: every number must exist in the input, length capped, no  | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1543 | Two modes: draft-with-approval (default) and automatic (enabled per message type) | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1544 | "Test connection" + status / lastErrorAt visible to the tenant | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1545 | Brand-tone prompt as data in locale-service, versioned | new | 1.8 Full Text Override by Tenant |
| F-1546 | Token accounting and usage caps per tenant and per task | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1547 | PII scrubbing before egress — phone numbers, emails, subscription tokens, IDs; disabling i | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1548 | A safety floor that can't be turned off: the attention budget, silence during outages, bot | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1549 | AI provider selection per message key, not one global key | new | 24.7 BYO-AI — Safety, Limits and Operations |
| F-1550 | Factory default: AI off, default templates on, product fully functional | new | 24.7 BYO-AI — Safety, Limits and Operations |
