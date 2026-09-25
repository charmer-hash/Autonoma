CREATE INDEX "messages_session_id_id_idx" ON "messages" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "sessions_owner_id_updated_at_idx" ON "sessions" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX "messages_session_id_idx";--> statement-breakpoint
DROP INDEX "sessions_owner_id_idx";
