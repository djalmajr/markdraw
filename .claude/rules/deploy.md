# Deploy & Pipelines

## Repositórios

- **Source:** `djalmajr/asciimark` (privado)
- **Public:** `djalmajr/asciimark-releases` (distribuição pública: releases + GitHub Pages)

## Pipelines

### Desktop App (`build-desktop.yml`)

**Trigger:** push de tags `v*` ou `workflow_dispatch`

**Fluxo:**
1. Build multiplataforma (macOS arm64/x64, Ubuntu, Windows)
2. Upload de artefatos
3. Publica release no repo público com assets normalizados e release notes geradas

**Para fazer release:**
```bash
bun run bump:app <version>   # Atualiza versão nos 3 arquivos
git add -u && git commit -m "chore: bump version to <version>"
git tag v<version>
git push origin main --tags  # Tag dispara a pipeline
```

**Arquivos de versão (devem estar em sync com a tag):**
- `apps/desktop/package.json` → `"version"`
- `apps/desktop/src-tauri/tauri.conf.json` → `"version"`
- `apps/desktop/src-tauri/Cargo.toml` → `version`

### Site (`deploy-site.yml`)

**Trigger:** push em `main` com mudanças em `apps/site/**`, `packages/ui/src/components/ui/**` ou `packages/core/src/**`, ou `workflow_dispatch`

**Fluxo:** Build → copia `index.html` como `404.html` (SPA fallback) → deploy para GitHub Pages no repo público

**Deploy é automático** ao mergear em `main` com mudanças nos paths acima.

## Secrets

- `PUBLIC_DIST_TOKEN`: PAT com write access ao repo `djalmajr/asciimark-releases`. Usado por ambas as pipelines.

## Regras

- **Nunca** disparar pipelines manualmente sem pedir confirmação ao usuário
- **Nunca** criar/modificar tags sem pedir confirmação
- **Nunca** modificar workflows sem pedir confirmação
- Antes de release desktop: garantir versão em sync via `bun run bump:app <version>`
- Antes de release extension: garantir versão em sync via `bun run bump:ext <version>`
- **Nunca** editar arquivos de versão manualmente — sempre usar os scripts de bump
