// Globals that come from outside our modules: the vendored libraries (loaded by <script> tags or
// by URL at runtime, see public/vendor) and the test hooks the suites set on globalThis.
// Only the parts Sidekick uses are declared.

declare global {
  // marked (public/vendor/marked.js)
  const marked: {
    use(options: { gfm?: boolean; breaks?: boolean }): void;
    parse(markdown: string): string;
  };
  // DOMPurify (public/vendor/purify.min.js)
  const DOMPurify: {
    sanitize(html: string, config?: { FORBID_TAGS?: string[]; FORBID_ATTR?: string[] }): string;
    addHook(hook: "afterSanitizeAttributes", fn: (node: Element) => void): void;
  };
  // KaTeX (public/vendor/katex.min.js)
  const katex: {
    renderToString(tex: string, options: { displayMode: boolean; throwOnError: boolean; output: string }): string;
  };
  // highlight.js (public/vendor/highlight.min.js)
  interface Hljs {
    getLanguage(name: string): unknown;
    highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
  }
  const hljs: Hljs;

  interface Window {
    hljs?: Hljs;
    // math.js and nerdamer: loaded by calc.ts on first use. Their APIs are large and untyped here.
    math?: any;
    nerdamer?: any;
    SymbolicResult?: any; // calc.ts: exact results with an approximate value
    // mammoth (Word documents): loaded by docs.ts on first use.
    mammoth?: { extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
  }

  // Set inside web pages by Sidekick's own page scripts (src/page) and webmcp-capture.js.
  interface Window {
    __skNext?: number; // next data-sk-id
    __skWebMCP?: { tools: Map<string, any> }; // site tools captured by webmcp-capture.js
  }
  // WebMCP (experimental): tools a site offers to AI agents.
  interface Navigator {
    modelContext?: any;
    modelContextTesting?: any;
  }

  // Test hooks: shorter time limits in the suites.
  var SK_STALL_MS: number | undefined;
  var SK_PAGE_MS: number | undefined;
  var SK_BATCH_PAUSE_MS: number | undefined; // tests: no human pause between applications
  var SK_ASK_WAIT_MS: number | undefined; // tests: how long a question may wait in a batch
  var SK_EXTRA_ATS: string[] | undefined; // tests: hosts that count as application systems (orchestrator/policy)
  var SK_WEB_MS: number | undefined;
}

export {};
