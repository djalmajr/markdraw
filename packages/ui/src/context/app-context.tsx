import { createContext, useContext, type ParentProps } from "solid-js";
import type { AppState } from "../composables/create-app-state.ts";

const AppContext = createContext<AppState>();

export function AppProvider(props: ParentProps<{ state: AppState }>) {
  return (
    <AppContext value={props.state}>
      {props.children}
    </AppContext>
  );
}

export function useApp(): AppState {
  // Solid 2: a default-less context is typed `Context<T>` and useContext throws
  // ContextNotFoundError itself, so the narrowing wrapper is no longer needed.
  return useContext(AppContext);
}
