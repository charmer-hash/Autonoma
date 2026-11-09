ALTER TABLE "knowledge_documents" ADD COLUMN "pending_filename" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "pending_mime_type" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "pending_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "pending_sha256" text;