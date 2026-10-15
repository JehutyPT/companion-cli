/**
 * Surface rows for the `kind: surface` tests (#32), shaped like Companion
 * 5.1's `SurfaceConfig` (`Surface/Config.ts`, `Surface/Handler.ts`): a
 * SKAARHOJ raw panel with transfer variables and a plugin setting, and a
 * Stream Deck with Companion's own keys and one integration key. The
 * fixture's own `fixture-surface` row is left as it is.
 */
import type { DatabaseSync } from "node:sqlite";

export const SKAARHOJ = "skaarhoj:SK_RAWPANEL_123";
export const STREAMDECK = "streamdeck:CL12345";

export const SKAARHOJ_ROW = {
  config: {
    brightness: 100,
    rotation: 0,
    xOffset: 0,
    yOffset: 0,
    groupId: null,
    transfer_input_hwc_12: "fx_label",
    transfer_input_hwc_13: "",
    transfer_output_hwc_40: "$(custom:fx_counter) > 0",
    plugin_cfg_sleepTimer: 0,
  },
  groupConfig: {
    name: "Auto group",
    last_page_id: "page-one-id",
    startup_page_id: "page-one-id",
    use_last_page: true,
  },
  enabled: true,
  name: "Desk panel",
  type: "SKAARHOJ Raw Panel",
  integrationType: "skaarhoj-rawpanel",
  gridSize: { rows: 4, columns: 8 },
};

export const STREAMDECK_ROW = {
  config: {
    brightness: 50,
    rotation: "surface90",
    xOffset: 1,
    yOffset: 0,
    groupId: null,
    canChangePage: true,
  },
  groupConfig: {
    name: "Auto group",
    last_page_id: "page-one-id",
    startup_page_id: "page-one-id",
    use_last_page: true,
  },
  enabled: true,
  name: "",
  type: "Elgato Stream Deck XL",
  integrationType: "elgato-streamdeck",
  gridSize: { rows: 4, columns: 8 },
};

/** Inserts `value` as the surface row `id`. */
export function insertSurface(
  db: DatabaseSync,
  id: string,
  value: unknown,
): void {
  db.prepare("INSERT INTO surfaces (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify(value),
  );
}

/** Seeds the SKAARHOJ and Stream Deck rows. */
export function seedSurfaces(db: DatabaseSync): void {
  insertSurface(db, SKAARHOJ, SKAARHOJ_ROW);
  insertSurface(db, STREAMDECK, STREAMDECK_ROW);
}

/** A connected surface in a `surfaces.watchSurfaces` `info` map. */
export function watchedSurfaces(
  id: string,
  configFields: unknown[],
  isConnected = true,
): Record<string, unknown> {
  return {
    [id]: {
      id,
      displayName: "Desk panel",
      isAutoGroup: true,
      surfaces: [
        {
          id,
          type: "SKAARHOJ Raw Panel",
          integrationType: "skaarhoj-rawpanel",
          name: "Desk panel",
          isConnected,
          configFields: isConnected ? configFields : [],
        },
      ],
    },
  };
}
