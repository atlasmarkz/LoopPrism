// LoopPrism card in the OpenCode TUI sidebar (OpenCode 2.x TUI plugin, exported as "./tui").
// Everything with logic lives in ./tui/*.js (tested without OpenTUI); this file only draws.
import { For } from "solid-js";
import { createController } from "./tui/controller.js";

export default {
  id: "loopprism.sidebar",

  async setup(ctx: any) {
    const controller = createController(ctx);
    const t = ctx.theme.text;
    const color = (tone: string) =>
      tone === "title" ? t.base
        : tone === "muted" ? t.muted
        : tone === "warn" ? t.feedback.warning.base
        : tone === "error" ? t.feedback.error.base
        : t.base;

    const unregister = ctx.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => {
        controller.ensure(sessionID);
        return (
          <box flexDirection="column" flexShrink={0} paddingTop={1}>
            <For each={controller.card(sessionID).lines}>
              {(line: { text: string; tone: string }) => <text fg={color(line.tone)}>{line.text}</text>}
            </For>
          </box>
        );
      },
    });

    return () => {
      unregister();
      controller.dispose();
    };
  },
};
