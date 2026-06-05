import type { EditorView } from "@codemirror/view";

let _view: EditorView | null = null;

export function registerView(view: EditorView): void {
  _view = view;
}

export function unregisterView(): void {
  _view = null;
}

export function insert(text: string): void {
  const v = _view;
  if (!v) return;
  v.dispatch(v.state.replaceSelection(text));
  v.focus();
}

export function replaceRange(from: number, to: number, text: string): void {
  const v = _view;
  if (!v) return;
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  v.focus();
}

export function getCursorPos(): number | null {
  return _view?.state.selection.main.head ?? null;
}

export function getSelectionRange(): { from: number; to: number } | null {
  const v = _view;
  if (!v) return null;
  const r = v.state.selection.main;
  return r.from === r.to ? null : { from: r.from, to: r.to };
}

export function getSelectionText(): string {
  const v = _view;
  if (!v) return "";
  const r = v.state.selection.main;
  return v.state.sliceDoc(r.from, r.to);
}

export function getDocText(): string | null {
  return _view?.state.doc.toString() ?? null;
}

export function setSelection(from: number, to: number): void {
  const v = _view;
  if (!v) return;
  v.dispatch({
    selection: { anchor: from, head: to },
    scrollIntoView: true,
  });
  v.focus();
}

export function collapseSelectionToHead(): void {
  const v = _view;
  if (!v) return;
  const head = v.state.selection.main.head;
  v.dispatch({ selection: { anchor: head, head } });
}
