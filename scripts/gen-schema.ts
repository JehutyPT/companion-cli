/** Writes schema/description.schema.json from the writers' tables (npm run gen:schema). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderSchema, SCHEMA_FILE } from "../src/schema.ts";

mkdirSync(dirname(SCHEMA_FILE), { recursive: true });
writeFileSync(SCHEMA_FILE, renderSchema());
