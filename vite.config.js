import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const path = fileURLToPath(import.meta.url);
const root = join(dirname(path), "client");

export default {
  root,
  plugins: [react()],
  publicDir: join(dirname(path), "public"),
  build: {
    outDir: join(dirname(path), "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: join(root, "index.html")
      }
    }
  },
  ssr: {
    noExternal: ['react-feather']
  }
};
