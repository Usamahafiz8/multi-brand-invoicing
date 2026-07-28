-- FR-PAY-005: per-brand payment method enablement. brand_settings already
-- carries an RLS policy keyed on brand_id (brand_settings_scope); it applies
-- to these columns automatically, no new policy needed.
ALTER TABLE brand_settings
  ADD COLUMN card_enabled       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN apple_pay_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN google_pay_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ach_enabled        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN check_enabled      BOOLEAN NOT NULL DEFAULT false;
