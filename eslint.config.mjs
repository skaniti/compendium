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
      // lib/graph/** is mid-port (batch-03) and frozen: it must not be
      // edited (including eslint-disable comments) until the graph flip
      // lands, so it is excluded at the config level instead.
      "lib/graph/**",
    ],
  },
  ...nextCoreWebVitals,
];

export default config;
