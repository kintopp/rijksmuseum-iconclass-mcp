import { defineRailway, github, project, service, volume } from "railway/iac";

// The project is shared with other repos' services; the partial limits this file to its own.
export const partial = "rijksmuseum-iconclass-mcp";

export default defineRailway(() => {
  // Holds the main DB. Dropping this mount from the service detaches it.
  const rijksmuseumIconclassMcpVolume = volume("rijksmuseum-iconclass-mcp-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 10000 });
  const mcp = service("rijksmuseum-iconclass-mcp", {
    source: github("kintopp/rijksmuseum-iconclass-mcp", { branch: "main", checkSuites: false }),
    build: { buildCommand: "npm run build", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["src/**", "package.json", "package-lock.json", "tsconfig.json"] },
    start: "node dist/index.js --http",
    healthcheck: "/health",
    healthcheckTimeout: 360,
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { limitOverride: { containers: { cpu: 24, memoryBytes: 3000000000 } }, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3 },
    volumeMounts: { "/data": rijksmuseumIconclassMcpVolume },
  });
  return project("endearing-warmth", {
    variables: { managed: false },
    resources: [mcp, rijksmuseumIconclassMcpVolume],
  });
});
