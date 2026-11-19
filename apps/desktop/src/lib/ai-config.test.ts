// Colocated tests for the ai.json read/write boundary. `chaos-invoke.ts` is
// mocked (no Tauri runtime here), so what is proven is which raw file contents
// may be written back and that an unreadable file refuses the write instead of
// being replaced by `{}` (which would drop every sibling section).

import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as m from "@markdraw/i18n";

const writes: string[] = [];
/** Call order the patterns are asserted on: `read` / `write` from the IPC mock,
 *  plus whatever a test's `afterValidate` records between them. */
const events: string[] = [];
let raw: string | null = null;

mock.module("./chaos-invoke.ts", () => ({
  invoke: async (cmd: string, args?: { contents?: string }) => {
    if (cmd === "ai_read_config") {
      events.push("read");
      return raw;
    }
    if (cmd === "ai_write_config") {
      events.push("write");
      writes.push(args?.contents ?? "");
      raw = args?.contents ?? null;
      return null;
    }
    throw new Error(`unexpected command: ${cmd}`);
  },
}));

const {
  AIUserConfigInvalidError,
  loadAIConfig,
  loadUserAIConfigForWrite,
  mutateUserAIConfig,
  applyMcpServerChange,
  saveAIConfig,
} = await import("./ai-config.ts");
const { withProviderSelection } = await import("./ai-provider-merge.ts");

const appSource = await Bun.file(new URL("../app.tsx", import.meta.url)).text();

/** Run the REAL app.tsx handlers (cut out of the source) against this file's
 *  IPC mock, so a gesture proven here is the one the app runs — not a copy of
 *  its logic kept in the test. Same extraction the review's probe used. */
function appHandlers(overrides: Record<string, unknown> = {}) {
  const names = [
    "saveAiProvider",
    "persistMcpServers",
    "reportAiConfigWriteFailure",
    "saveMcpServer",
    "removeMcpServer",
    "toggleMcpServer",
  ];
  const source = names
    .map((name) => {
      const asAsync = appSource.indexOf(`  async function ${name}(`);
      const at = asAsync >= 0 ? asAsync : appSource.indexOf(`  function ${name}(`);
      if (at < 0) throw new Error(`missing handler: ${name}`);
      const end = appSource.indexOf("\n  }\n", at);
      return appSource.slice(at, end + 4);
    })
    .join("\n");
  let current: { mcp?: unknown[] } = {};
  const stubs: Record<string, unknown> = {
    mutateUserAIConfig,
    applyMcpServerChange,
    loadAIConfig,
    withProviderSelection,
    AIUserConfigInvalidError,
    aiConfig: () => current,
    setAiConfig: (value: typeof current) => {
      current = value;
    },
    setCurrent: (value: typeof current) => {
      current = value;
    },
    getStoredAiModel: () => null,
    setStoredAiModel: () => {},
    reloadAiConfigAndProviders: async () => {
      current = await loadAIConfig();
    },
    showToast: () => {},
    refreshMcpStatuses: async () => {},
    connectMcpServer: async () => {},
    disconnectMcpServer: async () => {},
    ...overrides,
  };
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const app = new Function(
    ...Object.keys(stubs),
    `${body}\nreturn { ${names.join(",")}, setCurrent };`,
  )(...Object.values(stubs));
  return app as Record<string, (...args: never[]) => Promise<void>> & {
    setCurrent: (v: { mcp?: unknown[] }) => void;
  };
}

beforeEach(() => {
  writes.length = 0;
  events.length = 0;
  raw = null;
  globalThis.localStorage?.clear();
});

describe("loadUserAIConfigForWrite — boundary (may be written)", () => {
  it("arquivo ausente, vazio, só espaços e `{}` são config vazia", async () => {
    for (const contents of [null, "", "   \n\t ", "{}"]) {
      raw = contents;
      expect(await loadUserAIConfigForWrite()).toEqual({});
    }
    // A leitura nunca grava por conta própria.
    expect(writes).toEqual([]);
  });

  it("config válida volta inteira, com irmãos preservados (mcp, small_model)", async () => {
    raw = JSON.stringify({
      model: "opencode-go/glm-5.3-flash",
      small_model: "anthropic/claude-haiku-4-5",
      provider: { custom: { kind: "openai-compatible", name: "Custom" } },
      mcp: [{ id: "docs", transport: "http", url: "https://example.test/mcp", enabled: true }],
    });
    expect(await loadUserAIConfigForWrite()).toEqual({
      model: "opencode-go/glm-5.3-flash",
      small_model: "anthropic/claude-haiku-4-5",
      provider: { custom: { kind: "openai-compatible", name: "Custom" } },
      mcp: [{ id: "docs", transport: "http", url: "https://example.test/mcp", enabled: true }],
    });
  });
});

describe("loadUserAIConfigForWrite — hostile (refuses the write)", () => {
  const cases: Array<[string, string]> = [
    ["não é JSON", "{not json"],
    ["array (JSON de outro formato)", "[1,2,3]"],
    ["string JSON", '"config"'],
    ["número JSON", "42"],
    ["literal null", "null"],
    ["campo com tipo errado no topo", JSON.stringify({ model: 123 })],
    [
      "models com tipo errado dentro do provider",
      JSON.stringify({ provider: { custom: { kind: "openai", name: "Custom", models: "nope" } } }),
    ],
    // F1: o leitor tolerante descarta estas entradas; a gravação não pode,
    // porque a mescla sobre o config filtrado apagaria o servidor do arquivo.
    [
      "servidor MCP http sem url (descartado na leitura tolerante)",
      JSON.stringify({ mcp: [{ id: "manual", transport: "http", name: "Manual MCP" }] }),
    ],
    [
      "servidor MCP stdio sem command, ao lado de um válido",
      JSON.stringify({
        mcp: [
          { id: "docs", transport: "http", url: "https://example.test/mcp" },
          { id: "broken", transport: "stdio" },
        ],
      }),
    ],
    ["entrada MCP que não é objeto", JSON.stringify({ mcp: ["nope"] })],
  ];

  for (const [label, contents] of cases) {
    it(`${label}: lança o erro tipado com a mensagem i18n e não grava`, async () => {
      raw = contents;
      const err = await loadUserAIConfigForWrite().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AIUserConfigInvalidError);
      expect((err as Error).name).toBe("AIUserConfigInvalidError");
      expect((err as Error).message).toBe(m.settings_ai_config_invalid());
      expect((err as Error).message.trim()).not.toBe("");
      expect(writes).toEqual([]);
    });
  }

  it("a leitura tolerante continua aceitando o mesmo arquivo (controle do F1)", async () => {
    raw = JSON.stringify({
      model: "anthropic/claude-example",
      mcp: [{ id: "manual", transport: "http", name: "Manual MCP" }],
    });
    const config = await loadAIConfig();
    expect(config.model).toBe("anthropic/claude-example");
    expect(config.mcp).toEqual([]); // a entrada inválida é descartada SÓ na leitura
    expect(writes).toEqual([]);
  });

  it("a chave nova existe nas três locales; o pt-BR é o texto do contrato do brief", () => {
    expect(String(m.settings_ai_config_invalid({}, { locale: "pt-BR" }))).toBe(
      "O arquivo de configuração de IA tem um erro. Corrija ou apague o ai.json antes de salvar.",
    );
    // Sem a chave numa locale, o paraglide cairia no inglês: o texto exato
    // prova que en/es também a definem (paridade).
    expect(String(m.settings_ai_config_invalid({}, { locale: "en" }))).toBe(
      "The AI configuration file has an error. Fix or delete ai.json before saving.",
    );
    expect(String(m.settings_ai_config_invalid({}, { locale: "es" }))).toBe(
      "El archivo de configuración de IA tiene un error. Corrige o elimina ai.json antes de guardar.",
    );
  });

  it("arquivo enorme e inválido lança em vez de ser sobrescrito", async () => {
    raw = `{"provider": {"${"x".repeat(2 * 1024 * 1024)}":`;
    await expect(loadUserAIConfigForWrite()).rejects.toBeInstanceOf(AIUserConfigInvalidError);
    expect(writes).toEqual([]);
  });
});

describe("leitura para uso continua tolerante", () => {
  it("ai.json inválido não impede carregar: builtins respondem e nada é gravado", async () => {
    raw = "{not json";
    const config = await loadAIConfig();
    expect(Object.keys(config.provider).length).toBeGreaterThan(0);
    expect(config.provider.anthropic).toBeDefined();
    expect(writes).toEqual([]);
  });

  it("ai.json válido entra no merge (modelo manual sobre o builtin)", async () => {
    raw = JSON.stringify({
      provider: { anthropic: { models: { "claude-manual": { name: "Manual" } } } },
    });
    const config = await loadAIConfig();
    expect(config.provider.anthropic.models["claude-manual"]).toEqual({ name: "Manual" });
    // ...e o irmão manual do erro não é tocado pela leitura.
    expect(writes).toEqual([]);
  });
});

describe("saveAIConfig", () => {
  it("manda o JSON cru para ai_write_config", async () => {
    await saveAIConfig('{"model":"a/b"}');
    expect(writes).toEqual(['{"model":"a/b"}']);
  });
});

describe("mutateUserAIConfig — o caminho de gravação compartilhado", () => {
  it("recusa antes de qualquer efeito: sem leitura tolerante, sem escrita, sem afterValidate", async () => {
    raw = JSON.stringify({ mcp: [{ id: "manual", transport: "http" }] });
    let sideEffect = false;
    await expect(
      mutateUserAIConfig((user) => ({ ...user, model: "a/b" }), {
        afterValidate: () => {
          sideEffect = true;
        },
      }),
    ).rejects.toBeInstanceOf(AIUserConfigInvalidError);
    expect(sideEffect).toBe(false);
    expect(writes).toEqual([]);
    // Guarda o arquivo intacto (nem o próprio texto é reescrito).
    expect(JSON.parse(raw as string).mcp).toEqual([{ id: "manual", transport: "http" }]);
  });

  it("mescla sobre o estado atual: a edição feita durante o await do chaveiro sobrevive (F2)", async () => {
    const server = { id: "added", transport: "http", url: "https://example.test/mcp" };
    raw = JSON.stringify({ provider: {} });
    const written = await mutateUserAIConfig(
      (user) => ({
        ...user,
        provider: {
          ...(user.provider ?? {}),
          custom: { kind: "openai-compatible", name: "Custom" },
        },
      }),
      {
        // Uma gravação de MCP (ou uma edição manual) chega enquanto o
        // chaveiro respondia — depois da primeira leitura.
        afterValidate: async () => {
          events.push("concurrent-edit");
          raw = JSON.stringify({ ...JSON.parse(raw as string), mcp: [server] });
        },
      },
    );
    expect(written).toBe(true);
    const writtenJSON = JSON.parse(writes[0]);
    expect(writtenJSON.mcp).toEqual([server]);
    expect(writtenJSON.provider.custom).toEqual({ kind: "openai-compatible", name: "Custom" });
    // validação → efeito → NOVA leitura → escrita (a leitura antiga não é a base).
    expect(events).toEqual(["read", "concurrent-edit", "read", "write"]);
  });

  it("serializa as gravações: a segunda lê depois da primeira escrever (F2)", async () => {
    raw = "{}";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = mutateUserAIConfig((user) => ({ ...user, model: "a/b" }), {
      afterValidate: async () => {
        events.push("first-pending");
        await gate;
      },
    });
    const second = mutateUserAIConfig((user) => ({ ...user, small_model: "c/d" }));
    release();
    await Promise.all([first, second]);
    expect(JSON.parse(raw as string)).toEqual({ model: "a/b", small_model: "c/d" });
  });

  it("um efeito que falha não escreve nada", async () => {
    raw = JSON.stringify({ model: "a/b" });
    await expect(
      mutateUserAIConfig((user) => ({ ...user, small_model: "c/d" }), {
        afterValidate: async () => {
          throw new Error("keychain refused");
        },
      }),
    ).rejects.toThrow("keychain refused");
    expect(writes).toEqual([]);
    expect(raw).toBe(JSON.stringify({ model: "a/b" }));
  });

  it("`mutate` devolvendo null não grava e preserva o arquivo", async () => {
    raw = JSON.stringify({ model: "a/b" });
    expect(await mutateUserAIConfig(() => null)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("todo caminho de gravação do app.tsx passa pelo helper (F5)", async () => {
    // A recusa só vale se os chamadores usarem o guard: o teste acima cobre o
    // comportamento do helper, este garante que nenhum caminho leia/grave o
    // ai.json por fora dele.
    expect((appSource.match(/mutateUserAIConfig\(/g) ?? []).length).toBe(4);
    expect(appSource).not.toContain("loadUserAIConfigForWrite");
    expect(appSource).not.toContain("saveAIConfig");
    // Os três gestos de MCP passam a OPERAÇÃO por id, não uma lista calculada
    // fora da fila (F1): quem a aplica é `mutateUserAIConfig`.
    expect((appSource.match(/persistMcpServers\(\{ kind:/g) ?? []).length).toBe(3);
  });
});

describe("applyMcpServerChange — a lista é aplicada dentro da fila", () => {
  const a = { id: "a", transport: "http" as const, url: "https://a.test/mcp", enabled: true };
  const b = { id: "b", transport: "stdio" as const, command: "bunx", enabled: true };

  it("upsert edita preservando os cabeçalhos que o arquivo relido tem (F1)", () => {
    // O formulário não reenvia o token; o cabeçalho vem do arquivo como ele
    // está NA FILA (aqui já reescrito por uma edição concorrente).
    const result = applyMcpServerChange(
      { mcp: [{ ...a, headers: { Authorization: "Bearer from-file" } }] },
      { kind: "upsert", input: { id: "a", transport: "http", url: "https://a.test/mcp", enabled: false } },
    );
    expect(result?.server).toEqual({
      id: "a",
      transport: "http",
      url: "https://a.test/mcp",
      // Editar não muda o estado: vale o do arquivo relido.
      enabled: true,
      headers: { Authorization: "Bearer from-file" },
    });
    // Controle: um cabeçalho reenviado pelo formulário vence o do arquivo.
    expect(
      applyMcpServerChange(
        { mcp: [{ ...a, headers: { Authorization: "Bearer from-file" } }] },
        {
          kind: "upsert",
          input: { id: "a", transport: "http", url: "https://a.test/mcp", enabled: true, headers: { "X-New": "1" } },
        },
      )?.server?.headers,
    ).toEqual({ "X-New": "1" });
  });

  it("setEnabled e remove não aplicam num id ausente: null, sem escrita", async () => {
    raw = JSON.stringify({ mcp: [a] });
    // O servidor sumiu entre o gesto e a vez da fila (remoção concorrente).
    const written = await mutateUserAIConfig((user) => {
      const result = applyMcpServerChange(user, { kind: "setEnabled", id: "gone", enabled: false });
      return result?.config ?? null;
    });
    expect(written).toBe(false);
    expect(writes).toEqual([]);
    expect(applyMcpServerChange({ mcp: [a] }, { kind: "remove", id: "gone" })).toBeNull();
    // Controle: nos ids que existem a operação aplica.
    expect(applyMcpServerChange({ mcp: [a] }, { kind: "setEnabled", id: "a", enabled: false })?.server)
      .toEqual({ ...a, enabled: false });
    expect(applyMcpServerChange({ mcp: [a, b] }, { kind: "remove", id: "a" })?.config.mcp).toEqual([b]);
  });

  it("editar preserva um desligamento que entrou na fila antes da edição (re-revisão F1)", () => {
    // O formulário abriu com `a` ligado; um toggle para desligado gravou antes
    // da edição sair da fila. A edição renomeia sem religar.
    const result = applyMcpServerChange(
      { mcp: [{ ...a, enabled: false }] },
      { kind: "upsert", input: { id: "a", name: "Renomeado", transport: "http", url: "https://a.test/mcp", enabled: true } },
    );
    expect(result?.server).toEqual({ ...a, name: "Renomeado", enabled: false });
    // Controle: um servidor novo usa o `enabled` do formulário.
    expect(
      applyMcpServerChange({ mcp: [a] }, { kind: "upsert", input: { ...b, enabled: false } })?.server?.enabled,
    ).toBe(false);
  });

  it("setEnabled muda todas as entradas com o mesmo id (re-revisão F2)", () => {
    const twin = { ...a, url: "https://twin.test/mcp" };
    const result = applyMcpServerChange({ mcp: [a, b, twin] }, { kind: "setEnabled", id: "a", enabled: false });
    expect(result?.config.mcp).toEqual([{ ...a, enabled: false }, b, { ...twin, enabled: false }]);
    expect(result?.server).toEqual({ ...a, enabled: false });
  });

  it("lista vazia/ausente: upsert cria, remove não grava, irmãos preservados", () => {
    for (const config of [{}, { mcp: [] as typeof a[] }]) {
      const added = applyMcpServerChange(config, {
        kind: "upsert",
        input: { id: "a", transport: "http", url: "https://a.test/mcp", enabled: true },
      });
      expect(added?.config.mcp).toEqual([{ ...a }]);
      expect(added?.server).toEqual({ ...a });
      expect(applyMcpServerChange(config, { kind: "remove", id: "a" })).toBeNull();
    }
    const withSiblings = applyMcpServerChange(
      { model: "a/b", small_model: "c/d", provider: { p: { models: {} } }, mcp: [a] },
      { kind: "setEnabled", id: "a", enabled: false },
    );
    expect(withSiblings?.config).toEqual({
      model: "a/b",
      small_model: "c/d",
      provider: { p: { models: {} } },
      mcp: [{ ...a, enabled: false }],
    });
  });
});

describe("MCP dentro da fila (sonda da revisão) — F1", () => {
  const server = { id: "a", transport: "http", url: "https://example.test/mcp", enabled: true };

  it("dois toggles atrás de um chaveiro pendente persistem os dois (F1)", async () => {
    let openKeychain!: () => void;
    let keychainEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      openKeychain = resolve;
    });
    const started = new Promise<void>((resolve) => {
      keychainEntered = resolve;
    });
    const disconnected: string[] = [];
    const app = appHandlers({
      setApiKey: async () => {
        keychainEntered();
        await gate;
      },
      disconnectMcpServer: async (id: string) => {
        disconnected.push(id);
      },
    });
    raw = JSON.stringify({ mcp: [server, { ...server, id: "b" }] });
    app.setCurrent(await loadAIConfig());
    events.length = 0;
    const savingProvider = app.saveAiProvider({
      providerId: "anthropic",
      apiKey: "fixture",
      modelId: "claude-example",
    } as never);
    await started;
    // Os dois gestos chegam enquanto o chaveiro do save de provedor responde.
    const togglingA = app.toggleMcpServer("a" as never, false as never);
    await Bun.sleep(0);
    const togglingB = app.toggleMcpServer("b" as never, false as never);
    openKeychain();
    await Promise.all([savingProvider, togglingA, togglingB]);
    const persisted = (JSON.parse(raw as string).mcp as { id: string; enabled?: boolean }[]).map(
      ({ id, enabled }) => [id, enabled],
    );
    expect(persisted).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(disconnected).toEqual(["a", "b"]);
  });
});
