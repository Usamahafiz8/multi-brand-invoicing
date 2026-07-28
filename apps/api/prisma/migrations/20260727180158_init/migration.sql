-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MERCHANT_OWNER', 'MERCHANT_ADMIN', 'BRAND_ADMIN', 'FINANCE_USER', 'SALES_USER', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "BrandStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('BUSINESS', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'PENDING_PAYMENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'WALLET', 'ACH', 'CHECK', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PROCESSING', 'SETTLED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('ZOHO_BOOKS', 'NUMBERS_GATEWAY', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'UNHEALTHY', 'REVOKED');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('PUSH', 'PULL');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "SyncErrorClass" AS ENUM ('TRANSIENT', 'AUTHENTICATION', 'VALIDATION', 'CONFLICT', 'PERMANENT');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "merchant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "address" JSONB,
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "totp_secret" TEXT,
    "last_login_at" TIMESTAMP(3),
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_brand_assignment" (
    "user_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_brand_assignment_pkey" PRIMARY KEY ("user_id","brand_id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "source_ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "sales_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "mailing_address" JSONB,
    "billing_address" JSONB,
    "tax_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "theme_color" TEXT NOT NULL DEFAULT '#2D6A6A',
    "logo_key" TEXT,
    "status" "BrandStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_settings" (
    "brand_id" UUID NOT NULL,
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV',
    "next_sequence" INTEGER NOT NULL DEFAULT 1,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "late_fee_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "default_tax_rate_id" UUID,
    "card_fee_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "partial_payment_enabled" BOOLEAN NOT NULL DEFAULT false,
    "reminder_schedule" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_settings_pkey" PRIMARY KEY ("brand_id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "zoho_tax_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "type" "CustomerType" NOT NULL DEFAULT 'BUSINESS',
    "salutation" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "company_name" TEXT,
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "billing_address" JSONB,
    "shipping_address" JSONB,
    "zoho_contact_id" TEXT,
    "notes" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_rate_bp_applied" INTEGER NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "card_fee_rate_bp_applied" INTEGER NOT NULL DEFAULT 0,
    "card_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "public_token" TEXT NOT NULL,
    "public_token_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "internal_notes" TEXT,
    "zoho_invoice_id" TEXT,
    "tax_rate_id" UUID,
    "issued_at" TIMESTAMP(3),
    "first_viewed_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "previous_status" "InvoiceStatus",
    "overdue" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_item" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "item_name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "gateway_reference" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "last_event_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "settled_at" TIMESTAMP(3),
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "zoho_payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_event" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" "InvoiceStatus",
    "to_status" "InvoiceStatus",
    "actor" TEXT NOT NULL,
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_submission" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "front_image_key" TEXT NOT NULL,
    "back_image_key" TEXT NOT NULL,
    "customer_note" TEXT,
    "status" "CheckStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewed_by" UUID,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "check_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "encrypted_credentials" TEXT,
    "config" JSONB,
    "last_sync_at" TIMESTAMP(3),
    "health" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_job" (
    "id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_class" "SyncErrorClass",
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "brand_id" UUID,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "source_ip" TEXT,
    "outcome" TEXT NOT NULL,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_merchant_id_idx" ON "user"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_merchant_id_email_key" ON "user"("merchant_id", "email");

-- CreateIndex
CREATE INDEX "user_brand_assignment_brand_id_idx" ON "user_brand_assignment"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "brand_merchant_id_idx" ON "brand"("merchant_id");

-- CreateIndex
CREATE INDEX "tax_rate_brand_id_idx" ON "tax_rate"("brand_id");

-- CreateIndex
CREATE INDEX "customer_brand_id_idx" ON "customer"("brand_id");

-- CreateIndex
CREATE INDEX "customer_brand_id_status_idx" ON "customer"("brand_id", "status");

-- CreateIndex
CREATE INDEX "customer_zoho_contact_id_idx" ON "customer"("zoho_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_public_token_key" ON "invoice"("public_token");

-- CreateIndex
CREATE INDEX "invoice_brand_id_status_idx" ON "invoice"("brand_id", "status");

-- CreateIndex
CREATE INDEX "invoice_brand_id_due_date_idx" ON "invoice"("brand_id", "due_date");

-- CreateIndex
CREATE INDEX "invoice_customer_id_idx" ON "invoice"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_brand_id_number_key" ON "invoice"("brand_id", "number");

-- CreateIndex
CREATE INDEX "line_item_invoice_id_idx" ON "line_item"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "line_item_invoice_id_position_key" ON "line_item"("invoice_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_reference_key" ON "payment"("gateway_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_key_key" ON "payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_invoice_id_idx" ON "payment"("invoice_id");

-- CreateIndex
CREATE INDEX "payment_brand_id_status_idx" ON "payment"("brand_id", "status");

-- CreateIndex
CREATE INDEX "invoice_event_invoice_id_occurred_at_idx" ON "invoice_event"("invoice_id", "occurred_at");

-- CreateIndex
CREATE INDEX "check_submission_brand_id_status_idx" ON "check_submission"("brand_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_brand_id_provider_key" ON "integration_connection"("brand_id", "provider");

-- CreateIndex
CREATE INDEX "sync_job_brand_id_status_idx" ON "sync_job"("brand_id", "status");

-- CreateIndex
CREATE INDEX "sync_job_status_next_attempt_at_idx" ON "sync_job"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "audit_log_merchant_id_occurred_at_idx" ON "audit_log"("merchant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_brand_id_occurred_at_idx" ON "audit_log"("brand_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_brand_assignment" ADD CONSTRAINT "user_brand_assignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_brand_assignment" ADD CONSTRAINT "user_brand_assignment_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_settings" ADD CONSTRAINT "brand_settings_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_item" ADD CONSTRAINT "line_item_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_event" ADD CONSTRAINT "invoice_event_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_submission" ADD CONSTRAINT "check_submission_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_submission" ADD CONSTRAINT "check_submission_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
