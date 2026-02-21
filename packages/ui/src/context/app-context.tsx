import { createContext, useContext, type ParentProps } from "solid-js";
import type { AppState } from "../composables/create-app-state.ts";

const AppContext = createContext<AppState>();

export function AppProvider(props: ParentProps<{ state: AppState }>) {
  return (
    <AppContext.Provider value={props.state}>
      {props.children}
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
