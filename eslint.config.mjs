import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: [
      // build / generated output
      ".next/**",
      "node_modules/**",
      "coverage/**",
      // local operational logs and sdd scratch, not product
      "logs/**",
      ".superpowers/**",
      // 3,500+ captured demo fixture files -- data, never lint
      "demo/fixtures/**",
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // always-current refs (a ref reassigned every render so async vendor
      // callbacks read the latest value, not a stale closure) are a
      // deliberate idiom in this codebase (GraphCanvas, Starfield).
      // react-hooks/refs polices React-Compiler compatibility; no compiler
      // adoption is planned here, so the rule is off as one documented
      // decision instead of an inline disable at every idiom site.
      "react-hooks/refs": "off",
    },
  },
];

export default config;
