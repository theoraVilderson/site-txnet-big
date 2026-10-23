-- F-1601-b2 (ADR-0160 decisions 7-8): a config adopted in place is a User
-- Manager user whose login stays the router's. `adoptedProfile` is the profile
-- it held at import and `adoptedLabel` its comment: a hand back puts both
-- back. Non-null `adoptedProfile` is also what tells the pass never to write
-- the password. `handBack` makes an absent config hand the user back instead
-- of deleting it (a rollback); a normal end deletes, as for any config.
ALTER TABLE network.config
  ADD COLUMN "adoptedProfile" text,
  ADD COLUMN "adoptedLabel"   text,
  ADD COLUMN "handBack"       boolean NOT NULL DEFAULT false;

ALTER TABLE network.config
  ADD CONSTRAINT config_hand_back_is_an_adopted_login
  CHECK (NOT "handBack" OR "adoptedProfile" IS NOT NULL);
