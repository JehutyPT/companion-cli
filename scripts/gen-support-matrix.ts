/** Writes docs/support-matrix.md from src/support-matrix.ts (npm run gen:support-matrix). */
import { writeFileSync } from "node:fs";
import {
  renderSupportMatrix,
  SUPPORT_MATRIX,
  SUPPORT_MATRIX_DOC,
} from "../src/support-matrix.ts";

writeFileSync(SUPPORT_MATRIX_DOC, renderSupportMatrix(SUPPORT_MATRIX));
