// The Trapio architecture, re-expressed as a declarative DiagramSpec. This is
// the parity exercise: the Trapio prototype encoded the same architecture as
// ~185 lines of hand-placed boxes and hand-routed arrows at absolute
// coordinates; here it is content only — WHICH components, WHICH lane, WHICH
// edges — and the engine derives all geometry. It is intentionally NOT a pixel
// clone of the artisanal original (the engine lays it out its own way); it
// proves the spec→engine path produces the same architecture, validated clean.

import type { DiagramSpec } from "../spec.ts";

export const trapioSpec: DiagramSpec = {
  title: {
    text: "TRAPIO — Arquitetura (backend Go)",
    subtitle: "AppShell com enforcement por gateway (forwardAuth), multi-tenant, sobre Knative + Traefik + Turso + Keycloak.",
  },
  lanes: [
    { id: "edge", title: "Caminho da requisição", width: 300 },
    { id: "control", title: "Gate + control-plane", width: 320 },
    { id: "flow", title: "Fluxo de login", width: 260 },
  ],
  groups: [{ id: "cluster", title: "K3s @ Multipass — ns: traefik · kourier · knative · trapio · t-<tenant>", nodes: ["traefik", "kourier", "shell", "app", "turso", "gate", "keycloak", "panel", "registry", "secret"] }],
  nodes: [
    // edge lane — the request path, top→down
    { id: "browser", lane: "edge", title: "Browser do tenant", body: "https://t-<tenant>.trapio.home:8443/<app>\nSPA do shell: OIDC PKCE (S256) + iframes", style: { bg: "#f3f0ff" } },
    { id: "traefik", lane: "edge", title: "Traefik v3 — edge", body: "IngressRoute wildcard por tenant\nChain: identity-strip → shell-gate → rw-host", style: { bg: "#e7f5ff" } },
    { id: "kourier", lane: "edge", title: "Kourier (Envoy)", body: "ingress interno do Knative\nactivator: scale-from-zero", style: { bg: "#e7f5ff" } },
    { id: "shell", lane: "edge", title: "shell (ksvc)", body: "AppShell do tenant\nemoldura /_embed/<app>/", style: { bg: "#fff3bf" } },
    { id: "app", lane: "edge", title: "<app> (ksvc)", body: "revisions imutáveis · scale-to-zero\nconfia no X-Identity", style: { bg: "#fff3bf" } },
    { id: "turso", lane: "edge", title: "turso-server (Turso DB)", body: "engine = tursodb · 1 por namespace\nbranch por versão/fork", style: { bg: "#d3f9d8" } },
    // control lane — gate, auth, control-plane
    { id: "gate", lane: "control", title: "trapio-gate — forwardAuth /verify", body: "Decisão central (apps não configuram auth)\nInjeta X-Identity · anti-spoof", style: { bg: "#fff0f6", titleColor: "#a61e4d" } },
    { id: "keycloak", lane: "control", title: "Keycloak 26 (OIDC)", body: "1 realm por tenant · cliente PKCE 'shell'\nJWKS p/ validação", style: { bg: "#ffe3e3" } },
    { id: "panel", lane: "control", title: "trapio-panel (Go) — control-plane", body: "deploy · promote · rollback · split · fork\nprovisionTenant · catálogo · kubectl", style: { bg: "#f3f0ff" } },
    { id: "registry", lane: "control", title: "registry interno + kaniko", body: "build-deploy: kaniko de um git context\n→ push → deploya como ksvc", style: { bg: "#e9ecef" } },
    { id: "secret", lane: "control", title: "Secret compartilhado", body: "HMAC de sessão + embed-token\n(panel/gate/shell) · gate-key", style: { bg: "#fff9db" } },
    // flow lane — the login narrative
    { id: "login", lane: "flow", title: "Fluxo: login + AppShell", body: "1. GET /<app> → Traefik → gate\n2. shell: /_shell/me → OIDC PKCE\n3. callback → token server-side\n4. /_shell/embed-token (cookie HMAC)\n5. <iframe /_embed/<app>/> → gate valida", style: { bg: "#edf2ff", titleColor: "#1971c2" } },
  ],
  edges: [
    { from: "browser", to: "traefik", kind: "request" },
    { from: "traefik", to: "kourier", kind: "request", label: "após allow" },
    { from: "kourier", to: "shell", kind: "request" },
    { from: "shell", to: "app", kind: "request" },
    { from: "app", to: "turso", kind: "data", label: "tursodb sync" },
    { from: "traefik", to: "gate", kind: "auth", label: "forwardAuth /verify" },
    { from: "gate", to: "keycloak", kind: "auth" },
    { from: "panel", to: "registry", kind: "control", dash: true },
    { from: "panel", to: "app", kind: "control", dash: true, label: "kubectl" },
    { from: "gate", to: "login", kind: "request" },
  ],
};
