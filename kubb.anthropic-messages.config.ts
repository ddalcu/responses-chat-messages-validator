import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginZod } from "@kubb/plugin-zod";

export default defineConfig({
  root: ".",
  input: {
    path: "./public/openapi/anthropic-messages.json",
  },
  output: {
    path: "./src/generated/kubb/anthropic-messages",
    clean: true,
  },
  plugins: [
    pluginOas({
      generators: [],
      discriminator: "inherit",
    }),
    pluginZod({
      output: {
        path: "./zod",
      },
    }),
  ],
});
