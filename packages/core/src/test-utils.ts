function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } satisfies Storage;
}

function installLocalStorageMock(): Storage {
  const mock = createLocalStorageMock();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: mock,
  });
  return mock;
}

interface FakeStyle {
  setProperty: (name: string, value: string) => void;
  getPropertyValue: (name: string) => string;
}

interface FakeDocumentElement {
  attributes: Map<string, string>;
  style: FakeStyle;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
}

function installDocumentMock(): FakeDocumentElement {
  const props = new Map<string, string>();
  const attributes = new Map<string, string>();
  const documentElement: FakeDocumentElement = {
    attributes,
    style: {
      setProperty(name, value) {
        props.set(name, value);
      },
      getPropertyValue(name) {
        return props.get(name) ?? "";
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement },
  });
  return documentElement;
}

export { installDocumentMock, installLocalStorageMock };
