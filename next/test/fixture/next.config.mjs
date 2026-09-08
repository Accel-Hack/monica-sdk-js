import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import("next").NextConfig} */
const config = {
  turbopack: {
    root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  },
};

export default config;
