import { TREATMENT_NAMES, treatmentByName } from "./treatment";

// CHOOSING A LOOK, AS A STATE MACHINE.
//
// The rule that matters is not about pixels: PREVIEW MUST NEVER INTENTIONALLY
// SHOW A TREATMENT THAT IS NOT THE STORED ONE. A professional looking at Preview
// is deciding what to send; if a save fails and Preview keeps the new look, they
// are approving something the packet does not carry. So a failed save rolls the
// page back to whatever is actually stored, and says so.
//
// It lives here, not in the component, because the interesting cases are the
// ones a rendered click cannot easily produce: a response arriving after the
// request it belongs to was abandoned, two saves resolving out of order, a
// failure landing on a state that has already moved on. Those are conditions on
// a value, and a value can be tested.

export interface SelectionState {
  /** The treatment stored on the packet. Whether anyone has been sent a link to
   *  it is not this module's business, and it never claims to know. */
  persisted: string;
  /** What Preview is rendering. Equal to `persisted` except while a save is
   *  in flight — and never intentionally different once one settles. */
  shown: string;
  /** The treatment being saved, or null when nothing is in flight. */
  saving: string | null;
  /** Monotonic request id. A reply carrying an older one is a reply to a
   *  question nobody is still asking, and is dropped rather than applied. */
  seq: number;
  /** A sentence naming which treatment failed and what Preview went back to,
   *  or null. It states only what this module can know for certain. */
  error: string | null;
}

export interface SaveRequest {
  seq: number;
  name: string;
}

export function initialSelection(persisted?: string | null): SelectionState {
  // Whatever the row holds, the page renders a treatment that exists.
  const name = treatmentByName(persisted).name;
  return { persisted: name, shown: name, saving: null, seq: 0, error: null };
}

/** A click. Returns the next state, and the request to send — or null when
 *  there is nothing to send. */
export function chooseTreatment(
  state: SelectionState,
  name: string,
): { state: SelectionState; request: SaveRequest | null } {
  // A NAME THAT IS NOT A TREATMENT NEVER BECOMES ONE. Nothing in the UI can
  // produce this; it is here so that if something ever does, the page does not
  // start rendering a look that has no definition.
  if (!TREATMENT_NAMES.includes(name)) return { state, request: null };

  // ONE SAVE AT A TIME. The cards are disabled while one is in flight, but the
  // rule belongs to the machine rather than to an attribute: a keyboard, a
  // double event or a future caller must all meet the same answer.
  if (state.saving !== null) return { state, request: null };

  // Choosing what is already saved is not a save. It does clear a stale error,
  // because the professional has just told us they are content with this one.
  if (name === state.persisted && state.shown === state.persisted) {
    return { state: { ...state, error: null }, request: null };
  }

  const seq = state.seq + 1;
  return {
    // The look changes NOW. Waiting for a round trip to redraw would make
    // comparing three treatments feel like using a form.
    state: { ...state, shown: name, saving: name, seq, error: null },
    request: { seq, name },
  };
}

/** The save landed. The new look becomes what the packet stores. */
export function saveSucceeded(state: SelectionState, seq: number): SelectionState {
  if (seq !== state.seq || state.saving === null) return state;
  return { ...state, persisted: state.saving, shown: state.saving, saving: null, error: null };
}

/** The save did not land. Preview goes back to the last persisted treatment.
 *
 *  THE MESSAGE SAYS ONLY WHAT IS CERTAIN. It does not diagnose a cause — a
 *  failed request could be a network drop, a rejected body, a server error or a
 *  timeout, and naming the wrong one sends a professional looking in the wrong
 *  place. It does not mention a recipient either: this module has no idea
 *  whether the packet is published, and telling someone what "their client
 *  sees" about an unpublished draft is simply false. Which treatment failed,
 *  and what Preview is showing now — both always true. */
export function saveFailed(state: SelectionState, seq: number): SelectionState {
  if (seq !== state.seq || state.saving === null) return state;
  const attempted = treatmentByName(state.saving).label;
  const live = treatmentByName(state.persisted).label;
  return {
    ...state,
    shown: state.persisted,
    saving: null,
    error: `Couldn't save ${attempted}. Preview is back to ${live}.`,
  };
}

/** Whether the cards should refuse clicks. One save at a time. */
export const isBusy = (state: SelectionState) => state.saving !== null;
