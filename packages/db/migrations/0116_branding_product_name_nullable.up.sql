-- Remove the hardcoded 'TaskFlow' default from branding.product_name.
-- The env var PRODUCT_NAME now takes precedence when the column is NULL.
ALTER TABLE platform.branding
  ALTER COLUMN product_name DROP DEFAULT,
  ALTER COLUMN product_name DROP NOT NULL;

-- Clear existing default so the env var takes effect for new deployments.
UPDATE platform.branding SET product_name = NULL WHERE product_name = 'TaskFlow';
