# GitHub Issues

## Repositório

- **Repo:** `zommehq/platform`
- **Gestão:** Issues com labels (sem GitHub Projects)

## Labels por app

| Label | Cor | Uso |
|-------|-----|-----|
| `skedly` | roxo | Skedly (scheduling) |
| `kashes` | amarelo | Kashes (finances) |
| `identity` | verde | Identity Service (auth) |
| `infra` | cinza | Infrastructure and operations |
| `ui` | rosa | UI components (@zomme/ui) |

Toda issue DEVE ter pelo menos uma label de app/escopo.

## Fluxo: Issue como fonte de verdade

### Planos de implementação

1. **Plan mode** — rascunho local em `.claude/plans/` (gitignored, temporário)
2. **Ao sair do plan mode** — criar issue no GitHub com o conteúdo do plano
3. **Implementar** — referenciar a issue nos commits quando relevante
4. **Fechar** — fechar a issue ao concluir

### Criação de issues

```bash
# Criar issue com label
gh issue create --repo zommehq/platform \
  --title "Titulo" \
  --body "..." \
  --label "skedly"

# Múltiplas labels
gh issue create --repo zommehq/platform \
  --title "Titulo" \
  --body "..." \
  --label "skedly" --label "infra"
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

- **Toda issue** deve ter label de app (`skedly`, `kashes`, `identity`, `infra`, `ui`)
- **Issues são a fonte de verdade** para planos e tarefas
- **Docs locais** (`.adoc`, `.md`) são para arquitetura e referência técnica do código
- **Nunca** duplicar conteúdo entre docs locais e issues
- **Sem GitHub Projects** — issues com labels são suficientes para o estágio atual
