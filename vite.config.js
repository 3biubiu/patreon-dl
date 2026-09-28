import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from "vite-plugin-svgr";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    react(),
    svgr(),
    // pdf.js resources the PDF reader loads at runtime. They go under
    // "assets" because that is one of the few paths the web server already
    // serves statically. Without the cMaps, CJK text in PDFs that use
    // CID-keyed fonts renders blank.
    viteStaticCopy({
      targets: [
        {
          src: "../../../node_modules/pdfjs-dist/cmaps",
          dest: "assets/pdfjs",
        },
        {
          src: "../../../node_modules/pdfjs-dist/standard_fonts",
          dest: "assets/pdfjs",
        },
        // ffmpeg's WebAssembly build, which the upload page uses to strip a
        // video to audio before sending it. Served from here rather than from
        // a CDN for the same reason as everything above: this application has
        // to work with no outside network.
        //
        // The ESM build, not the UMD one beside it. @ffmpeg/ffmpeg runs the
        // core inside a *module* worker, where `importScripts` does not exist,
        // so it loads the core with a dynamic `import()` and reads
        // `createFFmpegCore` off the default export. The UMD file has no
        // default export - importing it gets as far as "failed to import
        // ffmpeg-core.js" and no further.
        {
          src: "../../../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js",
          dest: "assets/ffmpeg",
        },
        {
          src: "../../../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm",
          dest: "assets/ffmpeg",
        }
      ]
    })
  ],
  root: 'src/browse/web',
  build: {
    outDir: '../../../dist/browse/web'
  },
  resolve: {
    alias: [
      { find: 'path', replacement: 'path-browserify' },
      // pdf.js's modern build leans on APIs Safari only gained in 17.4 / 18
      // (Promise.withResolvers, URL.parse, ...). react-pdf imports it at
      // module scope, so on iOS 17 the whole app failed to start - a white
      // screen. The legacy build carries its own polyfills. Exact match only,
      // so the cmaps and fonts copied above still come from the package root.
      { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' },
    ],
  },
});
