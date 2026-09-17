-- F-035-c — the `campaign.manage` permission, granted to `Admin` as
-- `coupon.manage` is (20260914000900). `prisma/seed.js` makes the same grant.
-- A tenant's Admin drafts its own tenant's campaigns; `notification-service`
-- confines it there (`campaigns/campaign-admin.service.ts`).
--
-- Rollback: delete the `role_permission` rows and the permission.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'campaign.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'campaign.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
