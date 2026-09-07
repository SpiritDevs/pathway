import type { BusinessContactPage } from "@spiritdevs/contracts/businessTools";

export interface ContactPageHistory {
  base: BusinessContactPage;
  contacts: BusinessContactPage["contacts"];
  cursor: string | null;
  isDone: boolean;
}
export interface ContactPaginationState {
  generation: number;
  history: ContactPageHistory | null;
  request: { base: BusinessContactPage; loading: boolean; error?: string } | null;
}
export const initialContactPagination: ContactPaginationState = {
  generation: 0,
  history: null,
  request: null,
};
type Action =
  | { type: "invalidate" }
  | { type: "remove"; base: BusinessContactPage | undefined; id: string }
  | { type: "request"; generation: number; base: BusinessContactPage }
  | { type: "loaded"; generation: number; history: ContactPageHistory }
  | { type: "failed"; generation: number; base: BusinessContactPage; error: string };

export function contactPaginationReducer(
  state: ContactPaginationState,
  action: Action,
): ContactPaginationState {
  if (action.type === "invalidate")
    return { generation: state.generation + 1, history: null, request: null };
  if (action.type === "remove") {
    if (!state.history || state.history.base !== action.base) return state;
    return {
      ...state,
      history: {
        ...state.history,
        contacts: state.history.contacts.filter((row) => row.id !== action.id),
      },
    };
  }
  if (action.generation !== state.generation) return state;
  switch (action.type) {
    case "request":
      return { ...state, request: { base: action.base, loading: true } };
    case "loaded":
      return {
        ...state,
        history: action.history,
        request: { base: action.history.base, loading: false },
      };
    case "failed":
      return { ...state, request: { base: action.base, loading: false, error: action.error } };
  }
}
