-- Restore the NOT NULL constraint and 'TaskFlow' default.
UPDATE platform.branding SET product_name = 'TaskFlow' WHERE product_name IS NULL;
ALTER TABLE platform.branding
  ALTER COLUMN product_name SET NOT NULL,
  ALTER COLUMN product_name SET DEFAULT 'TaskFlow';
