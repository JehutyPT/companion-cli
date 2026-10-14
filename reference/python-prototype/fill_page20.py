#!/usr/bin/env python3
"""Fill page 20 of a Companion 5.1 db.sqlite with a SKAARHOJ Raw Panel test page.

Usage: python3 fill_page20.py /path/to/db.sqlite

Companion must be STOPPED while this runs against its live database: Companion
keeps pages/controls/custom variables in memory and rewrites them, so edits made
while it runs are overwritten (or worse, mixed). Take a backup first.

Idempotent. Touches only:
  - pages row id '20' (keeps its id, sets name and controls map)
  - controls rows referenced by page 20 (old ones deleted, new ones inserted)
  - custom_variables rows sk_presses, sk_last, sk_enc1..8, sk_iris, sk_focus
Shapes copied from controls/custom_variables in a real 5.1 database and from
Companion 5.1.0 main.js (internal action/feedback definitions).
"""

import json
import secrets
import sqlite3
import sys

PAGE_ID = "20"
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"


def nanoid():
    return "".join(secrets.choice(ALPHABET) for _ in range(21))


def prop(value):
    return {"value": value, "isExpression": False}


def rgb(hexstr):
    return int(hexstr, 16)


# Companion stores line breaks in button text as a literal backslash-n.
NL = "\\n"

# ---- style layers (copied from an existing button-layered control) ----

def layers(text, bg, fg=0xFFFFFF):
    common = lambda: {
        "enabled": prop(True), "opacity": prop(100), "x": prop(0), "y": prop(0),
        "width": prop(100), "height": prop(100), "rotation": prop(0),
    }
    return [
        {"id": "canvas", "name": "Canvas", "usage": "auto", "type": "canvas",
         "decoration": prop("default"), "showStatusIcons": prop("default")},
        {"id": "box0", "name": "Background", "usage": "auto", "type": "box", **common(),
         "color": prop(bg), "borderWidth": prop(0), "borderColor": prop(0),
         "borderPosition": prop("inside"), "pinnedProperties": ["color"]},
        {"id": "image0", "name": "Image", "usage": "auto", "type": "image", **common(),
         "base64Image": prop(None), "halign": prop("center"), "valign": prop("center"),
         "fillMode": prop("fit"), "pinnedProperties": ["base64Image", "halign", "valign"]},
        {"id": "text0", "name": "Text", "usage": "auto", "type": "text", **common(),
         "text": {"isExpression": False, "value": text}, "color": prop(fg),
         "halign": prop("center"), "valign": prop("center"), "fontsize": prop(100),
         "fontsizeAllowShrink": prop(True), "font": prop("companion-sans"),
         "outlineColor": prop(4278190080),
         "pinnedProperties": ["text", "fontsize", "fontsizeAllowShrink", "color", "halign", "valign"]},
    ]


# ---- actions (internal module, Companion 5.1) ----

def set_var(name, value, expression=False):
    return {"type": "action", "id": nanoid(), "definitionId": "custom_variable_set_value",
            "connectionId": "internal",
            "options": {"name": prop(name), "value": {"isExpression": expression, "value": value}}}


def add_var(name, delta):
    op = "+" if delta >= 0 else "-"
    return set_var(name, f"$(this:current) {op} {abs(delta)}", expression=True)


def press_actions(label):
    return [add_var("sk_presses", 1), set_var("sk_last", label)]


def step(down=(), up=(), left=(), right=()):
    return {"action_sets": {"down": list(down), "up": list(up),
                            "rotate_left": list(left), "rotate_right": list(right)},
            "options": {"runWhileHeld": []}}


def control(text, bg, fg=0xFFFFFF, steps=None, rotary=False, feedbacks=None):
    return {
        "type": "button-layered",
        "options": {"stepProgression": "auto", "stepExpression": "", "rotaryActions": rotary,
                    "canModifyStyleInApis": True, "notes": ""},
        "localVariables": [],
        "steps": steps or {"0": step()},
        "feedbacks": feedbacks or [],
        "style": {"layers": layers(text, bg, fg)},
    }


def fg_for(bg):
    r, g, b = (bg >> 16) & 255, (bg >> 8) & 255, bg & 255
    return 0x000000 if (r * 299 + g * 587 + b * 114) / 1000 > 140 else 0xFFFFFF


def button(name, hwc, bg, text=None):
    text = text if text is not None else f"{name}{NL}#{hwc}"
    return control(text, bg, fg_for(bg), steps={"0": step(down=press_actions(name))})


def rotary(name, hwc, var, bg, text):
    s = step(down=[set_var(var, "0"), set_var("sk_last", f"{name} push")],
             left=[add_var(var, -1)], right=[add_var(var, 1)])
    return control(text, bg, fg_for(bg), steps={"0": s}, rotary=True)


def latch(name):
    # Two steps; stepProgression auto advances on press. Base style = step 1 (red OFF);
    # bank_current_step feedback (shape copied from DB) overrides to green ON on step 2.
    fb = {"type": "feedback", "id": nanoid(), "definitionId": "bank_current_step",
          "connectionId": "internal",
          "options": {"step": prop(2), "location": prop("$(this:location)")},
          "isInverted": prop(False),
          "styleOverrides": [
              {"overrideId": nanoid(), "elementId": "box0", "elementProperty": "color",
               "override": prop(rgb("00FF00"))},
              {"overrideId": nanoid(), "elementId": "text0", "elementProperty": "color",
               "override": prop(0x000000)},
              {"overrideId": nanoid(), "elementId": "text0", "elementProperty": "text",
               "override": prop("ON")},
          ],
          "children": {}}
    steps = {"0": step(down=press_actions(name)), "1": step(down=press_actions(name))}
    return control("OFF", rgb("FF0000"), 0xFFFFFF, steps=steps, feedbacks=[fb])


CYCLE = ["FF0000", "00FF00", "0000FF", "FFFF00", "00FFFF", "FF00FF",
         "FFFFFF", "FF8000", "8000FF", "FF80C0", "808080", "800000"]
ENC_BG = ["400000", "004000", "000060", "404000", "004040", "400040", "303030", "603000"]


def build_layout():
    """Return {(row, col): control_json}."""
    L = {}
    L[(0, 0)] = control(f"Last{NL}$(custom:sk_last){NL}$(custom:sk_presses)", rgb("000080"))
    L[(0, 1)] = control(f"Iris $(custom:sk_iris){NL}Focus $(custom:sk_focus)", rgb("202020"))
    L[(0, 2)] = control("$(internal:time_hms)", rgb("202020"))
    for n in range(1, 9):
        hwc = 45 + n
        L[(0, 2 + n)] = rotary(f"E{n}", hwc, f"sk_enc{n}", rgb(ENC_BG[n - 1]),
                               f"E{n} #{hwc}{NL}$(custom:sk_enc{n})")
    L[(0, 16)] = button("JB", 63, rgb("000000"), text="JB")
    # S1..S4 four-way buttons (cycle colours), S5..S9 text tests
    for n in range(1, 5):
        L[(1, 4 + n)] = button(f"S{n}", 36 + n, rgb(CYCLE[(n - 1) % 12]))
    L[(1, 9)] = button("S5", 41, rgb(CYCLE[4]), text="ABCDEFGHIJKLMNOP")
    L[(1, 10)] = button("S6", 42, rgb(CYCLE[5]), text=f"Line one{NL}Line two")
    L[(1, 11)] = button("S7", 43, rgb(CYCLE[6]), text=f"One{NL}Two{NL}Three")
    L[(1, 12)] = button("S8", 44, rgb("000000"), text="No colour")
    L[(1, 13)] = latch("S9")
    L[(2, 4)] = rotary("IRIS", 57, "sk_iris", rgb("000000"), "IRIS")
    L[(3, 3)] = rotary("FOCUS", 59, "sk_focus", rgb("000000"), "FOCUS")
    for n in range(1, 13):
        L[(2, 4 + n)] = button(f"X{n}", 12 + n, rgb(CYCLE[(n - 1) % 12]))
        L[(3, 4 + n)] = button(f"C{n}", n, rgb(CYCLE[(n - 1) % 12]))
    return L


VARIABLES = ([("sk_presses", 0), ("sk_last", "")]
             + [(f"sk_enc{n}", 0) for n in range(1, 9)]
             + [("sk_iris", 0), ("sk_focus", 0)])


def main(db_path):
    con = sqlite3.connect(db_path, isolation_level=None)
    try:
        cur = con.cursor()
        row = cur.execute("SELECT value FROM pages WHERE id=?", (PAGE_ID,)).fetchone()
        if row is None:
            sys.exit(f"pages row {PAGE_ID!r} not found")
        page = json.loads(row[0])

        cur.execute("BEGIN")
        # Remove controls currently placed on page 20 (from a previous run, or whatever is there).
        old = [cid for cols in page.get("controls", {}).values() for cid in cols.values()]
        for cid in old:
            cur.execute("DELETE FROM controls WHERE id=?", (cid,))

        grid = {str(r): {} for r in range(4)}
        for (r, c), ctl in sorted(build_layout().items()):
            cid = f"bank:{nanoid()}"
            cur.execute("INSERT INTO controls (id, value) VALUES (?, ?)",
                        (cid, json.dumps(ctl, separators=(",", ":"))))
            grid[str(r)][str(c)] = cid

        page = {"name": "SKAARHOJ TEST", "controls": grid, "id": page["id"]}
        cur.execute("UPDATE pages SET value=? WHERE id=?",
                    (json.dumps(page, separators=(",", ":")), PAGE_ID))

        names = [n for n, _ in VARIABLES]
        others = cur.execute(
            f"SELECT MAX(CAST(json_extract(value,'$.sortOrder') AS INTEGER)) FROM custom_variables "
            f"WHERE id NOT IN ({','.join('?' * len(names))})", names).fetchone()[0]
        base = (others if others is not None else -1) + 1
        for i, (name, default) in enumerate(VARIABLES):
            existing = cur.execute("SELECT value FROM custom_variables WHERE id=?", (name,)).fetchone()
            order = json.loads(existing[0]).get("sortOrder", base + i) if existing else base + i
            val = {"description": "SKAARHOJ test page", "defaultValue": default,
                   "persistCurrentValue": False, "sortOrder": order}
            cur.execute("INSERT OR REPLACE INTO custom_variables (id, value) VALUES (?, ?)",
                        (name, json.dumps(val, separators=(",", ":"))))
        con.commit()
        print(f"page {PAGE_ID}: removed {len(old)} old controls, wrote "
              f"{sum(len(v) for v in grid.values())} controls and {len(VARIABLES)} custom variables")
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
