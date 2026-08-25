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
];

export default config;
