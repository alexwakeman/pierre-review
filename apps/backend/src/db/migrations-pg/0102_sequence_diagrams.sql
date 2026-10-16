-- SEQUENCE DIAGRAMS (2026-10-16). Twin of migrations/0115_sequence_diagrams.sql, where the contract lives.
CREATE TABLE IF NOT EXISTS "sequence_diagrams" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"pr_id" integer,
	"ticket_key" text,
	"fingerprint" text NOT NULL,
	"head_sha" text,
	"members" jsonb,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"title" text,
	"caption" text,
	"diagram_type" text,
	"source" text,
	"refusal" text,
	"error" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"output_tokens" integer,
	"num_turns" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sequence_diagrams_subject_fp" ON "sequence_diagrams" USING btree ("account_id","kind","subject","fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_diagrams_account_created" ON "sequence_diagrams" USING btree ("account_id","created_at");
