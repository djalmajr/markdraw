// packages/frame/src/constants.ts
var MessageEvent = {
  INIT: "__INIT__",
  READY: "__READY__",
  PROPS_UPDATE: "__PROPS_UPDATE__",
  EVENT: "__EVENT__",
  CUSTOM_EVENT: "__CUSTOM_EVENT__",
  FUNCTION_CALL: "__FUNCTION_CALL__",
  FUNCTION_RESPONSE: "__FUNCTION_RESPONSE__",
  FUNCTION_RELEASE: "__FUNCTION_RELEASE__",
  FUNCTION_RELEASE_BATCH: "__FUNCTION_RELEASE_BATCH__"
};
var VALID_MESSAGE_TYPES = new Set(Object.values(MessageEvent));
var FUNCTION_CALL_TIMEOUT = 5000;
var FUNCTION_REGISTRY_MAX_SIZE = 1000;

// node_modules/.bun/flatted@3.3.3/node_modules/flatted/esm/index.js
var { parse: $parse, stringify: $stringify } = JSON;
var { keys } = Object;
var Primitive = String;
var primitive = "string";
var ignore = {};
var object = "object";
var noop = (_, value) => value;
var primitives = (value) => value instanceof Primitive ? Primitive(value) : value;
var Primitives = (_, value) => typeof value === primitive ? new Primitive(value) : value;
var revive = (input, parsed, output, $) => {
  const lazy = [];
  for (let ke = keys(output), { length } = ke, y = 0;y < length; y++) {
    const k = ke[y];
    const value = output[k];
    if (value instanceof Primitive) {
      const tmp = input[value];
      if (typeof tmp === object && !parsed.has(tmp)) {
        parsed.add(tmp);
        output[k] = ignore;
        lazy.push({ k, a: [input, parsed, tmp, $] });
      } else
        output[k] = $.call(output, k, tmp);
    } else if (output[k] !== ignore)
      output[k] = $.call(output, k, value);
  }
  for (let { length } = lazy, i = 0;i < length; i++) {
    const { k, a } = lazy[i];
    output[k] = $.call(output, k, revive.apply(null, a));
  }
  return output;
};
var set = (known, input, value) => {
  const index = Primitive(input.push(value) - 1);
  known.set(value, index);
  return index;
};
var parse = (text, reviver) => {
  const input = $parse(text, Primitives).map(primitives);
  const value = input[0];
  const $ = reviver || noop;
  const tmp = typeof value === object && value ? revive(input, new Set, value, $) : value;
  return $.call({ "": tmp }, "", tmp);
};
var stringify = (value, replacer, space) => {
  const $ = replacer && typeof replacer === object ? (k, v) => k === "" || -1 < replacer.indexOf(k) ? v : undefined : replacer || noop;
  const known = new Map;
  const input = [];
  const output = [];
  let i = +set(known, input, $.call({ "": value }, "", value));
  let firstRun = !i;
  while (i < input.length) {
    firstRun = true;
    output[i] = $stringify(input[i++], replace, space);
  }
  return "[" + output.join(",") + "]";
  function replace(key, value2) {
    if (firstRun) {
      firstRun = !firstRun;
      return value2;
    }
    const after = $.call(this, key, value2);
    switch (typeof after) {
      case object:
        if (after === null)
          return after;
      case primitive:
        return known.get(after) || set(known, input, after);
    }
    return after;
  }
};

// packages/frame/src/helpers/serialization.ts
function isTransferable(value) {
  if (typeof value !== "object" || value === null)
    return false;
  return value instanceof ArrayBuffer || value instanceof MessagePort || typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap || typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas || typeof ReadableStream !== "undefined" && value instanceof ReadableStream || typeof WritableStream !== "undefined" && value instanceof WritableStream || typeof TransformStream !== "undefined" && value instanceof TransformStream;
}
function serializeValue(value, functionRegistry, trackedFunctions, transferables = []) {
  if (isTransferable(value)) {
    if (!transferables.includes(value)) {
      transferables.push(value);
    }
    return { serialized: value, transferables };
  }
  const replacer = (_key, value2) => {
    if (value2 === null || value2 === undefined) {
      return value2;
    }
    if (typeof value2 !== "object" && typeof value2 !== "function") {
      return value2;
    }
    if (typeof value2 === "function") {
      if (functionRegistry.size >= FUNCTION_REGISTRY_MAX_SIZE) {
        throw new Error(`[serialization] Function registry limit (${FUNCTION_REGISTRY_MAX_SIZE}) exceeded. Cannot serialize more functions.`);
      }
      const fnId = crypto.randomUUID();
      functionRegistry.set(fnId, value2);
      trackedFunctions.add(fnId);
      return {
        __fn: fnId,
        __meta: { name: value2.name || "anonymous" }
      };
    }
    if (isTransferable(value2)) {
      if (!transferables.includes(value2)) {
        transferables.push(value2);
      }
      return value2;
    }
    return value2;
  };
  const flattened = stringify(value, replacer);
  const deserialized = parse(flattened);
  return {
    serialized: deserialized,
    transferables
  };
}
function deserializeValue(value, createProxyFunction) {
  const deserialize = (value2) => {
    if (value2 === null || value2 === undefined)
      return value2;
    if (typeof value2 !== "object")
      return value2;
    if (typeof value2 === "object" && value2 !== null && "__fn" in value2 && typeof value2.__fn === "string") {
      const { __fn: fnId } = value2;
      return createProxyFunction(fnId);
    }
    if (Array.isArray(value2)) {
      return value2.map((item) => deserialize(item));
    }
    if (Object.prototype.toString.call(value2) === "[object Object]") {
      const result = {};
      for (const [key, propertyValue] of Object.entries(value2)) {
        result[key] = deserialize(propertyValue);
      }
      return result;
    }
    return value2;
  };
  return deserialize(value);
}

// packages/frame/src/helpers/test-guards.ts
function assertTestEnv() {
  const isTest = typeof globalThis.process !== "undefined" && globalThis.process?.env?.NODE_ENV === "test" || globalThis.__TEST_ENV__ === true;
  if (!isTest) {
    throw new Error("Test-only properties (prefixed with __) can only be accessed in test environment");
  }
}

// packages/frame/src/helpers/function-manager.ts
class FunctionManager {
  #functionRegistry = new Map;
  #pendingFunctionCalls = new Map;
  #trackedFunctions = new Set;
  #postMessage;
  constructor(postMessage) {
    this.#postMessage = postMessage;
  }
  get __functionRegistry() {
    assertTestEnv();
    return this.#functionRegistry;
  }
  get __pendingFunctionCalls() {
    assertTestEnv();
    return this.#pendingFunctionCalls;
  }
  get __trackedFunctions() {
    assertTestEnv();
    return this.#trackedFunctions;
  }
  serialize(value) {
    return serializeValue(value, this.#functionRegistry, this.#trackedFunctions);
  }
  deserialize(value) {
    return deserializeValue(value, (fnId) => this._createProxyFunction(fnId));
  }
  _createProxyFunction(fnId) {
    return (...args) => this._callRemoteFunction(fnId, args);
  }
  _callRemoteFunction(fnId, params) {
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingFunctionCalls.delete(callId);
        reject(new Error(`Function call timeout: ${fnId}`));
      }, FUNCTION_CALL_TIMEOUT);
      this.#pendingFunctionCalls.set(callId, { reject, resolve, timeout });
      const { serialized, transferables } = this.serialize(params);
      this.#postMessage({
        callId,
        fnId,
        params: serialized,
        type: MessageEvent.FUNCTION_CALL
      }, transferables);
    });
  }
  async handleFunctionCall(callId, fnId, params) {
    try {
      const fn = this.#functionRegistry.get(fnId);
      if (!fn) {
        throw new Error(`Function not found: ${fnId}`);
      }
      const deserializedParams = this.deserialize(params);
      const args = Array.isArray(deserializedParams) ? deserializedParams : [deserializedParams];
      const result = await fn(...args);
      const { serialized, transferables } = this.serialize(result);
      this.#postMessage({
        callId,
        result: serialized,
        success: true,
        type: MessageEvent.FUNCTION_RESPONSE
      }, transferables);
    } catch (err) {
      this.#postMessage({
        callId,
        error: err instanceof Error ? err.message : "Unknown error",
        success: false,
        type: MessageEvent.FUNCTION_RESPONSE
      });
    }
  }
  handleFunctionResponse(callId, success, result, error) {
    const pending = this.#pendingFunctionCalls.get(callId);
    if (!pending)
      return;
    clearTimeout(pending.timeout);
    this.#pendingFunctionCalls.delete(callId);
    if (success) {
      const deserializedResult = this.deserialize(result);
      pending.resolve(deserializedResult);
    } else {
      pending.reject(new Error(error || "Unknown error"));
    }
  }
  releaseFunction(fnId) {
    this.#functionRegistry.delete(fnId);
    this.#trackedFunctions.delete(fnId);
  }
  getTrackedFunctions() {
    return Array.from(this.#trackedFunctions);
  }
  cleanup() {
    for (const [_callId, pending] of this.#pendingFunctionCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("FunctionManager destroyed"));
    }
    this.#pendingFunctionCalls.clear();
    this.#functionRegistry.clear();
    this.#trackedFunctions.clear();
  }
}

// packages/frame/src/helpers/logger.ts
function createLogger(prefix) {
  const formattedPrefix = `[${prefix}]`;
  return {
    error: (...args) => {
      console.error(formattedPrefix, ...args);
    },
    log: (...args) => {
      console.log(formattedPrefix, ...args);
    },
    warn: (...args) => {
      console.warn(formattedPrefix, ...args);
    }
  };
}

// packages/frame/src/helpers/message-validators.ts
function isValidMessageStructure(message) {
  return message !== null && message !== undefined && typeof message === "object" && "type" in message;
}
function hasStringType(message) {
  return typeof message.type === "string";
}
function isWhitelistedMessageType(type) {
  return VALID_MESSAGE_TYPES.has(type);
}
function validateMessage(data, logPrefix) {
  if (!isValidMessageStructure(data)) {
    console.warn(`${logPrefix} Invalid message format:`, data);
    return null;
  }
  if (!hasStringType(data)) {
    console.warn(`${logPrefix} Invalid message type (not a string):`, data);
    return null;
  }
  if (!isWhitelistedMessageType(data.type)) {
    console.warn(`${logPrefix} Unknown message type (potential attack): ${data.type}`);
    return null;
  }
  return data;
}

// packages/frame/src/frame.ts
var logger = createLogger("z-frame");

class Frame extends HTMLElement {
  static get observedAttributes() {
    return ["base", "name", "pathname", "sandbox", "src"];
  }
  static ATTR_GETTERS = {
    pathname: (instance) => instance.pathname,
    base: (instance) => instance.base,
    sandbox: (instance) => instance.sandbox,
    name: (_, val) => val,
    src: (_, val) => val
  };
  static RECREATE_ATTRS = new Set(["src", "sandbox"]);
  #iframe;
  #observer;
  #ready = false;
  #origin;
  #port;
  #manager;
  _dynamicMethods = new Map;
  #portMessageHandler;
  _propValues = new Map;
  _definedProps = new Set;
  _registeredFunctions = new Map;
  constructor() {
    super();
    this.#manager = new FunctionManager((message, transferables = []) => {
      this._sendToIframe(message, transferables);
    });
  }
  get name() {
    return this.getAttribute("name");
  }
  get src() {
    return this.getAttribute("src");
  }
  get base() {
    let base = this.getAttribute("base") || `/${this.name}`;
    if (!base.startsWith("/")) {
      base = `/${base}`;
    }
    if (base.length > 1 && base.endsWith("/")) {
      base = base.slice(0, -1);
    }
    return base;
  }
  set base(value) {
    if (value === null) {
      this.removeAttribute("base");
    } else {
      this.setAttribute("base", value);
    }
  }
  get sandbox() {
    return this.getAttribute("sandbox") || "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";
  }
  get pathname() {
    const value = this.getAttribute("pathname");
    if (!value || value.trim() === "") {
      return "/";
    }
    return value.startsWith("/") ? value : `/${value}`;
  }
  set pathname(value) {
    if (value === null) {
      this.removeAttribute("pathname");
    } else {
      this.setAttribute("pathname", value);
    }
  }
  get isReady() {
    return this.#ready;
  }
  get __origin() {
    assertTestEnv();
    return this.#origin;
  }
  get __iframe() {
    assertTestEnv();
    return this.#iframe;
  }
  get __ready() {
    assertTestEnv();
    return this.#ready;
  }
  get __manager() {
    assertTestEnv();
    return this.#manager;
  }
  set __ready(value) {
    assertTestEnv();
    this.#ready = value;
  }
  set __iframe(value) {
    assertTestEnv();
    this.#iframe = value;
  }
  set __origin(value) {
    assertTestEnv();
    this.#origin = value;
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue)
      return;
    if (this.isConnected && this.name && this.src && !this.#iframe) {
      try {
        this.#origin = new URL(this.src).origin;
        this._initialize();
      } catch (error) {
        console.error(`[z-frame] Initialization failed:`, error);
        this._emit("error", {
          message: error instanceof Error ? error.message : "Initialization failed",
          error
        });
      }
    }
    if (this.#iframe && Frame.RECREATE_ATTRS.has(name)) {
      const shouldRecreate = name === "src" && oldValue !== null && oldValue !== newValue || name === "sandbox" && (oldValue !== null && oldValue !== newValue || oldValue === null && newValue !== null);
      if (shouldRecreate) {
        logger.log(`${name} changed - recreating iframe`);
        this._cleanup();
        this.#origin = new URL(this.src).origin;
        this._initialize();
        return;
      }
    }
    if (this.#ready) {
      const getter = Frame.ATTR_GETTERS[name];
      const value = getter ? getter(this, newValue) : newValue;
      this._sendPropUpdate({ [name]: value });
    }
  }
  connectedCallback() {
    queueMicrotask(() => {
      if (this.name && this.src && !this.#iframe) {
        try {
          this.#origin = new URL(this.src).origin;
          this._initialize();
        } catch (error) {
          console.error(`[z-frame] Initialization failed:`, error);
          this._emit("error", {
            message: error instanceof Error ? error.message : "Initialization failed",
            error
          });
        }
      }
    });
  }
  async _initialize() {
    const channel = this._setupIframeAndChannel();
    await this._waitForIframeLoad();
    const props = this._collectAllProps();
    this._sendInitMessage(channel, props);
    this._setupAttributeObserver();
  }
  _setupIframeAndChannel() {
    this.#iframe = document.createElement("iframe");
    const src = this.src;
    const pathname = this.pathname;
    const normalizedSrc = src.endsWith("/") ? src.slice(0, -1) : src;
    this.#iframe.src = normalizedSrc + pathname;
    this.#iframe.style.cssText = "border:none;display:block;height:100%;width:100%;";
    this.#iframe.setAttribute("sandbox", this.sandbox);
    const channel = new MessageChannel;
    this.#port = channel.port1;
    this.#portMessageHandler = (event) => {
      try {
        this._handleMessageFromIframe(event.data);
      } catch (error) {
        logger.error("Error handling message from iframe:", error);
        this._emit("error", { message: "Message handler error", error });
      }
    };
    this.#port.onmessage = this.#portMessageHandler;
    this.appendChild(this.#iframe);
    return channel;
  }
  _waitForIframeLoad() {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Iframe load timeout after 10s: ${this.src}`));
      }, 1e4);
      const handler = (event) => {
        cleanup();
        if (event.type === "error") {
          reject(new Error(`Failed to load iframe: ${this.src}`));
        } else {
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.#iframe.removeEventListener("load", handler);
        this.#iframe.removeEventListener("error", handler);
      };
      this.#iframe.addEventListener("load", handler, { once: true });
      this.#iframe.addEventListener("error", handler, { once: true });
    }).catch((error) => {
      logger.error("Iframe initialization failed:", error);
      this._emit("error", { message: "Iframe load failed", error });
      throw error;
    });
  }
  _collectAllProps() {
    const props = {
      base: this.base,
      name: this.name,
      pathname: this.pathname,
      src: this.src,
      sandbox: this.sandbox
    };
    const observedAttrs = Frame.observedAttributes;
    for (let i = 0;i < this.attributes.length; i++) {
      const attr = this.attributes[i];
      if (!observedAttrs.includes(attr.name)) {
        props[attr.name] = attr.value;
      }
    }
    for (const [key, value] of this._propValues.entries()) {
      if (value !== undefined) {
        props[key] = value;
      }
    }
    return props;
  }
  _sendInitMessage(channel, props) {
    const { serialized, transferables } = this.#manager.serialize(props);
    const contentWindow = this.#iframe.contentWindow;
    if (!contentWindow) {
      throw new Error("[z-frame] Iframe contentWindow is not accessible");
    }
    contentWindow.postMessage({
      payload: serialized,
      type: MessageEvent.INIT
    }, this.#origin, [channel.port2, ...transferables]);
  }
  _sendPropUpdate(updates) {
    if (!this.#ready)
      return;
    const { serialized, transferables } = this.#manager.serialize(updates);
    this._sendToIframe({
      type: MessageEvent.PROPS_UPDATE,
      payload: serialized
    }, transferables);
  }
  _setupAttributeObserver() {
    const observedAttrsSet = new Set(Frame.observedAttributes);
    this.#observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        const attrName = mutation.attributeName;
        if (attrName && !observedAttrsSet.has(attrName)) {
          const value = this.getAttribute(attrName);
          const { serialized, transferables } = this.#manager.serialize(value);
          this._sendToIframe({
            type: MessageEvent.PROPS_UPDATE,
            payload: { [attrName]: serialized }
          }, transferables);
        }
      });
    });
    this.#observer.observe(this, { attributes: true });
  }
  _handleMessageFromIframe(data) {
    const message = validateMessage(data, "[z-frame]");
    if (!message) {
      return;
    }
    const { type } = message;
    switch (type) {
      case MessageEvent.READY:
        this.#ready = true;
        this._dispatchLocalEvent("ready", { name: this.name });
        break;
      case MessageEvent.CUSTOM_EVENT: {
        const customMsg = message;
        const payload = customMsg.payload;
        if (!payload?.name || typeof payload.name !== "string") {
          logger.warn("Invalid CUSTOM_EVENT message:", message);
          return;
        }
        const deserializedData = this.#manager.deserialize(payload.data);
        this._dispatchLocalEvent(payload.name, deserializedData);
        break;
      }
      case MessageEvent.FUNCTION_CALL: {
        const callMsg = message;
        if (!callMsg.callId || !callMsg.fnId) {
          logger.warn("Invalid FUNCTION_CALL message:", message);
          return;
        }
        this.#manager.handleFunctionCall(callMsg.callId, callMsg.fnId, callMsg.params);
        break;
      }
      case MessageEvent.FUNCTION_RESPONSE: {
        const respMsg = message;
        const { callId, success, result, error: errorResult } = respMsg;
        if (!callId || typeof success !== "boolean") {
          logger.warn("Invalid FUNCTION_RESPONSE message:", message);
          return;
        }
        this.#manager.handleFunctionResponse(callId, success, result, errorResult);
        break;
      }
      case MessageEvent.FUNCTION_RELEASE: {
        const releaseMsg = message;
        if (!releaseMsg.fnId) {
          logger.warn("Invalid FUNCTION_RELEASE message:", message);
          return;
        }
        this.#manager.releaseFunction(releaseMsg.fnId);
        break;
      }
      case MessageEvent.FUNCTION_RELEASE_BATCH: {
        const batchMsg = message;
        if (!Array.isArray(batchMsg.fnIds)) {
          logger.warn("Invalid FUNCTION_RELEASE_BATCH message:", message);
          return;
        }
        for (const fnId of batchMsg.fnIds) {
          this.#manager.releaseFunction(fnId);
        }
        break;
      }
      default:
        console.warn(`[z-frame] Unknown message type: ${type}`);
    }
  }
  emit(eventName, data) {
    if (!eventName || !/^[a-zA-Z0-9_:.-]+$/.test(eventName)) {
      logger.error("Invalid event name:", eventName);
      return;
    }
    this._emitToChild(eventName, data);
  }
  _emitToChild(eventName, data) {
    if (!this.#port) {
      logger.warn("MessagePort not ready, cannot emit event");
      return;
    }
    const { serialized, transferables } = this.#manager.serialize(data);
    this._sendToIframe({
      name: eventName,
      data: serialized,
      type: MessageEvent.EVENT
    }, transferables);
  }
  _emit(name, detail, options = {}) {
    this.dispatchEvent(new CustomEvent(name, {
      bubbles: options.bubbles ?? true,
      composed: options.composed ?? true,
      detail
    }));
  }
  _dispatchLocalEvent(name, detail) {
    if (!name || !/^[a-zA-Z0-9_:.-]+$/.test(name)) {
      logger.warn("Invalid event name:", name);
      return;
    }
    if (name === "register" && detail && typeof detail === "object") {
      for (const [fnName, fn] of Object.entries(detail)) {
        if (typeof fn === "function") {
          this._registeredFunctions.set(fnName, fn);
        }
      }
    }
    if (name === "unregister" && detail && typeof detail === "object") {
      const { functions } = detail;
      if (Array.isArray(functions)) {
        for (const fnName of functions) {
          this._registeredFunctions.delete(fnName);
        }
      }
    }
    this._emit(name, detail);
    const handlerName = name.replace(/[:.-]/g, "");
    if (Object.hasOwn(this, handlerName)) {
      const handler = Reflect.get(this, handlerName);
      if (typeof handler === "function") {
        handler.call(this, detail);
      }
    }
  }
  _sendToIframe(message, transferables = []) {
    if (!this.#port) {
      logger.error("MessagePort not ready");
      return false;
    }
    try {
      this.#port.postMessage(message, transferables);
      return true;
    } catch (error) {
      logger.error("Failed to send message:", error);
      this._emit("message-send-failed", {
        error: error instanceof Error ? error.message : String(error),
        message,
        transferablesCount: transferables.length
      });
      return false;
    }
  }
  _cleanup() {
    this.#observer?.disconnect();
    this.#observer = undefined;
    const functionIds = Array.from(this.#manager?.getTrackedFunctions() || []);
    if (functionIds.length > 0) {
      this._sendToIframe({
        fnIds: functionIds,
        type: MessageEvent.FUNCTION_RELEASE_BATCH
      });
    }
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
    }
    this.#portMessageHandler = undefined;
    this.#manager?.cleanup();
    this._dynamicMethods?.clear();
    this._propValues?.clear();
    this._definedProps?.clear();
    this._registeredFunctions?.clear();
    this.#iframe?.remove();
    this.#ready = false;
  }
  disconnectedCallback() {
    this._cleanup();
  }
}
var setupPrototypeProxy = () => {
  const proto = Frame.prototype;
  const protoOfProto = Object.getPrototypeOf(proto);
  const proxiedProto = new Proxy(protoOfProto, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined)
        return value;
      if (typeof prop === "string" && /^[a-z][a-zA-Z0-9]*$/.test(prop)) {
        const instance = receiver;
        if (instance._dynamicMethods?.has(prop)) {
          return instance._dynamicMethods.get(prop);
        }
        const method = (...args) => {
          const fn = instance._registeredFunctions?.get(prop);
          if (fn) {
            return Promise.resolve(fn(...args));
          }
          return Promise.reject(new Error(`Function '${prop}' not registered by child frame '${instance.name}'`));
        };
        instance._dynamicMethods?.set(prop, method);
        return method;
      }
      return;
    },
    set(target, prop, value, receiver) {
      if (typeof prop !== "string") {
        return Reflect.set(target, prop, value, receiver);
      }
      if (prop.startsWith("_")) {
        return Reflect.set(target, prop, value, receiver);
      }
      const instance = receiver;
      if (Frame.observedAttributes.includes(prop) || prop in HTMLElement.prototype || prop in Frame.prototype) {
        return Reflect.set(target, prop, value, receiver);
      }
      if (!instance._definedProps.has(prop)) {
        instance._definedProps.add(prop);
        Object.defineProperty(receiver, prop, {
          configurable: true,
          enumerable: true,
          get: () => instance._propValues.get(prop),
          set: (v) => {
            instance._propValues.set(prop, v);
            instance._sendPropUpdate({ [prop]: v });
          }
        });
      }
      instance._propValues.set(prop, value);
      instance._sendPropUpdate({ [prop]: value });
      return true;
    }
  });
  Object.setPrototypeOf(proto, proxiedProto);
};
setupPrototypeProxy();
if (!customElements.get("z-frame")) {
  customElements.define("z-frame", Frame);
} else {
  logger.warn("z-frame already registered");
}
export {
  Frame
};
