import { createEffect, createSignal, type Accessor, type Signal } from "solid-js";
import { effect } from "@dnd-kit/state";

/**
 * Mirrors a `@dnd-kit/state` value into a Solid accessor.
 *
 * `@dnd-kit/dom` keeps entity and operation state in preact signals
 * (`@dnd-kit/state` re-exports `effect` from `@preact/signals-core`, see
 * `@dnd-kit/state/dist/index.d.ts:1-2`), which Solid cannot track. A preact
 * `effect` — created inside Solid's effect phase, disposed with the owner —
 * re-reads the value on every change and writes it into a Solid signal, so
 * JSX reading the accessor re-runs.
 *
 * `ownedWrite` opts the signal out of Solid 2's
 * `REACTIVE_WRITE_IN_OWNED_SCOPE` guard: this write happens by design inside
 * an owned scope (the Solid effect that owns the subscription), not from a
 * component body or a reactive computation.
 */
export function fromDnd<T>(
  read: () => T,
  equals?: false | ((prev: T, next: T) => boolean),
): Accessor<T> {
  // Bridged values are booleans, status strings or entity objects — never
  // functions — but `createSignal` reserves a function argument for its
  // writable-memo overload, hence the cast.
  const [value, setValue] = createSignal<T>(read() as Exclude<T, Function>, {
    ownedWrite: true,
    equals,
  }) as Signal<T>;
  createEffect(
    // No Solid dependency: subscribe once, in the effect phase, so the
    // subscription has an owner to be disposed with.
    () => undefined,
    () => {
      const dispose = effect(() => {
        setValue(() => read());
      });
      return () => dispose();
    },
  );
  return value;
}
