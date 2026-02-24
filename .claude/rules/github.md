# GitHub Issues

## Repositórios

- **Source (privado):** `djalmajr/asciimark` — issues internas, desenvolvimento
- **Public:** `djalmajr/asciimark-releases` — issues do público, releases, site

## Labels

| Label | Cor | Uso |
|-------|-----|-----|
| `desktop` | azul | Desktop app (Tauri) |
| `site` | verde | Site público |
| `core` | roxo | Pacote core |
| `ui` | rosa | UI components |
| `infra` | cinza | CI/CD, build, deploy |

Toda issue DEVE ter pelo menos uma label de escopo.

## Fluxo: Issue como fonte de verdade

### Planos de implementação

1. **Plan mode** — rascunho local em `.claude/plans/` (gitignored, temporário)
2. **Ao sair do plan mode** — criar issue no GitHub com o conteúdo do plano
3. **Implementar** — referenciar a issue nos commits quando relevante
4. **Fechar** — fechar a issue ao concluir

### Criação de issues

```bash
# Issue interna (desenvolvimento)
gh issue create --repo djalmajr/asciimark \
  --title "Titulo" \
  --body "..." \
  --label "desktop"

# Múltiplas labels
gh issue create --repo djalmajr/asciimark \
  --title "Titulo" \
  --body "..." \
  --label "desktop" --label "infra"
```

### Formato da issue de plano

```markdown
## Contexto
(por que essa mudança é necessária)

## Arquivos
(criar / modificar / remover)

## Detalhamento
(schemas, endpoints, componentes, etc.)

## Tarefas
- [ ] Item 1
- [ ] Item 2

## Verificação
(como testar)
```

## Regras

- **Toda issue** deve ter label de escopo (`desktop`, `site`, `core`, `ui`, `infra`)
- **Issues são a fonte de verdade** para planos e tarefas
- **Docs locais** (`.adoc`, `.md`) são para arquitetura e referência técnica do código
- **Nunca** duplicar conteúdo entre docs locais e issues
- **Sem GitHub Projects** — issues com labels são suficientes para o estágio atual
