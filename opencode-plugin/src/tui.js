// GENERATED from tui.tsx by scripts/build-tui.cjs. Do not edit.
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
// LoopPrism card in the OpenCode TUI sidebar (OpenCode 2.x TUI plugin, exported as "./tui").
// Everything with logic lives in ./tui/*.js (tested without OpenTUI); this file only draws.
import { For } from "solid-js";
import { createController } from "./tui/controller.js";
export default {
  id: "loopprism.sidebar",
  async setup(ctx) {
    const controller = createController(ctx);
    const t = ctx.theme.text;
    const color = tone => tone === "title" ? t.base : tone === "muted" ? t.muted : tone === "warn" ? t.feedback.warning.base : tone === "error" ? t.feedback.error.base : t.base;
    const unregister = ctx.ui.slot({
      append: "sidebar.content",
      render: ({
        sessionID
      }) => {
        controller.ensure(sessionID);
        return (() => {
          var _el$ = _$createElement("box");
          _$setProp(_el$, "flexDirection", "column");
          _$setProp(_el$, "flexShrink", 0);
          _$setProp(_el$, "paddingTop", 1);
          _$insert(_el$, _$createComponent(For, {
            get each() {
              return controller.card(sessionID).lines;
            },
            children: line => (() => {
              var _el$2 = _$createElement("text");
              _$insert(_el$2, () => line.text);
              _$effect(_$p => _$setProp(_el$2, "fg", color(line.tone), _$p));
              return _el$2;
            })()
          }));
          return _el$;
        })();
      }
    });
    return () => {
      unregister();
      controller.dispose();
    };
  }
};
